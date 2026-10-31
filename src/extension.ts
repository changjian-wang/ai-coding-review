import * as vscode from 'vscode';
import { setGhTokenResolver } from './gh/ghClient';
import { initAccountResolver, resolveGhTokenForRepo } from './gh/accountResolver';
import {
  ReviewSession,
  type ReviewInvalidation,
} from './review/reviewSession';
import { WorkspaceStateReviewStore, type Annotation, type ReviewConclusion } from './review/reviewStore';
import { ReviewCoordinator, type WorkflowFileResult } from './review/reviewCoordinator';
import {
  contentSignature, currentRequirements, includeReviewRequirement, materialText, requirementsConfirmed,
  reviseReviewRequirement, workflowResultKey, WorkflowError, type ReviewVerdict, type ReviewWorkflowState,
} from './review/reviewWorkflow';
import { decodeRequirementSource } from './review/requirementSources';
import { isBinaryReviewPath, repositoryEvidenceStamp, safeRepositoryUri } from './review/reviewSourceAccess';
import * as nodePath from 'node:path';
import { homedir } from 'node:os';
import { pickModel, listModels, type PickedModel } from './ai/modelPicker';
import { ModelProvider } from './ai/modelProvider';
import {
  analyzeFile,
  analyzeGlobal,
  analyzeRootedRepository,
  DEFAULT_REPOSITORY_CONTEXT_TOKEN_BUDGET,
  fitRepositoryContextToTokenBudget,
  finalizeFileAnalysis,
  finalizeRootedRepositoryAnalysis,
  generateFixProposals,
  translateSelection,
  translateMarkdown,
  translateTextBatch,
  explainCode,
  draftReviewComment,
  AnalysisError,
  setTokenUsageSink,
  verifyRootedRepositoryFindings,
  type GlobalContextFile,
} from './ai/analyzer';
import {
  findingContentSignatures,
  globalFixSpotSignatures,
  isActionableFinding,
  type FileAnalysisSummary,
  type Finding,
  type GlobalReport,
} from './ai/types';
import {
  pickScope,
  tryLoadPreferredScope,
  type PickedScope,
  type PreferredScopeKind,
} from './scope/scopePicker';
import { BranchComparisonScope, BranchSnapshotScope, FileSystemScope, PrByNumberScope } from './scope/scopes';
import { currentBranch, decodeReviewText, findReviewReferenceFiles, headSha, listBranches, readFileAtRef, readReviewFileAtRef, reviewCommentRanges, switchBranchTo } from './scope/gitClient';
import type { ReviewFile, ReviewScope, ReviewSet } from './scope/types';
import { getPrByNumber, submitPrReviewWithComments } from './gh/ghClient';
import { GlobalReportPanel } from './ui/globalReportPanel';
import { buildReviewReportMarkdown, composeReviewReport, type ReportData } from './ui/reviewReport';
import { WorkbenchPanel, withWorkbenchProgress, type WorkbenchProgressReporter, type WorkbenchState, type WorkbenchFile, type FindingDispositionKind } from './ui/workbenchPanel';
import { DocumentPanel, sourceRenderPlan, type DocDiffLine, type DocModel } from './ui/documentPanel';
import type { CenterDocument, CenterFinding, ReviewCenterMessage, ReviewCenterState } from './ui/reviewCenter';
import { FixProposalPanel } from './ui/fixProposalPanel';
import { renderDocument, renderRequirementMarkdown, type DocumentRender } from './ui/documentRenderer';
import { transientInfo, transientWarning } from './ui/toast';
import {
  registerIgnoreReasonPasteCommand,
  showIgnoreReasonInput,
} from './ui/ignoreReasonInput';
import { fmt, m, onLanguageChange, resolveLanguage, type Language } from './i18n';
import { buildFullFileDiff } from './review/fullFileDiff';
import {
  collectRelatedRepositoryContext,
  contentFingerprint,
  defaultRepositoryEvidenceServices,
  rootContextComplete,
  RELATED_CONTEXT_LIMITS,
  validateRepositoryAnalysisContext,
} from './review/repositoryEvidence';

let session: ReviewSession;
let reviewCoordinator: ReviewCoordinator;
let centerDocument: CenterDocument | undefined;
let centerDocumentLoading = false;
let centerSubmitting = false;
let centerEpoch = 0;
let centerStateCache: ReviewCenterState | undefined;
let centerStateKey = '';
const models = new ModelProvider();
let workbenchSelected: string | undefined;
/** Current git branch label for the active review, shown in the workbench HUD. */
let currentBranchLabel: string | undefined;
let workbenchFilesVersion = -1;
let workbenchFilesCache: WorkbenchFile[] = [];
const workbenchFileIndex = new Map<string, number>();

/** Caches the last model picks so applyDynMenu can recover the live handle by id. */
let dynModelCache = new Map<string, PickedModel>();
/** Guards against re-entrant scope picking (rapid clicks on "switch scope"). */
let scopePickInFlight = false;
/** Prevents repeated launcher clicks from starting parallel project loads. */
let workbenchOpenInFlight = false;
/** Temporary loading panel shown before the full workbench is ready. */
let openingWorkbenchPanel: vscode.WebviewPanel | undefined;
/** Monotonic token for file-open requests; lets a newer click cancel a slower in-flight open. */
let openFileGeneration = 0;
/** Monotonic token preventing an older async fix-panel open from replacing a newer selection. */
let fixProposalOpenGeneration = 0;
/** Cache of rendered (highlighted) file content, keyed by relative path. */
const docRenderCache = new Map<string, DocumentRender>();
/** Cached full-file diff rows; invalidated whenever the live head file changes. */
const docDiffCache = new Map<string, DocDiffLine[]>();
/** Base snapshots are immutable for a ReviewSet, so each old file is read once. */
const baseTextCache = new Map<string, string | null>();
/** Highlighted base snapshots, keyed by base SHA + path for instant revisits. */
const baseRenderCache = new Map<string, DocumentRender>();
/** Most recently applied Copilot fix per finding: enables one-click revert from any UI. */
const appliedFixes = new Map<string, { oldText: string; newText: string }>();
/** Preferred default cwd for the next scope pick (set by openInNewWindow). */
let preferredDefaultCwd: string | undefined;
/** True once the 3:7 editor layout has been applied for the current review. */
let layoutAppliedForCurrentReview = false;
/** Relative paths with an in-flight single-file analysis, used to de-dupe concurrent runs. */
const analyzingPaths = new Set<string>();
/** Cancellation sources for file analysis, including repository evidence verification. */
const fileAnalysisCts = new Map<string, vscode.CancellationTokenSource>();
/** Related paths discovered by currently-running rooted analyses. */
const inFlightAnalysisDependencies = new Map<string, Set<string>>();
/** Prevents duplicate global analysis calls for the same active review. */
let globalAnalysisInFlight = false;
/** Cancellation source for the in-flight global analysis, if any. */
let globalAnalysisCts: vscode.CancellationTokenSource | undefined;
/** In-flight whole-document (bilingual) translation, so it can be de-duped per
 *  file and cancelled when the reviewer switches to another file. */
let activeDocTranslation: { path: string; cts: vscode.CancellationTokenSource } | undefined;
/** File edits owned by FixProposalPanel; workspace change events are handled after apply completes. */
const internalReviewEdits = new Map<string, number>();
const manualReloadTimers = new Map<string, ReturnType<typeof setTimeout>>();

function reviewEditKey(uri: vscode.Uri): string {
  return uri.fsPath.toLowerCase();
}

function canChangeReview(): boolean {
  if (!centerSubmitting && !scopePickInFlight) return true;
  centerNotice(centerSubmitting ? m().reviewCenter.submitting : m().reviewCenter.loadingTarget, true);
  return false;
}

function annotationOwner(path: string): () => boolean {
  const snapshot = session.snapshot;
  const lifecycle = session.reviewLifecycleVersion;
  const revision = docRenderCache.get(path)?.revision;
  return () => lifecycle === session.reviewLifecycleVersion && snapshot === session.snapshot && revision === docRenderCache.get(path)?.revision;
}

function findingOwner(path: string, id: string): () => boolean {
  const lifecycle = session.reviewLifecycleVersion;
  const run = session.workflow?.run.id;
  const finding = session.findings(path).find((item) => item.id === id);
  return () => lifecycle === session.reviewLifecycleVersion && session.workflow?.run.id === run
    && session.findings(path).find((item) => item.id === id) === finding
    && (!session.workflow || session.workflowResultsCurrent);
}

function beginInternalReviewEdit(uri: vscode.Uri): void {
  const key = reviewEditKey(uri);
  internalReviewEdits.set(key, (internalReviewEdits.get(key) ?? 0) + 1);
}

function endInternalReviewEdit(uri: vscode.Uri): void {
  const key = reviewEditKey(uri);
  const next = (internalReviewEdits.get(key) ?? 1) - 1;
  if (next > 0) {
    internalReviewEdits.set(key, next);
  } else {
    internalReviewEdits.delete(key);
  }
}

function isReviewPath(relPath: string): boolean {
  return session.hasReviewFile(relPath);
}

function ensureReviewPath(relPath: string, action: string): boolean {
  if (isReviewPath(relPath)) {
    return true;
  }
  void vscode.window.showWarningMessage(m().review.notInScope(relPath, action));
  return false;
}

function closeScopeBoundPanels(): void {
  for (const timer of manualReloadTimers.values()) {
    clearTimeout(timer);
  }
  manualReloadTimers.clear();
  internalReviewEdits.clear();
  for (const cts of fileAnalysisCts.values()) {
    cts.cancel();
    cts.dispose();
  }
  fileAnalysisCts.clear();
  inFlightAnalysisDependencies.clear();
  analyzingPaths.clear();
  if (globalAnalysisCts) {
    globalAnalysisCts.cancel();
    globalAnalysisCts.dispose();
    globalAnalysisCts = undefined;
  }
  globalAnalysisInFlight = false;
  DocumentPanel.closeIfOpen();
  fixProposalOpenGeneration += 1;
  FixProposalPanel.closeIfOpen();
  GlobalReportPanel.closeIfOpen();
}

function reflectReviewInvalidation(
  invalidation: ReviewInvalidation,
  sourcePath: string,
  closeFixPanel: boolean,
): void {
  if (!invalidation.changed) {
    return;
  }
  if (closeFixPanel) {
    fixProposalOpenGeneration += 1;
    FixProposalPanel.closeIfOpen();
  }
  GlobalReportPanel.closeIfOpen();
  const currentPath = DocumentPanel.currentPath;
  if (currentPath && invalidation.removedFiles.includes(currentPath)) {
    DocumentPanel.closeIfOpen();
  } else if (
    currentPath
    && currentPath !== sourcePath
    && invalidation.affectedFiles.includes(currentPath)
  ) {
    void refreshDocPanel(currentPath);
  }
  if (workbenchSelected && invalidation.removedFiles.includes(workbenchSelected)) {
    workbenchSelected = undefined;
  }
}

function handleReviewDocumentChange(event: vscode.TextDocumentChangeEvent): void {
  if (
    event.contentChanges.length === 0
    || event.document.uri.scheme !== 'file'
    || internalReviewEdits.has(reviewEditKey(event.document.uri))
  ) {
    return;
  }
  const rel = session.relPathInRepo(event.document.uri);
  if (rel && activeDocTranslation?.path === rel) activeDocTranslation.cts.cancel();
  const inFlightDependency = !!rel && [...inFlightAnalysisDependencies.values()]
    .some((dependencies) => dependencies.has(rel));
  if (
    !rel
    || (
      !session.hasReviewFile(rel)
      && !session.hasAnalysisDependency(rel)
      && !inFlightDependency
    )
  ) {
    return;
  }
  for (const cts of fileAnalysisCts.values()) {
    cts.cancel();
  }
  globalAnalysisCts?.cancel();
  reviewCoordinator?.interruptReview();
  const invalidation = session.invalidateAfterFileChange(rel);
  reflectReviewInvalidation(invalidation, rel, true);
  if (!session.hasReviewFile(rel)) {
    return;
  }
  docRenderCache.delete(rel);
  docDiffCache.delete(rel);
  const pending = manualReloadTimers.get(rel);
  if (pending) {
    clearTimeout(pending);
  }
  manualReloadTimers.set(rel, setTimeout(() => {
    manualReloadTimers.delete(rel);
    void reloadDocPanel(rel);
  }, 250));
}

function reviewFileStatus(relPath: string): string | undefined {
  return session.reviewFile(relPath)?.status;
}

function isDeletedReviewFile(relPath: string): boolean {
  return reviewFileStatus(relPath) === 'deleted';
}

function fixKey(rel: string, findingId: string): string {
  const findings = session.findings(rel);
  const index = findings.findIndex((finding) => finding.id === findingId);
  const findingRef = index >= 0
    ? findingContentSignatures(findings)[index]
    : findingId;
  const repository = session.workflow?.repositoryKey ?? hashString(
    (session.getCwd() ?? session.getRepoName()).replaceAll('\\', '/').toLowerCase(),
  );
  return `${repository}::${rel}::${findingRef}`;
}

function legacyFixKey(rel: string, findingId: string): string {
  return `${rel}::${findingId}`;
}

function getAppliedFix(
  rel: string,
  findingId: string,
): { oldText: string; newText: string } | undefined {
  const key = fixKey(rel, findingId);
  const current = appliedFixes.get(key);
  if (current) {
    return current;
  }
  if (session.workflow) return undefined;
  const legacyKey = legacyFixKey(rel, findingId);
  const legacy = appliedFixes.get(legacyKey);
  if (legacy) {
    appliedFixes.set(key, legacy);
    appliedFixes.delete(legacyKey);
    flushAppliedFixes();
  }
  return legacy;
}

function deleteAppliedFixFor(rel: string, findingId: string): void {
  deleteAppliedFixKeys(fixKey(rel, findingId), legacyFixKey(rel, findingId));
}

function deleteAppliedFixKeys(key: string, legacyKey?: string): void {
  appliedFixes.delete(key);
  if (legacyKey) {
    appliedFixes.delete(legacyKey);
  }
  flushAppliedFixes();
}

/** Memento key for persisted applied-fix snapshots (enables locate-follow + revert across reloads). */
const APPLIED_FIXES_MEMENTO_KEY = 'codereview.appliedFixes.v1';
/** Workspace memento bound in activate(); backs the in-memory appliedFixes map. */
let appliedFixesMemento: vscode.Memento | undefined;

/** Memento key for the last folder loaded as a review (enables auto-restore after a window reload). */
const LAST_REVIEW_FOLDER_KEY = 'codereview.lastReviewFolder.v1';
/**
 * Memento key for the last *scope* the user actually reviewed. Unlike
 * LAST_REVIEW_FOLDER_KEY (which only remembers the project folder), this records
 * a narrowed file-system selection so auto-restore can rebuild the exact subset
 * — and thus hit the same persisted snapshot — after an extension/host restart.
 */
const LAST_SCOPE_KEY = 'codereview.lastScope.v1';
/** Persisted descriptor of the last reviewed scope. */
type PersistedScope =
  // `folder` is retained for descriptors written by versions before 0.4.2.
  | { kind: 'folder'; cwd: string }
  | { kind: 'preferred'; cwd: string }
  | { kind: 'files'; cwd: string; relPaths: string[] }
  | { kind: 'branch'; cwd: string; baseRef?: string }
  | { kind: 'pr'; cwd: string; number: number; reviewSet?: ReviewSet };
/** Workspace memento bound in activate(); records the last review folder for restore. */
let workspaceMemento: vscode.Memento | undefined;

/** Memento key for localized text cache (stable key -> translated text). */
const LOCALIZED_TEXT_MEMENTO_KEY = 'codereview.localizedText.v1';
/** In-memory mirror of localized text cache; lazily hydrated from workspace state. */
let localizedTextCache: Record<string, string> | undefined;
/** De-dupes per-file localization jobs: `${relPath}::${lang}`. */
const inFlightDocLocalization = new Set<string>();
/** De-dupes global-report localization jobs: `${scopeKey}::${lang}`. */
const inFlightGlobalLocalization = new Set<string>();
/** Single cache key prefix for pending-comment localization jobs. */
const pendingCommentLocalizationKey = 'pending-comments';

function ensureLocalizedTextCache(): Record<string, string> {
  if (!localizedTextCache) {
    localizedTextCache = workspaceMemento?.get<Record<string, string>>(LOCALIZED_TEXT_MEMENTO_KEY) ?? {};
  }
  return localizedTextCache;
}

function flushLocalizedTextCache(): void {
  if (!workspaceMemento || !localizedTextCache) {
    return;
  }
  void workspaceMemento.update(LOCALIZED_TEXT_MEMENTO_KEY, localizedTextCache);
}

function detectTextLanguage(text: string): Language | undefined {
  const t = text.trim();
  if (!t) {
    return undefined;
  }
  const letters = (t.match(/[A-Za-z]/g) ?? []).length;
  const han = (t.match(/[\u3400-\u9FFF]/g) ?? []).length;
  if (han >= 2 && han > letters * 0.2) {
    return 'zh-CN';
  }
  if (letters >= 4 && letters >= han * 2) {
    return 'en';
  }
  return undefined;
}

function shouldTranslateText(text: string, target: Language): boolean {
  const src = detectTextLanguage(text);
  return !!src && src !== target;
}

function localizedText(cacheKey: string, fallback: string): string {
  return ensureLocalizedTextCache()[cacheKey] ?? fallback;
}

function reviewScopeKey(): string {
  const rs = session.reviewSet;
  if (!rs) {
    return `${session.getRepoName()}::none::none`;
  }
  return `${session.getRepoName()}::${rs.scopeId}::${rs.headSha}`;
}

function findingTextCacheKey(
  relPath: string,
  findingId: string,
  field: 'title' | 'detail' | 'suggestion' | 'verification',
  target: Language,
  text: string,
): string {
  return [
    'finding',
    session.getRepoName(),
    relPath,
    findingId,
    field,
    target,
    hashString(text),
  ].join('::');
}

function annotationTextCacheKey(
  relPath: string,
  annotationId: string,
  target: Language,
  text: string,
): string {
  return [
    'annotation',
    session.getRepoName(),
    relPath,
    annotationId,
    target,
    hashString(text),
  ].join('::');
}

function pendingCommentTextCacheKey(
  commentId: string,
  target: Language,
  text: string,
): string {
  return ['pending', reviewScopeKey(), commentId, target, hashString(text)].join('::');
}

function globalTextCacheKey(
  section: 'conclusion' | 'evidence' | 'verdictTitle' | 'verdictBefore' | 'verdictAfter' | 'spotTitle' | 'spotDetail' | 'spotSuggestion',
  id: string,
  target: Language,
  text: string,
): string {
  return ['global', reviewScopeKey(), section, id, target, hashString(text)].join('::');
}

async function ensureLocalizedTexts(
  target: Language,
  items: Array<{ cacheKey: string; text: string }>,
): Promise<boolean> {
  const cache = ensureLocalizedTextCache();
  const missing = items.filter((it) => it.text.trim() && shouldTranslateText(it.text, target) && !cache[it.cacheKey]);
  if (missing.length === 0) {
    return false;
  }
  const model = await models.resolve();
  if (!model) {
    return false;
  }
  const token = new vscode.CancellationTokenSource();
  try {
    const chunkSize = 80;
    for (let i = 0; i < missing.length; i += chunkSize) {
      const chunk = missing.slice(i, i + chunkSize);
      try {
        const translated = await translateTextBatch(
          model,
          chunk.map((x) => x.text),
          target,
          token.token,
        );
        for (let j = 0; j < chunk.length; j++) {
          cache[chunk[j].cacheKey] = translated[j] ?? chunk[j].text;
        }
      } catch (err) {
        // Some models occasionally violate strict JSON shape in batch mode.
        // Fallback to per-item translation so localization still completes.
        console.warn('[codereview] translateTextBatch failed; fallback to per-item translation:', err);
        for (const it of chunk) {
          try {
            cache[it.cacheKey] = await translateSelection(model, it.text, token.token);
          } catch {
            // Preserve original text when translation fails for an item.
            cache[it.cacheKey] = it.text;
          }
        }
      }
    }
    flushLocalizedTextCache();
    return true;
  } finally {
    token.dispose();
  }
}

function localizeFindingsNow(relPath: string, findings: Finding[], target: Language): Finding[] {
  return findings.map((f) => {
    const titleKey = findingTextCacheKey(relPath, f.id, 'title', target, f.title);
    const detailKey = findingTextCacheKey(relPath, f.id, 'detail', target, f.detail);
    const suggestionKey = f.suggestion
      ? findingTextCacheKey(relPath, f.id, 'suggestion', target, f.suggestion)
      : undefined;
    return {
      ...f,
      title: localizedText(titleKey, f.title),
      detail: localizedText(detailKey, f.detail),
      suggestion: suggestionKey ? localizedText(suggestionKey, f.suggestion ?? '') : undefined,
      verification: f.verification
        ? {
            ...f.verification,
            rationale: localizedText(
              findingTextCacheKey(
                relPath,
                f.id,
                'verification',
                target,
                f.verification.rationale,
              ),
              f.verification.rationale,
            ),
          }
        : undefined,
    };
  });
}

function localizeAnnotationsNow(
  relPath: string,
  annotations: Annotation[],
  target: Language,
): Annotation[] {
  return annotations.map((a) => {
    const key = annotationTextCacheKey(relPath, a.id, target, a.content);
    return { ...a, content: localizedText(key, a.content) };
  });
}

function localizePendingCommentBodyNow(comment: { id: string; body: string }, target: Language): string {
  const key = pendingCommentTextCacheKey(comment.id, target, comment.body);
  return localizedText(key, comment.body);
}

function localizeGlobalReportNow(report: GlobalReport, target: Language): GlobalReport {
  return {
    ...report,
    conclusion: localizedText(globalTextCacheKey('conclusion', 'main', target, report.conclusion), report.conclusion),
    evidence: report.evidence.map((e, i) =>
      localizedText(globalTextCacheKey('evidence', String(i), target, e), e),
    ),
    verdicts: report.verdicts.map((v, i) => ({
      ...v,
      title: localizedText(globalTextCacheKey('verdictTitle', `${i}:${v.kind}`, target, v.title), v.title),
      before: localizedText(globalTextCacheKey('verdictBefore', `${i}:${v.kind}`, target, v.before), v.before),
      after: localizedText(globalTextCacheKey('verdictAfter', `${i}:${v.kind}`, target, v.after), v.after),
      // Keep technical evidence verbatim by design.
      evidence: v.evidence,
    })),
    fixSpots: report.fixSpots.map((sp, i) => ({
      ...sp,
      title: localizedText(globalTextCacheKey('spotTitle', `${i}:${sp.id}`, target, sp.title), sp.title),
      detail: localizedText(globalTextCacheKey('spotDetail', `${i}:${sp.id}`, target, sp.detail), sp.detail),
      suggestion: sp.suggestion
        ? localizedText(globalTextCacheKey('spotSuggestion', `${i}:${sp.id}`, target, sp.suggestion), sp.suggestion)
        : undefined,
    })),
  };
}

async function ensureDocLocalized(path: string): Promise<void> {
  const target = resolveLanguage();
  const key = `${path}::${target}`;
  if (inFlightDocLocalization.has(key)) {
    return;
  }
  inFlightDocLocalization.add(key);
  try {
    const findings = session.findings(path);
    const annotations = session.annotations(path);
    const titleItems: Array<{ cacheKey: string; text: string }> = [];
    const restItems: Array<{ cacheKey: string; text: string }> = [];
    for (const f of findings) {
      titleItems.push({ cacheKey: findingTextCacheKey(path, f.id, 'title', target, f.title), text: f.title });
      restItems.push({ cacheKey: findingTextCacheKey(path, f.id, 'detail', target, f.detail), text: f.detail });
      if (f.suggestion) {
        restItems.push({
          cacheKey: findingTextCacheKey(path, f.id, 'suggestion', target, f.suggestion),
          text: f.suggestion,
        });
      }
      if (f.verification?.rationale) {
        restItems.push({
          cacheKey: findingTextCacheKey(
            path,
            f.id,
            'verification',
            target,
            f.verification.rationale,
          ),
          text: f.verification.rationale,
        });
      }
    }
    for (const a of annotations) {
      restItems.push({ cacheKey: annotationTextCacheKey(path, a.id, target, a.content), text: a.content });
    }

    const cache = ensureLocalizedTextCache();
    const hasMissing = (items: Array<{ cacheKey: string; text: string }>) =>
      items.some((it) => it.text.trim() && shouldTranslateText(it.text, target) && !cache[it.cacheKey]);

    const needTitlePass = hasMissing(titleItems);
    const needRestPass = hasMissing(restItems);

    if ((needTitlePass || needRestPass) && DocumentPanel.currentPath === path) {
      DocumentPanel.flashNotice(path, m().analysis.localizingFindings, 'info', 1400);
    }

    if (needTitlePass) {
      const changedTitle = await ensureLocalizedTexts(target, titleItems);
      if (changedTitle && DocumentPanel.currentPath === path) {
        await refreshDocPanel(path);
      }
      if (changedTitle) {
        FixProposalPanel.refreshIfOpen({ kind: 'file', rel: path });
      }
    }

    if (needRestPass) {
      const changedRest = await ensureLocalizedTexts(target, restItems);
      if (changedRest && DocumentPanel.currentPath === path) {
        await refreshDocPanel(path);
      }
      if (changedRest) {
        FixProposalPanel.refreshIfOpen({ kind: 'file', rel: path });
      }
    }
  } finally {
    inFlightDocLocalization.delete(key);
  }
}

async function ensureGlobalReportLocalized(report: GlobalReport): Promise<void> {
  const target = resolveLanguage();
  const key = `${reviewScopeKey()}::${target}`;
  if (inFlightGlobalLocalization.has(key)) {
    return;
  }
  inFlightGlobalLocalization.add(key);
  try {
    const items: Array<{ cacheKey: string; text: string }> = [
      { cacheKey: globalTextCacheKey('conclusion', 'main', target, report.conclusion), text: report.conclusion },
    ];
    for (let i = 0; i < report.evidence.length; i++) {
      items.push({
        cacheKey: globalTextCacheKey('evidence', String(i), target, report.evidence[i]),
        text: report.evidence[i],
      });
    }
    for (let i = 0; i < report.verdicts.length; i++) {
      const v = report.verdicts[i];
      items.push({
        cacheKey: globalTextCacheKey('verdictTitle', `${i}:${v.kind}`, target, v.title),
        text: v.title,
      });
      items.push({
        cacheKey: globalTextCacheKey('verdictBefore', `${i}:${v.kind}`, target, v.before),
        text: v.before,
      });
      items.push({
        cacheKey: globalTextCacheKey('verdictAfter', `${i}:${v.kind}`, target, v.after),
        text: v.after,
      });
    }
    for (let i = 0; i < report.fixSpots.length; i++) {
      const sp = report.fixSpots[i];
      items.push({
        cacheKey: globalTextCacheKey('spotTitle', `${i}:${sp.id}`, target, sp.title),
        text: sp.title,
      });
      items.push({
        cacheKey: globalTextCacheKey('spotDetail', `${i}:${sp.id}`, target, sp.detail),
        text: sp.detail,
      });
      if (sp.suggestion) {
        items.push({
          cacheKey: globalTextCacheKey('spotSuggestion', `${i}:${sp.id}`, target, sp.suggestion),
          text: sp.suggestion,
        });
      }
    }
    const changed = await ensureLocalizedTexts(target, items);
    if (changed && session.globalReport) {
      FixProposalPanel.refreshIfOpen({ kind: 'global' });
      showGlobalReport();
    }
  } finally {
    inFlightGlobalLocalization.delete(key);
  }
}

async function ensurePendingCommentsLocalized(): Promise<boolean> {
  const target = resolveLanguage();
  const key = `${pendingCommentLocalizationKey}::${reviewScopeKey()}::${target}`;
  if (inFlightDocLocalization.has(key)) {
    return false;
  }
  inFlightDocLocalization.add(key);
  try {
    const items = session.pendingComments.map((pc) => ({
      cacheKey: pendingCommentTextCacheKey(pc.id, target, pc.body),
      text: pc.body,
    }));
    return await ensureLocalizedTexts(target, items);
  } finally {
    inFlightDocLocalization.delete(key);
  }
}

/** Hydrates appliedFixes from workspaceState so revert/locate survive window reloads. */
function hydrateAppliedFixes(memento: vscode.Memento): void {
  appliedFixesMemento = memento;
  const stored = memento.get<Record<string, { oldText: string; newText: string }>>(
    APPLIED_FIXES_MEMENTO_KEY,
  );
  if (stored) {
    for (const [key, edit] of Object.entries(stored)) {
      appliedFixes.set(key, edit);
    }
  }
}

/** Persists the current appliedFixes map to workspaceState. */
function flushAppliedFixes(): void {
  if (!appliedFixesMemento) {
    return;
  }
  const obj: Record<string, { oldText: string; newText: string }> = {};
  for (const [key, edit] of appliedFixes) {
    obj[key] = edit;
  }
  void appliedFixesMemento.update(APPLIED_FIXES_MEMENTO_KEY, obj);
}

function setAppliedFix(key: string, edit: { oldText: string; newText: string }): void {
  appliedFixes.set(key, edit);
  flushAppliedFixes();
}

/** Carries legacy positional global-fix snapshots onto stable content ids. */
function migrateAppliedGlobalFixes(
  previous: GlobalReport | undefined,
  next: GlobalReport,
): void {
  if (!previous) {
    return;
  }
  const stableIds = globalFixSpotSignatures(previous.fixSpots);
  let changed = false;
  for (let index = 0; index < previous.fixSpots.length; index++) {
    const oldSpot = previous.fixSpots[index];
    const newSpot = next.fixSpots.find((spot) => spot.id === stableIds[index]);
    if (!newSpot) {
      continue;
    }
    const oldKey = fixKey(oldSpot.file, oldSpot.id);
    const newKey = fixKey(newSpot.file, newSpot.id);
    const edit = getAppliedFix(oldSpot.file, oldSpot.id);
    if (edit && oldKey !== newKey) {
      appliedFixes.set(newKey, edit);
      appliedFixes.delete(oldKey);
      appliedFixes.delete(legacyFixKey(oldSpot.file, oldSpot.id));
      changed = true;
    }
  }
  if (changed) {
    flushAppliedFixes();
  }
}

/** Forces every visible review surface to re-render in the current language. */
function refreshUiForLanguageSwitch(): void {
  refreshStatusBarText();
  workbenchFilesVersion = -1;
  WorkbenchPanel.rerenderIfOpen();
  // Rebuild shell text (tab/button labels) first.
  DocumentPanel.refreshIfOpen();
  const currentPath = DocumentPanel.currentPath;
  if (currentPath) {
    // Then refresh the data model for the currently opened file so findings /
    // annotations follow the new language as well.
    void refreshDocPanel(currentPath);
  }
  FixProposalPanel.refreshIfOpen();
  if (session.globalReport) {
    showGlobalReport();
  } else {
    GlobalReportPanel.refreshIfOpen();
  }
}

/**
 * Re-syncs the in-memory applied-fix map from persisted storage. Used when
 * (re)loading a review so previously applied Copilot fixes survive a reload —
 * this does NOT erase the saved snapshots, which is what kept 「定位」/inline
 * cards following the fix content after a reload.
 */
function rehydrateAppliedFixes(): void {
  appliedFixes.clear();
  if (!appliedFixesMemento) {
    return;
  }
  const stored = appliedFixesMemento.get<Record<string, { oldText: string; newText: string }>>(
    APPLIED_FIXES_MEMENTO_KEY,
  );
  if (stored) {
    for (const [key, edit] of Object.entries(stored)) {
      appliedFixes.set(key, edit);
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const repo = workspaceFolderName() ?? 'unknown';
  const store = new WorkspaceStateReviewStore(context.workspaceState);
  session = new ReviewSession(store, repo);
  reviewCoordinator = new ReviewCoordinator(session, {
    model: () => models.resolve(),
    repositoryStamp: (token) => repositoryEvidenceStamp(requireReviewCwd(), requireReviewSet().headSha, token),
    validateHashes: validateWorkflowHashes,
    analyzeFile: analyzeWorkflowFile,
    analyzeGlobal: analyzeWorkflowGlobal,
    applyGlobal: applyWorkflowGlobal,
    showSource: (path) => { if (!centerDocument || centerDocument.path === path) void openFileInPanel(path); },
    changed: () => { centerEpoch++; WorkbenchPanel.refreshNow(); },
    notice: centerNotice,
    errorText: workflowErrorText,
  });
  WorkbenchPanel.init(context.extensionUri);

  // Accumulate estimated LLM token usage onto the active review and refresh the
  // workbench HUD. Estimates are approximate (countTokens-based), not billed.
  setTokenUsageSink((usage) => {
    session.recordTokenUsage(usage);
    WorkbenchPanel.refreshIfOpen();
  });

  // Wire the fix-proposal cache so previously generated suggestions persist
  // across reloads and rapid navigation between findings.
  FixProposalPanel.init(context.workspaceState);

  // Restore the per-workspace model choice so the workbench opens on the
  // model the user last picked for this project (instead of always "Auto").
  models.init(context.workspaceState);

  // Restore applied-fix snapshots so 「撤销修复」 and the fix-aware 「定位」
  // keep working after a window reload (they rely on the saved newText).
  hydrateAppliedFixes(context.workspaceState);
  workspaceMemento = context.workspaceState;

  // Auto-pick the gh account that can access each repo (by owner) so reviewing
  // repos owned by different accounts (personal vs enterprise) just works,
  // without manually switching the global active gh account.
  initAccountResolver(context.globalState);
  setGhTokenResolver(resolveGhTokenForRepo);

  // Older versions hid the activity bar globally and didn't always restore it.
  // If the global setting is still `hidden`, reset it once so the user gets
  // the activity bar back without having to fix it manually.
  void restoreGloballyHiddenActivityBar(context);

  context.subscriptions.push(
    session,
    reviewCoordinator,
    vscode.commands.registerCommand('codereview.startReview', startReview),
    vscode.commands.registerCommand('codereview.openOrStart', openOrStartReview),
    vscode.commands.registerCommand('codereview.openInNewWindow', openInNewWindow),
    vscode.commands.registerCommand('codereview.pickModel', selectModel),
    vscode.commands.registerCommand('codereview.pickLanguage', selectLanguage),
    vscode.commands.registerCommand('codereview.openWorkbench', openWorkbench),
    vscode.commands.registerCommand('codereview.openFile', openFileInPanel),
    vscode.commands.registerCommand('codereview.analyzeFile', analyzeCurrentFile),
    vscode.commands.registerCommand('codereview.globalAnalysis', runGlobalAnalysis),
    vscode.commands.registerCommand('codereview.showGlobalReport', showGlobalReport),
    vscode.commands.registerCommand('codereview.submitConclusion', submitConclusion),
    vscode.commands.registerCommand('codereview.viewPendingComments', viewPendingComments),
    vscode.commands.registerCommand('codereview.locateFinding', locateInFile),
    vscode.commands.registerCommand('codereview.jumpToNextUnseen', jumpToNextUnseenCurrent),
    registerIgnoreReasonPasteCommand(),
    createStatusBarEntry(),
    registerLauncherView(),
    vscode.workspace.onDidChangeTextDocument(handleReviewDocumentChange),
  );

  // Keep the workbench webview in sync with session progress.
  context.subscriptions.push(
    session.onDidChange((change) => WorkbenchPanel.refreshIfOpen(change.filePath)),
  );

  // Re-render UI the instant the user flips `codereview.language`, so the status
  // bar and any open webviews switch language without a reload.
  context.subscriptions.push(
    onLanguageChange(() => {
      refreshUiForLanguageSwitch();
    }),
  );

  // Restore the workbench panel after a window reload: if VS Code kept the
  // popped-out review panel, this serializer hands it back. We reload the last
  // review folder so the panel has live data, then re-attach it — no need for
  // the user to click 「Open in AI Coding Review」 again.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('codereview.workbench', {
      deserializeWebviewPanel: async (panel) => {
        await restoreWorkbenchInto(panel);
      },
    }),
  );

  // The document viewer is reconstructed on demand (when the user picks a file),
  // so a restored-but-empty frame would be misleading. Dispose it; the workbench
  // restore above brings back the review and the user reopens a file from there.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('codereview.document', {
      deserializeWebviewPanel: async (panel) => {
        panel.dispose();
      },
    }),
    vscode.window.registerWebviewPanelSerializer('codereview.fixProposal', {
      deserializeWebviewPanel: async (panel) => {
        panel.dispose();
      },
    }),
    vscode.window.registerWebviewPanelSerializer('codereview.globalReport', {
      deserializeWebviewPanel: async (panel) => {
        panel.dispose();
      },
    }),
  );

  // Activation setup is done; swap the status bar spinner for the real icon so
  // users only click once it can actually open the workbench.
  markStatusBarReady();
}

/**
 * Registers the Activity Bar launcher view. It is an intentionally empty tree:
 * its only job is to host the `viewsWelcome` buttons (contributed in
 * package.json) so the Activity Bar icon opens a prominent, always-findable
 * entry point — addressing reports that the bottom-right status-bar entry is
 * easy to miss. The buttons reuse existing commands (open/start review, open in
 * a new window, pick model/language), so there is no behaviour to duplicate.
 */
function registerLauncherView(): vscode.Disposable {
  const provider: vscode.TreeDataProvider<never> = {
    getChildren: () => [],
    getTreeItem: (element) => element,
  };
  return vscode.window.registerTreeDataProvider('codereview.launcher', provider);
}

/** Status bar button; starts as a spinner during activation, then the real icon. */
let statusBarItem: vscode.StatusBarItem | undefined;

/** Adds a persistent status bar button that opens the workbench or starts a new review. */
function createStatusBarEntry(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.name = 'AI Coding Review';
  // Show a spinner until activation finishes; clicking before then would be a
  // no-op and confuse the user, so we signal "loading" explicitly.
  item.text = `$(loading~spin) ${m().statusBar.loading}`;
  item.tooltip = m().statusBar.loadingTooltip;
  item.command = 'codereview.openInNewWindow';
  item.show();
  statusBarItem = item;
  return item;
}

/** Swaps the status bar entry from its loading spinner to the ready state. */
function markStatusBarReady(): void {
  if (!statusBarItem) {
    return;
  }
  statusBarReady = true;
  setStatusBarBusy(false);
}

/** Tracks whether activation finished, so busy toggles don't override "加载中". */
let statusBarReady = false;

/** Toggles the status bar button between its spinner and ready icon. */
function setStatusBarBusy(busy: boolean): void {
  if (!statusBarItem) {
    return;
  }
  if (!statusBarReady) {
    statusBarItem.text = `$(loading~spin) ${m().statusBar.loading}`;
    statusBarItem.tooltip = m().statusBar.loadingTooltip;
    return;
  }
  if (busy) {
    statusBarItem.text = `$(loading~spin) ${m().statusBar.opening}`;
    statusBarItem.tooltip = m().statusBar.openingTooltip;
  } else {
    statusBarItem.text = `$(checklist) ${m().statusBar.ready}`;
    statusBarItem.tooltip = m().statusBar.readyTooltip;
  }
}

/** Re-applies the resting status bar label in the current language (after a language switch). */
function refreshStatusBarText(): void {
  if (statusBarItem && statusBarReady) {
    setStatusBarBusy(false);
  }
}

/** Status-bar entry: open the workbench if a review is in progress, else start one. */
async function openOrStartReview(): Promise<void> {
  if (session.reviewSet) {
    await openWorkbench();
    return;
  }
  await startReview();
}

/**
 * "Open in AI Coding Review" — the analogue of VS Code's "Open in Agents Window":
 * pick a workspace folder (in multi-root setups), pop the workbench into a
 * separate auxiliary window, and let the user pick the review scope inside it.
 *
 * Accepts a cwd in three forms because callers vary:
 *   - string fsPath (from the TreeItem's command.arguments)
 *   - WorkspaceFolder (when invoked as an inline action — VS Code injects it)
 *   - Uri (defensive, for arbitrary callers)
 */
async function openInNewWindow(
  cwdArg?: string | vscode.WorkspaceFolder | vscode.Uri,
): Promise<void> {
  if (WorkbenchPanel.isOpen) {
    WorkbenchPanel.reveal();
    return;
  }
  if (workbenchOpenInFlight) {
    openingWorkbenchPanel?.reveal(undefined, false);
    return;
  }
  workbenchOpenInFlight = true;
  let loadingPanel: vscode.WebviewPanel | undefined;
  try {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let chosenCwd: string | undefined = resolveCwdArg(cwdArg);
    if (!chosenCwd) {
      if (folders.length === 0) {
        void vscode.window.showErrorMessage(m().review.noWorkspace);
        return;
      } else if (folders.length === 1) {
        chosenCwd = folders[0].uri.fsPath;
      } else {
        const pick = await vscode.window.showQuickPick(
          folders.map((f) => ({
            label: `$(folder) ${f.name}`,
            description: f.uri.fsPath,
            cwd: f.uri.fsPath,
          })),
          {
            title: m().review.pickProjectTitle,
            placeHolder: m().review.pickProjectPlaceholder,
          },
        );
        if (!pick) {
          return;
        }
        chosenCwd = pick.cwd;
      }
    }
    preferredDefaultCwd = chosenCwd;
    setStatusBarBusy(true);

    const loading = WorkbenchPanel.createLoading(m().review.loadingProject, 'scan');
    loadingPanel = loading.panel;
    openingWorkbenchPanel = loading.panel;
    await moveActiveEditorToNewWindow();

    const loaded = await loadPreferredReviewWithProgress(chosenCwd, loading.progress);
    if (!loaded) {
      loading.panel.dispose();
      transientWarning(m().review.noReviewableFiles);
      return;
    }
    loading.progress.report(m().workbench.loadingOpening, 'open');
    WorkbenchPanel.adopt(loading.panel, buildWorkbenchState, workbenchActions());
  } finally {
    if (loadingPanel && !WorkbenchPanel.isOpen) {
      loadingPanel.dispose();
    }
    openingWorkbenchPanel = undefined;
    workbenchOpenInFlight = false;
    setStatusBarBusy(false);
  }
}

/** Defaults to changed files and leaves whole-project review as an explicit choice. */
async function loadPreferredReview(cwd: string): Promise<boolean> {
  return withWorkbenchProgress(
    m().review.loadingProject,
    (progress) => loadPreferredReviewWithProgress(cwd, progress),
  );
}

async function loadPreferredReviewWithProgress(
  cwd: string,
  progress: WorkbenchProgressReporter,
): Promise<boolean> {
  const attemptMessage = (kind: PreferredScopeKind): string => {
    if (kind === 'currentPr') return m().scope.checkingCurrentPr;
    return m().scope.loadingCurrentBranch;
  };
  const preferred = await tryLoadPreferredScope(
    cwd,
    (kind) => progress.report(attemptMessage(kind), 'scan'),
    ({ directoriesScanned, filesFound, percent, etaSeconds, estimated }) =>
      progress.report(
        m().scope.scanProgress(directoriesScanned, filesFound),
        'scan',
        { percent, etaSeconds, estimated },
      ),
  );
  if (!preferred) {
    return false;
  }
  try {
    progress.report(
      m().scope.preferredScopeFound(preferred.reviewSet.label, preferred.reviewSet.files.length),
      'restore',
    );
    await activateReviewSet(preferred.reviewSet, preferred.cwd);
    persistScope(preferred.scope, preferred.reviewSet, preferred.cwd);
    return true;
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    void vscode.window.showErrorMessage(m().review.error(message));
    return false;
  }
}

async function activateReviewSet(reviewSet: ReviewSet, cwd: string): Promise<void> {
  if (centerSubmitting) throw new Error(m().reviewCenter.submitting);
  reviewCoordinator.resetScope();
  closeScopeBoundPanels();
  openFileGeneration++;
  workbenchSelected = undefined;
  centerDocument = undefined;
  centerDocumentLoading = false;
  activeDocTranslation?.cts.cancel();
  docRenderCache.clear();
  docDiffCache.clear();
  baseTextCache.clear();
  baseRenderCache.clear();
  centerEpoch++;
  await session.start(reviewSet, cwd);
  await session.enableWorkflow();
  await refreshBranchLabel();
  closeScopeBoundPanels();
  workbenchSelected = undefined;
  centerDocument = undefined;
  centerDocumentLoading = false;
  centerEpoch++;
  docRenderCache.clear();
  docDiffCache.clear();
  baseTextCache.clear();
  baseRenderCache.clear();
  rehydrateAppliedFixes();
  WorkbenchPanel.resetFolders();
  layoutAppliedForCurrentReview = false;
  void vscode.commands.executeCommand('setContext', 'codereview.active', true);
  transientInfo(m().review.loaded(reviewSet.label, reviewSet.files.length));
}

function resolveCwdArg(arg?: string | vscode.WorkspaceFolder | vscode.Uri): string | undefined {
  if (!arg) return undefined;
  if (typeof arg === 'string') return arg.length > 0 ? arg : undefined;
  if (arg instanceof vscode.Uri) return arg.fsPath;
  if ('uri' in arg && arg.uri instanceof vscode.Uri) return arg.uri.fsPath;
  return undefined;
}

async function startReview(kind?: string): Promise<void> {
  if (!canChangeReview()) return;
  if (reviewCoordinator.editing) { centerNotice(m().reviewCenter.unsavedEdit, true); return; }
  const defaultCwd = preferredDefaultCwd ?? workspaceFolderPath();
  if (!defaultCwd) {
    void vscode.window.showErrorMessage(m().review.noGitWorkspace);
    return;
  }

  if (scopePickInFlight) {
    return;
  }
  scopePickInFlight = true;
  centerEpoch++;
  WorkbenchPanel.refreshNow();
  let picked: PickedScope | undefined;
  try {
    picked = await pickScope(defaultCwd, WorkbenchPanel.viewColumn, kind);
  } finally {
    if (!picked) {
      scopePickInFlight = false;
      centerEpoch++;
      WorkbenchPanel.refreshNow();
    }
  }
  if (!picked) {
    return;
  }
  const { scope: source, cwd } = picked;
  await withWorkbenchProgress(
    m().review.loadingSource,
    async () => {
      try {
        const reviewSet = await source.load(cwd);
        await activateReviewSet(reviewSet, cwd);
        // Persist the exact scope so an extension/host restart can rebuild this
        // same selection (and hit its saved snapshot), not just the whole folder.
        persistScope(source, reviewSet, cwd);
        void vscode.commands.executeCommand('setContext', 'codereview.active', true);
        await openWorkbench();
        transientInfo(m().review.loaded(reviewSet.label, reviewSet.files.length));
      } catch (err) {
        const message = String((err as Error)?.message ?? err);
        void vscode.window.showErrorMessage(m().review.error(message));
      }
    },
  ).finally(() => {
    scopePickInFlight = false;
    centerEpoch++;
    WorkbenchPanel.refreshNow();
  });
}

/**
 * Records the scope the user just started reviewing so a later extension/host
 * restart can rebuild the *same* selection (and therefore reuse its persisted
 * snapshot). File-system selections store their resolved relative paths; other
 * scope kinds (e.g. PR) fall back to remembering the folder, since they are
 * reconstructed dynamically and their snapshot key follows the live head.
 */
function persistScope(source: ReviewScope, reviewSet: ReviewSet, cwd: string): void {
  void workspaceMemento?.update(LAST_REVIEW_FOLDER_KEY, cwd);
  const prNumber = Number.parseInt(reviewSet.scopeId.match(/^pr-(\d+)$/)?.[1] ?? '', 10);
  const descriptor: PersistedScope =
    source instanceof BranchComparisonScope || source instanceof BranchSnapshotScope
      ? { kind: 'branch', cwd, baseRef: source instanceof BranchComparisonScope ? source.baseRef : undefined }
      : source instanceof FileSystemScope
      ? { kind: 'files', cwd, relPaths: reviewSet.files.map((f) => f.path) }
      : Number.isFinite(prNumber)
        ? { kind: 'pr', cwd, number: prNumber, reviewSet }
        : { kind: 'preferred', cwd };
  void workspaceMemento?.update(LAST_SCOPE_KEY, descriptor);
}

async function selectModel(): Promise<void> {
  if (!canChangeReview()) return;
  const choice = await pickModel();
  if (choice && canChangeReview()) {
    models.set(choice);
    WorkbenchPanel.refreshIfOpen();
    transientInfo(m().model.switched(choice.label));
  }
}

/**
 * Serves the inline model/branch dropdowns: fetches the menu items asynchronously
 * (Copilot models or local git branches) and pushes them to the workbench webview.
 * Native quick-picks are invisible in the auxiliary workbench window, hence inline.
 */
async function openDynMenu(kind: string): Promise<void> {
  if (kind === 'model') {
    const picks = await listModels();
    dynModelCache = new Map(picks.map((p) => [p.id, p]));
    WorkbenchPanel.postDynMenu(
      'model',
      picks.map((p) => ({ id: p.id, label: p.label, current: p.id === models.id })),
    );
    return;
  }
  if (kind === 'branch') {
    const cwd = session.getCwd();
    if (!cwd) {
      return;
    }
    const branches = await listBranches(cwd).catch(() => [] as string[]);
    WorkbenchPanel.postDynMenu(
      'branch',
      branches.map((b) => ({ id: b, label: b, current: b === currentBranchLabel })),
    );
  }
}

/** Applies an inline model/branch choice dispatched from the workbench webview. */
async function applyDynMenu(kind: string, id: string): Promise<void> {
  if (!canChangeReview()) return;
  if (kind === 'model') {
    const choice = dynModelCache.get(id);
    if (choice) {
      models.set(choice);
      WorkbenchPanel.refreshIfOpen();
      transientInfo(m().model.switched(choice.label));
    }
    return;
  }
  if (kind === 'branch') {
    const cwd = session.getCwd();
    if (!cwd || id === currentBranchLabel) {
      return;
    }
    let result: { stashed: boolean };
    try {
      result = await withWorkbenchProgress(m().workbench.switchingBranch(id), () => switchBranchTo(cwd, id));
    } catch (err) {
      WorkbenchPanel.flashNotice(m().workbench.branchSwitchFailed(id) + ': ' + String((err as Error)?.message ?? err), 'error');
      return;
    }
    await refreshBranchLabel();
    WorkbenchPanel.refreshIfOpen();
    if (result.stashed) {
      WorkbenchPanel.flashNotice(m().workbench.branchStashed, 'warn');
    }
  }
}

/**
 * Lets the user switch the whole-experience language (UI + LLM output) from
 * inside AI Coding Review, instead of digging through VS Code settings. Writes
 * `codereview.language`, which the config-change listener picks up to re-render
 * the status bar and any open webviews live.
 */
/** Applies a language id chosen from the inline workbench menu. */
async function applyLanguage(id: string): Promise<void> {
  if (!canChangeReview()) return;
  const cur = vscode.workspace.getConfiguration('codereview').get<string>('language', 'en');
  if (id === cur) {
    return;
  }
  await vscode.workspace
    .getConfiguration('codereview')
    .update('language', id, vscode.ConfigurationTarget.Global);
}

async function selectLanguage(): Promise<void> {
  const current = vscode.workspace.getConfiguration('codereview').get<string>('language', 'en');
  const t = m().model;
  const pick = await vscode.window.showQuickPick(
    [
      { label: m().workbench.langEn, value: 'en' as const },
      { label: m().workbench.langZh, value: 'zh-CN' as const },
      { label: m().workbench.langAuto, value: 'auto' as const },
    ].map((o) => ({ ...o, description: o.value === current ? t.current : undefined })),
    { title: m().workbench.languageTitle, placeHolder: m().workbench.languagePlaceholder },
  );
  if (!pick || pick.value === current) {
    return;
  }
  // Update at the highest scope that already defines it, else global, so the
  // change actually takes effect regardless of where the user set it before.
  await vscode.workspace
    .getConfiguration('codereview')
    .update('language', pick.value, vscode.ConfigurationTarget.Global);
}

/** Opens (or reveals) the Review Workbench webview. */
async function openWorkbench(opts: { moveToNewWindow?: boolean } = {}): Promise<void> {
  if (!session.reviewSet) {
    await startReview();
    return;
  }
  // Snapshot BEFORE show(): only a freshly created panel may be relocated to a
  // new window. If the workbench already exists it may already live in its own
  // auxiliary window — moving it again spawns a second empty window and leaves
  // the previous one behind as an empty husk (the blank watermark frames).
  const alreadyOpen = WorkbenchPanel.isOpen;
  WorkbenchPanel.show(buildWorkbenchState, workbenchActions());
  if (opts.moveToNewWindow && !alreadyOpen) {
    // Relocate to a dedicated window immediately — before any file open or layout
    // work — so the panel appears to open directly in its own window rather than
    // flashing as a tab in the current one first.
    await moveActiveEditorToNewWindow();
  }
  // The document panel is created lazily on the first file open (openFileInPanel),
  // which also applies the 3:7 split. Pre-creating it here spawned an extra window:
  // an empty document webview (no model yet) renders as a blank/black window in the
  // auxiliary-window layout. So we do NOT pre-warm.
}

async function moveActiveEditorToNewWindow(): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
  } catch (err) {
    console.warn('[codereview] moveEditorToNewWindow failed:', err);
  }
  // A stale document panel in the previous window would otherwise steal the
  // Beside column; drop it so the next file opens beside the relocated panel.
  DocumentPanel.closeIfOpen();
}

/**
 * Switches the active git branch via VS Code's native checkout picker (same UI
 * as the status-bar branch indicator), then refreshes the HUD branch label. The
 * current review session/progress is left intact — to review the new branch's
 * content, use the 'Switch scope' button.
 */
async function switchBranch(): Promise<void> {
  const cwd = session.getCwd();
  if (!cwd) {
    return;
  }
  try {
    await vscode.commands.executeCommand('git.checkout');
  } catch (err) {
    console.warn('[codereview] git.checkout failed:', err);
    return;
  }
  await refreshBranchLabel();
  WorkbenchPanel.rerenderIfOpen();
}

/**
 * Switches which workspace folder (project) is under review. No-op in a
 * single-root workspace. Picking another root loads its preferred change scope
 * (current PR, then the complete current-branch change set).
 */
/** Switches the review to the given workspace-folder cwd (from the inline menu). */
async function switchProjectTo(cwd: string): Promise<void> {
  if (!canChangeReview()) return;
  if (cwd === session.getCwd()) {
    return;
  }
  preferredDefaultCwd = cwd;
  setStatusBarBusy(true);
  try {
    if (await loadPreferredReview(cwd)) {
      await openWorkbench();
    }
  } finally {
    setStatusBarBusy(false);
  }
}

async function switchProject(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) {
    transientInfo(m().review.singleProject);
    return;
  }
  const current = session.getCwd();
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({
      label: `$(folder) ${f.name}`,
      description: f.uri.fsPath === current ? `${f.uri.fsPath} · ${m().model.current}` : f.uri.fsPath,
      cwd: f.uri.fsPath,
    })),
    { title: m().review.pickProjectTitle, placeHolder: m().review.pickProjectPlaceholder },
  );
  if (!pick || pick.cwd === current) {
    return;
  }
  preferredDefaultCwd = pick.cwd;
  setStatusBarBusy(true);
  try {
    if (await loadPreferredReview(pick.cwd)) {
      await openWorkbench();
    }
  } finally {
    setStatusBarBusy(false);
  }
}

/** Builds the action callbacks the workbench webview dispatches to. */
function workbenchActions(): import('./ui/workbenchPanel').WorkbenchActions {
  return {
    center: (message) => { void handleReviewCenter(message).catch((error: unknown) => centerNotice(workflowErrorText(error), true)); },
    open: (path) => void openFileInPanel(path),
    openFocus: (path) => void (async () => { await openFileInPanel(path); DocumentPanel.focus(); })(),
    focusDoc: () => DocumentPanel.focus(),
    disposeFinding: (path, id, kind) => void disposeFinding(path, id, kind),
    locate: (path, line) => void locateInFile(path, line),
    globalAnalysis: () => void runGlobalAnalysis(),
    cancelGlobalAnalysis: () => cancelGlobalAnalysis(),
    showGlobal: showGlobalReport,
    exportReport: () => void exportReviewReport(),
    submit: () => void submitConclusion(),
    pickModel: () => void selectModel(),
    pickLanguage: () => void selectLanguage(),
    pickBranch: () => void switchBranch(),
    pickProject: () => void switchProject(),
    pickScope: () => void startReview(),
    pickScopeKind: (kind) => void startReview(kind),
    pickProjectCwd: (cwd) => void switchProjectTo(cwd),
    pickLanguageId: (id) => void applyLanguage(id),
    openDynMenu: (kind) => void openDynMenu(kind),
    applyDynMenu: (kind, id) => void applyDynMenu(kind, id),
  };
}

/**
 * Re-attaches a workbench panel that VS Code restored after a window reload.
 * Reloads the last review folder (so the panel has live session data) and adopts
 * the restored panel. Falls back to disposing the panel when no prior review is
 * recorded, so the user is not left staring at an empty restored frame.
 */
async function restoreWorkbenchInto(panel: vscode.WebviewPanel): Promise<void> {
  const cwd = workspaceMemento?.get<string>(LAST_REVIEW_FOLDER_KEY);
  if (!cwd) {
    panel.dispose();
    return;
  }
  if (workbenchOpenInFlight && openingWorkbenchPanel !== panel) {
    panel.dispose();
    return;
  }
  workbenchOpenInFlight = true;
  openingWorkbenchPanel = panel;
  const progress = WorkbenchPanel.showLoading(panel, m().workbench.loadingInitial, 'restore');
  setStatusBarBusy(true);
  try {
    if (!session.reviewSet) {
      await restoreLastScope(cwd, progress);
    }
    if (!session.reviewSet) {
      panel.dispose();
      return;
    }
    progress.report(m().workbench.loadingOpening, 'open');
    WorkbenchPanel.adopt(panel, buildWorkbenchState, workbenchActions());
    void vscode.commands.executeCommand('setContext', 'codereview.active', true);
  } finally {
    if (openingWorkbenchPanel === panel) {
      openingWorkbenchPanel = undefined;
      workbenchOpenInFlight = false;
    }
    setStatusBarBusy(false);
  }
}

/**
 * Rebuilds the last reviewed scope after an extension/host restart. Prefers the
 * exact persisted selection (so a narrowed file-system scope reuses its saved
 * snapshot); otherwise reloads the preferred change scope for the project.
 */
async function restoreLastScope(
  cwd: string,
  progress?: WorkbenchProgressReporter,
): Promise<void> {
  const descriptor = workspaceMemento?.get<PersistedScope>(LAST_SCOPE_KEY);
  if (descriptor?.kind === 'branch') {
    try {
      const source = descriptor.baseRef ? new BranchComparisonScope(descriptor.baseRef) : new BranchSnapshotScope();
      await activateReviewSet(await source.load(descriptor.cwd), descriptor.cwd);
    } catch (error) { reportError(error); }
    return;
  }
  if (descriptor?.kind === 'pr' || (descriptor?.kind === 'files' && descriptor.relPaths.length > 0)) {
    try {
      progress?.report(m().workbench.loadingSavedScope, 'restore');
      let reviewSet: ReviewSet;
      if (descriptor.kind === 'pr') {
        const currentHead = descriptor.reviewSet
          ? await headSha(descriptor.cwd).catch(() => undefined)
          : undefined;
        reviewSet = descriptor.reviewSet?.prUrl && currentHead === descriptor.reviewSet.headSha
          ? descriptor.reviewSet
          : await new PrByNumberScope(descriptor.number).load(descriptor.cwd);
      } else {
        reviewSet = await new FileSystemScope(descriptor.relPaths).load(descriptor.cwd);
      }
      progress?.report(m().scope.preparingReview(reviewSet.files.length), 'restore');
      await activateReviewSet(reviewSet, descriptor.cwd);
      return;
    } catch (err) {
      console.warn(`[codereview] restoreLastScope (${descriptor.kind}) failed; using preferred scope:`, err);
    }
  }
  if (progress) {
    await loadPreferredReviewWithProgress(cwd, progress);
  } else {
    await loadPreferredReview(cwd);
  }
}

/**
 * Sets the editor group split ratio so the workbench sidebar (column 1) is
 * narrow enough to act as a tool window while the document viewer (column 2)
 * gets the bulk of the width. Invoked the first time a file is opened in a
 * review (once the document group exists); later file switches keep whatever
 * ratio the user dragged to.
 */
async function applyWorkbenchLayout(): Promise<void> {
  try {
    await vscode.commands.executeCommand('vscode.setEditorLayout', {
      orientation: 0,
      groups: [{ size: 0.3 }, { size: 0.7 }],
    });
  } catch {
    // Older VS Code versions or missing second group — ignore.
  }
}

/** Maps a ReviewFile's diff status to a workbench change badge. */
function changeBadge(status?: string, additions?: number, deletions?: number): WorkbenchFile['change'] {
  if (status === 'added') {
    return 'add';
  }
  if (status === 'deleted') {
    return 'del';
  }
  if (status === 'modified' || status === 'renamed') {
    return 'role';
  }
  if (additions && !deletions) {
    return 'add';
  }
  if (deletions && !additions) {
    return 'del';
  }
  if (additions || deletions) {
    return 'role';
  }
  return undefined;
}

/** Snapshots the current session into the serializable workbench state. */
/**
 * Refreshes the cached branch label for the active review's cwd. Best-effort: a
 * non-git folder or any git failure simply clears it (the HUD then shows —).
 */
async function refreshBranchLabel(): Promise<void> {
  const cwd = session.getCwd();
  if (!cwd) {
    currentBranchLabel = undefined;
    return;
  }
  try {
    currentBranchLabel = await currentBranch(cwd);
  } catch {
    currentBranchLabel = undefined;
  }
}

function buildWorkbenchFile(file: ReviewFile): WorkbenchFile {
  const { seen, total } = session.coverage(file.path);
  const findings = session.findings(file.path);
  const fileState = session.fileState(file.path);
  return {
    path: file.path,
    context: file.context,
    name: file.path.split('/').pop() ?? file.path,
    dir: file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '',
    seen,
    total,
    analyzed: !!fileState?.analyzed,
    ready: session.fileReady(file.path),
    fullySeen: session.fileFullySeen(file.path),
    unconfirmed: session.unconfirmedCount(file.path),
    findings: findings.length,
    change: changeBadge(file.status, file.additions, file.deletions),
    active: workbenchSelected === file.path,
    analyzing: analyzingPaths.has(file.path),
  };
}

function requireReviewSet(): ReviewSet {
  if (!session.reviewSet) throw new WorkflowError('noReview');
  return session.reviewSet;
}

function requireReviewCwd(): string {
  const cwd = activeCwd();
  if (!cwd) throw new WorkflowError('noReview');
  return cwd;
}

function workflowErrorText(error: unknown): string {
  if (error instanceof WorkflowError) {
    return `${m().reviewCenter.errors[error.code]}${error.detail ? ` ${error.detail}` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function centerNotice(message: string, error = false): void {
  if (!WorkbenchPanel.flashNotice(message, error ? 'error' : 'warn')) {
    if (error) void vscode.window.showErrorMessage(message);
    else transientInfo(message);
  }
}

function workflowResultsCurrent(): boolean {
  return session.workflowResultsCurrent;
}

function workflowFindingCurrent(path: string, finding: Finding): boolean {
  return session.workflowFindingCurrent(path, finding);
}

function centerFindings(): CenterFinding[] {
  const items: CenterFinding[] = [];
  for (const file of requireReviewSet().files) {
    const raw = session.findings(file.path);
    const ids = findingContentSignatures(raw);
    const localized = localizeFindingsNow(file.path, raw, resolveLanguage());
    raw.forEach((finding, index) => {
      const disposition = session.findingDisposition(file.path, finding.id);
      const ref = `file:${file.path}#${ids[index]}`;
      if (session.workflow?.run.business?.concerns.some((item) => item.findingRef === ref)) return;
      items.push({
        ...localized[index], path: file.path, ref, current: workflowFindingCurrent(file.path, finding),
        disposition: disposition?.kind, dispositionReason: disposition?.reason,
        applied: !!getAppliedFix(file.path, finding.id),
      });
    });
  }
  const report = session.globalReport;
  if (report) {
    const localized = localizeGlobalReportNow(report, resolveLanguage());
    for (const spot of report.fixSpots) {
      const disposition = session.globalFixDisposition(spot.id, spot.file, spot.line, spot.anchor);
      items.push({
        ...(localized.fixSpots.find((item) => item.id === spot.id) ?? spot),
        path: spot.file, ref: `global:${spot.id}`, global: true,
        current: workflowResultsCurrent() && !!session.workflow?.run.globalComplete,
        disposition: disposition?.kind, dispositionReason: disposition?.reason,
        applied: !!getAppliedFix(spot.file, spot.id),
      });
    }
  }
  return items.sort((a, b) => Number(b.current) - Number(a.current));
}

function centerReportBase(): string {
  const workflow = session.workflow;
  if (!workflow) throw new WorkflowError('noReview');
  const set = requireReviewSet();
  const current = workflowResultsCurrent();
  const snapshot = structuredClone(workflow);
  if (!current && snapshot.run.business) {
    snapshot.run.business.requirements = [];
    snapshot.run.business.chains = [];
  }
  const roots = new Set(set.files.filter((file) => !file.context).map((file) => file.path));
  for (const path of workflow.run.completed) roots.add(path);
  const coverage = session.totalCoverage();
  const data: ReportData = {
    workflow: snapshot, headSha: set.headSha, baseSha: set.comparison?.baseSha,
    repo: session.getRepoName(), scopeLabel: set.label,
    generatedAt: workflow.run.completedAt ?? workflow.run.startedAt ?? session.snapshot?.updatedAt ?? Date.now(),
    coverage: { ...coverage, filesReady: current ? workflow.run.completed.length : 0, filesTotal: roots.size },
    files: set.files.map((file) => ({
      path: file.path,
      findings: session.findings(file.path).filter((finding) => workflowFindingCurrent(file.path, finding)),
      disposition: (id) => session.findingDisposition(file.path, id),
      annotations: session.annotations(file.path),
    })),
    globalReport: current && workflow.run.globalComplete ? session.globalReport : undefined,
    globalDisposition: (spot) => session.globalFixDisposition(spot.id, spot.file, spot.line, spot.anchor),
  };
  return buildReviewReportMarkdown(data, m().report, m().reviewCenter);
}

function centerCommentPreview(): string {
  const comments = session.pendingComments.length ? session.pendingComments : session.conclusion?.inlineComments ?? [];
  if (!comments.length) return '';
  return `## ${m().reviewCenter.pendingComments}\n\n${comments.map((comment) =>
    `### \`${comment.path}:${comment.startLine}${comment.endLine > comment.startLine ? `-${comment.endLine}` : ''}\`\n\n${comment.body}`,
  ).join('\n\n')}`;
}

function centerPreview(notes: string): string {
  return composeReviewReport(centerReportBase(), notes, m().reviewCenter.notes, centerCommentPreview());
}

function centerSubmissionSignature(verdict: ReviewVerdict, notes: string): string {
  const comments = session.pendingComments.length ? session.pendingComments : session.conclusion?.inlineComments ?? [];
  return contentSignature(JSON.stringify({
    verdict, headSha: requireReviewSet().headSha, runId: session.workflow?.run.id,
    body: composeReviewReport(centerReportBase(), notes, m().reviewCenter.notes),
    comments: comments.map(({ path, startLine, endLine, body }) => ({ path, startLine, endLine, body })),
  }));
}

function buildReviewCenterState(): ReviewCenterState {
  const workflow = session.workflow;
  if (!workflow) throw new WorkflowError('noReview');
  const key = `${session.reviewContentVersion}:${centerEpoch}:${reviewCoordinator.version}:${resolveLanguage()}`;
  if (centerStateCache && key === centerStateKey) return { ...centerStateCache, document: centerDocument };
  const blockerText = (verdict: ReviewVerdict) => session.workflowBlockers(verdict).map((item) =>
    `${m().reviewCenter.errors[item.code]}${item.detail ? ` ${item.detail}` : ''}`,
  );
  const extra = centerSubmitting ? [m().reviewCenter.submitting] : reviewCoordinator.editing ? [m().reviewCenter.unsavedEdit] : [];
  const state: ReviewCenterState = {
    version: ++centerEpoch, headSha: requireReviewSet().headSha, baseSha: requireReviewSet().comparison?.baseSha,
    prNumber: /^pr-(\d+)$/.test(requireReviewSet().scopeId) ? Number(requireReviewSet().scopeId.slice(3)) : undefined,
    workflow: {
      ...workflow,
      materials: workflow.materials.map((material) => ({ ...material, snapshots: [] })),
      run: { ...workflow.run, hashes: {}, results: {} },
    }, findings: centerFindings(),
    requirementHtml: Object.fromEntries(workflow.understanding.requirements.map((item) => [item.id, renderRequirementMarkdown(item.text)])),
    reportBase: centerReportBase(), commentPreview: centerCommentPreview(),
    blockers: {
      approve: [...blockerText('approve'), ...extra],
      'request-changes': [...blockerText('request-changes'), ...extra],
      comment: [...blockerText('comment'), ...extra],
    },
    current: workflowResultsCurrent(), requirementsConfirmed: requirementsConfirmed(workflow),
    busy: centerDocumentLoading || reviewCoordinator.busy || centerSubmitting || scopePickInFlight,
    submitting: centerSubmitting, progress: centerSubmitting ? m().reviewCenter.submitting : reviewCoordinator.progress,
    loadingScope: scopePickInFlight,
    document: centerDocument,
  };
  centerStateKey = `${session.reviewContentVersion}:${centerEpoch}:${reviewCoordinator.version}:${resolveLanguage()}`;
  centerStateCache = state;
  return state;
}

async function readWorkflowEvidenceText(path: string): Promise<string> {
  const cwd = requireReviewCwd();
  const set = requireReviewSet();
  const file = session.reviewFile(path);
  if (file?.status === 'deleted') {
    if (!set.comparison) throw new WorkflowError('missingSource', path);
    return readReviewFileAtRef(cwd, set.comparison.baseSha, file.previousPath ?? path);
  }
  if (isBinaryReviewPath(path)) throw new Error(m().reviewCenter.binaryExcluded);
  if (set.headSha !== 'live') {
    const absolute = nodePath.resolve(cwd, path);
    if (!path || nodePath.isAbsolute(path) || !nodePath.relative(cwd, absolute) || nodePath.relative(cwd, absolute).startsWith('..')) {
      throw new Error(m().reviewCenter.outsideRepository);
    }
    return readReviewFileAtRef(cwd, set.headSha, path);
  }
  const uri = await safeRepositoryUri(cwd, path);
  const open = vscode.workspace.textDocuments.find((item) => item.uri.fsPath === uri.fsPath);
  if (open) return open.getText();
  const bytes = await vscode.workspace.fs.readFile(uri);
  return decodeReviewText(bytes);
}

async function validateWorkflowHashes(hashes: Readonly<Record<string, string>>): Promise<boolean> {
  for (const [path, expected] of Object.entries(hashes)) {
    if (contentFingerprint(await readWorkflowEvidenceText(path)) !== expected) return false;
  }
  return true;
}

async function analyzeWorkflowFile(
  path: string, model: vscode.LanguageModelChat, workflow: ReviewWorkflowState, token: vscode.CancellationToken,
): Promise<WorkflowFileResult> {
  if (isBinaryReviewPath(path)) return { kind: 'excluded', reason: m().reviewCenter.binaryExcluded };
  const source = await readWorkflowEvidenceText(path);
  if (isDeletedReviewFile(path)) {
    const stem = nodePath.basename(path).replace(/\.[^.]+$/, '');
    const terms = [path, nodePath.basename(path), stem];
    const references = await findReviewReferenceFiles(requireReviewCwd(), requireReviewSet().headSha, terms);
    const allowed = new Set(await defaultRepositoryEvidenceServices.listReviewablePaths(requireReviewCwd()));
    const candidates = references.filter((file) => allowed.has(file) && file !== path);
    const hashes = { [path]: contentFingerprint(source) };
    for (const file of candidates.slice(0, RELATED_CONTEXT_LIMITS.files - 1)) {
      if (token.isCancellationRequested) throw new WorkflowError('staleResult');
      hashes[file] = contentFingerprint(await readWorkflowEvidenceText(file));
    }
    return {
      kind: 'deleted', hashes,
      limitations: [m().reviewCenter.deletionReferenceBoundary, ...(candidates.length >= RELATED_CONTEXT_LIMITS.files ? [m().analysis.contextBudgetReached(m().analysis.contextLimitReason.files)] : [])],
    };
  }
  const result = await analyzeByPath(path, { model, workflow, token });
  if (!result) throw new WorkflowError('staleResult');
  return result;
}

async function analyzeWorkflowGlobal(
  model: vscode.LanguageModelChat, workflow: ReviewWorkflowState, token: vscode.CancellationToken,
): Promise<GlobalReport> {
  const paths = new Set([
    ...requireReviewSet().files.filter((file) => !isBinaryReviewPath(file.path) && !workflow.run.excluded.some((item) => item.path === file.path)).map((file) => file.path),
    ...Object.keys(workflow.run.hashes),
  ]);
  const context: GlobalContextFile[] = [];
  const hashes: Record<string, string> = {};
  for (const path of paths) {
    if (token.isCancellationRequested) throw new WorkflowError('staleResult');
    const content = await readWorkflowEvidenceText(path);
    const hash = contentFingerprint(content);
    if (workflow.run.hashes[path] && workflow.run.hashes[path] !== hash) throw new WorkflowError('staleResult', path);
    hashes[path] = hash;
    context.push({
      path, content, status: session.reviewFile(path)?.status,
      previousPath: session.reviewFile(path)?.previousPath,
      findings: session.findings(path).filter((finding) => workflowFindingCurrent(path, finding)),
    });
  }
  const report = await analyzeGlobal(model, context, token, workflow);
  if (token.isCancellationRequested || session.workflow?.run.id !== workflow.run.id) throw new WorkflowError('staleResult');
  if (!await validateWorkflowHashes(hashes)) throw new WorkflowError('staleResult');
  await session.updateWorkflow((state) => { Object.assign(state.run.hashes, hashes); });
  return report;
}

async function applyWorkflowGlobal(report: GlobalReport): Promise<void> {
  session.addContextReviewFiles(report.fixSpots.map((spot) => spot.file));
  migrateAppliedGlobalFixes(session.globalReport, report);
  session.setGlobalReport(report);
  const paths = session.reconcileGlobalVerdicts(report);
  await Promise.all(paths.map((path) => refreshDocPanel(path)));
}

async function openCenterSource(path: string, evidenceOnly = false): Promise<void> {
  const workflow = session.workflow;
  if (!workflow || (!session.hasReviewFile(path) && !(evidenceOnly && path in workflow.run.hashes))) {
    throw new WorkflowError('invalidReference', path);
  }
  if (isBinaryReviewPath(path)) { centerNotice(m().reviewCenter.binaryExcluded); return; }
  const scope = workflow.scopeKey;
  const generation = ++openFileGeneration;
  const previous = workbenchSelected;
  if (previous !== path) {
    fixProposalOpenGeneration++;
    FixProposalPanel.closeIfOpen();
    activeDocTranslation?.cts.cancel();
    centerDocument = undefined;
  }
  workbenchSelected = path;
  centerDocumentLoading = true;
  centerEpoch++;
  WorkbenchPanel.refreshIfOpen(previous);
  WorkbenchPanel.refreshIfOpen(path);
  try {
    const text = await readWorkflowEvidenceText(path);
    if (generation !== openFileGeneration || session.workflow?.scopeKey !== scope) return;
    const render = renderFor(path, text);
    const diff = evidenceOnly ? undefined : await buildDocDiff(path, text);
    if (generation !== openFileGeneration || session.workflow?.scopeKey !== scope) return;
    if (diff) docDiffCache.set(path, diff);
    const anchors = await computeFindingAnchors(path, text);
    if (generation !== openFileGeneration || session.workflow?.scopeKey !== scope) return;
    if (session.hasReviewFile(path)) session.setTotalLines(path, render.totalLines);
    const model = buildDocModel(path, render, anchors, diff);
    centerDocument = {
      ...model, evidenceOnly, deleted: isDeletedReviewFile(path),
      renderPlan: sourceRenderPlan(diff?.length ?? model.sourceLines.length, model.sourceLines.length),
      annotationHtml: Object.fromEntries(model.annotations.map((annotation) => [annotation.id, renderRequirementMarkdown(annotation.content)])),
    };
    if (session.workflow.stage !== 'review') await session.updateWorkflow((state) => { state.stage = 'review'; }, false);
  } finally {
    if (generation === openFileGeneration) {
      centerDocumentLoading = false;
      centerEpoch++;
      WorkbenchPanel.refreshNow();
    }
  }
}

async function handleReviewCenter(message: ReviewCenterMessage): Promise<void> {
  const workflow = session.workflow;
  if (!workflow || message.scopeKey !== workflow.scopeKey || message.runId !== workflow.run.id) throw new WorkflowError('staleResult');
  if (centerSubmitting && !['ready', 'seen', 'read-source', 'client-error'].includes(message.action)) throw new Error(m().reviewCenter.submitting);
  switch (message.action) {
    case 'ready':
      reviewCoordinator.setEditor(message.editing);
      WorkbenchPanel.refreshNow();
      return;
    case 'editing': reviewCoordinator.setEditor(message.id); return;
    case 'client-error': throw new Error(message.message);
    case 'seen':
      if (docRenderCache.get(message.path)?.revision === message.revision && session.hasReviewFile(message.path)) session.markSeen(message.path, message.lines);
      return;
    case 'stage': await session.updateWorkflow((state) => { state.stage = message.stage; }, false); return;
    case 'text': await reviewCoordinator.putText(message.label, message.text, message.human); return;
    case 'link': await reviewCoordinator.putLink(message.url); return;
    case 'remove-source': await reviewCoordinator.removeSource(message.id); return;
    case 'understand': await reviewCoordinator.understand(); return;
    case 'cancel': await reviewCoordinator.cancel(); return;
    case 'add-file': {
      reviewCoordinator.assertInputsAvailable();
      const scope = workflow.scopeKey;
      const lifecycle = session.reviewLifecycleVersion;
      const files = await vscode.window.showOpenDialog({
        canSelectMany: false, filters: { 'Markdown / TXT': ['md', 'markdown', 'txt'] }, title: m().reviewCenter.addFile,
      });
      if (!files?.[0]) return;
      const file = files[0];
      const stat = await vscode.workspace.fs.stat(file);
      if (stat.size > 256_000) throw new WorkflowError('materialTooLarge');
      const text = decodeRequirementSource(file.fsPath, await vscode.workspace.fs.readFile(file));
      if (lifecycle !== session.reviewLifecycleVersion || session.workflow?.scopeKey !== scope) throw new WorkflowError('staleResult');
      await reviewCoordinator.putText(nodePath.basename(file.fsPath), text, false, file.fsPath, 'file');
      return;
    }
    case 'read-source': {
      const material = workflow.materials.find((item) => item.id === message.id);
      if (!material) throw new WorkflowError('missingSource');
      const text = materialText(material, message.version);
      WorkbenchPanel.postCenter({
        scopeKey: workflow.scopeKey, type: 'center-source', id: material.id, version: message.version,
        title: fmt(m().reviewCenter.sourceSnapshot, material.label, message.version), html: renderRequirementMarkdown(text), text,
      });
      return;
    }
    case 'revise':
      reviewCoordinator.assertInputsAvailable();
      if (workflow.revision !== message.revision) throw new WorkflowError('staleResult');
      await session.updateWorkflow((state) => reviseReviewRequirement(state, message.id, message.title, message.text));
      if (session.workflow?.scopeKey !== message.scopeKey || session.workflow.run.id !== message.runId) throw new WorkflowError('staleResult');
      reviewCoordinator.setEditor('');
      return;
    case 'include':
      reviewCoordinator.assertInputsAvailable();
      reviewCoordinator.assertNoDraft();
      if (workflow.revision !== message.revision) throw new WorkflowError('staleResult');
      await session.updateWorkflow((state) => includeReviewRequirement(state, message.id, message.included, message.reason));
      return;
    case 'run': await reviewCoordinator.run(message.confirmed, message.resume, message.revision); return;
    case 'verdict':
      if (workflow.verdict !== message.verdict) await session.updateWorkflow((state) => { state.verdict = message.verdict; });
      return;
    case 'notes':
      if (workflow.notes !== message.text) await session.updateWorkflow((state) => { state.notes = message.text; }, workflow.notes.trim() !== message.text.trim());
      return;
    case 'copy': case 'save-report': {
      if (message.notes.length > 64_000 || message.preview !== centerPreview(message.notes)) throw new WorkflowError('confirmationChanged');
      if (message.action === 'copy') {
        try {
          await vscode.env.clipboard.writeText(message.preview);
          centerNotice(m().reviewCenter.copied);
        } catch (error) {
          centerNotice(workflowErrorText(error), true);
          WorkbenchPanel.postCenter({ scopeKey: workflow.scopeKey, type: 'center-copy-fallback', text: message.preview });
        }
      } else {
        const file = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(nodePath.join(homedir(), 'Downloads', `review-${session.getRepoName()}-${requireReviewSet().headSha.slice(0, 8)}.md`)),
          filters: { Markdown: ['md'] }, title: m().reviewCenter.download,
        });
        if (file) { await vscode.workspace.fs.writeFile(file, Buffer.from(message.preview)); centerNotice(m().reviewCenter.saved); }
      }
      return;
    }
    case 'submit': await submitCenterConclusion(message.verdict, message.notes, message.preview); return;
    case 'fix': case 'undo-fix': case 'dispose': {
      reviewCoordinator.assertInputsAvailable();
      const finding = centerFindings().find((item) => item.path === message.path && item.id === message.id && item.ref === message.ref && !!item.global === message.global);
      if (message.action === 'undo-fix') {
        if (!finding?.applied) throw new WorkflowError('invalidReference');
        if (await revertAppliedFix(message.path, message.id)) {
          if (message.global) session.setGlobalFixDisposition(message.id, message.path, finding.line, finding.anchor, null);
          else session.setFindingDisposition(message.path, message.id, null);
          await refreshDocPanel(message.path);
        }
        return;
      }
      if (!finding?.current || !isActionableFinding(finding)) throw new WorkflowError('staleResults');
      await reviewCoordinator.validateCurrentResults();
      if (session.workflow?.scopeKey !== message.scopeKey || session.workflow.run.id !== message.runId) throw new WorkflowError('staleResult');
      if (message.action === 'fix') {
        if (message.global) await openGlobalFix(message.id, message.path, finding.line);
        else await viewFixProposal(message.path, message.id);
      } else if (message.global) await disposeGlobalFix(message.id, message.path, finding.line, message.kind);
      else await disposeFinding(message.path, message.id, message.kind);
      return;
    }
    case 'evidence':
      await openCenterSource(message.path, true);
      if (centerDocument?.path === message.path) WorkbenchPanel.postCenter({
        scopeKey: workflow.scopeKey, type: 'center-reveal', path: message.path, revision: centerDocument.revision, line: message.line,
      });
      return;
    case 'open-document':
      if (!centerDocument || centerDocument.path !== message.path || centerDocument.evidenceOnly) throw new Error(m().reviewCenter.invalidAction);
      DocumentPanel.show({ ...centerDocument, findings: [] }, docActions());
      return;
    case 'remove-annotation':
      if (!session.hasReviewFile(message.path)) throw new WorkflowError('invalidReference');
      session.removeAnnotation(message.path, message.id);
      await refreshDocPanel(message.path);
      return;
    case 'document-action': {
      const source = centerDocument;
      if (!source || source.path !== message.path || source.revision !== message.revision || source.evidenceOnly || source.deleted) throw new WorkflowError('staleResult');
      if (message.command === 'translateWhole') { await translateWholeDoc(message.path); return; }
      const selected = source.raw.slice(message.start - 1, message.end).join('\n');
      if (message.start < 1 || message.end < message.start || message.end > source.raw.length || !message.text.trim() || !selected.includes(message.text)) throw new WorkflowError('invalidReference');
      if (message.command === 'translate') await annotateWithTranslation(message.path, message.start, message.end, message.text);
      else if (message.command === 'explain') await annotateWithExplanation(message.path, message.start, message.end, message.text);
      else if (message.command === 'note') await annotateWithNote(message.path, message.start, message.end, message.text);
      else await addPrComment(message.path, message.start, message.end, message.text);
      return;
    }
  }
}

function buildWorkbenchState(changedPaths?: ReadonlySet<string>): WorkbenchState {
  const reviewSet = session.reviewSet;
  const structureVersion = session.reviewStructureVersion;
  if (workbenchFilesVersion !== structureVersion) {
    workbenchFilesCache = (reviewSet?.files ?? []).map(buildWorkbenchFile);
    workbenchFileIndex.clear();
    workbenchFilesCache.forEach((file, index) => workbenchFileIndex.set(file.path, index));
    workbenchFilesVersion = structureVersion;
  } else {
    for (const path of changedPaths ?? []) {
      const index = workbenchFileIndex.get(path);
      const reviewFile = session.reviewFile(path);
      if (index !== undefined && reviewFile) {
        Object.assign(workbenchFilesCache[index], buildWorkbenchFile(reviewFile));
      }
    }
  }

  const selectedFindings = workbenchSelected
    ? session.findings(workbenchSelected).map((f) => {
        const d = session.findingDisposition(workbenchSelected!, f.id);
        return {
          id: f.id,
          line: f.line,
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          suggestion: f.suggestion,
          disposition: d?.kind,
          dispositionReason: d?.reason,
          verificationStatus: f.verification?.status,
          verificationRationale: f.verification?.rationale,
          verificationEvidence: f.verification?.evidence,
        };
      })
    : [];

  const state: WorkbenchState = {
    structureVersion,
    label: reviewSet?.label ?? m().review.notStarted,
    files: workbenchFilesCache,
    selected: workbenchSelected,
    findings: selectedFindings,
    coverage: session.totalCoverage(),
    gatePassed: session.gatePassed(),
    globalDone: session.globalConfirmed,
    hasGlobalReport: !!session.globalReport,
    modelLabel: models.label,
    repoName: session.getRepoName(),
    branch: currentBranchLabel,
    projects: (vscode.workspace.workspaceFolders ?? []).map((f) => ({
      cwd: f.uri.fsPath,
      name: f.name,
      current: f.uri.fsPath === session.getCwd(),
    })),
    languages: ((cur) => [
      { id: 'en', label: m().workbench.langEn, current: cur === 'en' },
      { id: 'zh-CN', label: m().workbench.langZh, current: cur === 'zh-CN' },
      { id: 'auto', label: m().workbench.langAuto, current: cur === 'auto' },
    ])(vscode.workspace.getConfiguration('codereview').get<string>('language', 'en')),
    tokenUsage: session.tokenUsage
      ? {
          input: session.tokenUsage.totalInput,
          output: session.tokenUsage.totalOutput,
          calls: session.tokenUsage.calls,
          byOp: session.tokenUsage.byOp,
        }
      : undefined,
    conclusion: session.conclusion && (!session.workflow || session.conclusion.bodySignature === centerSubmissionSignature(session.conclusion.verdict, session.workflow.notes))
      ? {
          verdict: session.conclusion.verdict,
          label: session.conclusion.label,
          target: session.conclusion.target,
          prNumber: session.conclusion.prNumber,
          submittedAt: session.conclusion.submittedAt,
        }
      : undefined,
  };
  if (session.workflow) state.center = buildReviewCenterState();
  return state;
}

/** Opens a review file in the document webview beside the workbench. */
async function openFileInPanel(relPath: string): Promise<void> {
  if (session.workflow) {
    try { await openCenterSource(relPath); }
    catch (error) { centerNotice(workflowErrorText(error), true); }
    return;
  }
  if (!ensureReviewPath(relPath, m().actions.open)) {
    return;
  }
  // Switching to a different file invalidates any open fix-proposal panel
  // (it's scoped to one finding in the file we're leaving).
  const previousSelected = workbenchSelected;
  if (previousSelected !== relPath) {
    fixProposalOpenGeneration += 1;
    FixProposalPanel.closeIfOpen();
    // Cancel the leaving file's in-flight bilingual translation so it doesn't
    // keep running (and piling up) after we navigate away.
    if (activeDocTranslation && activeDocTranslation.path !== relPath) {
      activeDocTranslation.cts.cancel();
    }
  }
  workbenchSelected = relPath;
  DocumentPanel.beginLoading(relPath);
  if (previousSelected) {
    WorkbenchPanel.refreshIfOpen(previousSelected);
  }
  WorkbenchPanel.refreshIfOpen(relPath);
  // Race guard: rapid clicks must not pile up heavy renders or let a slow,
  // already-superseded open overwrite the panel. Each call claims a token; after
  // every await we bail if a newer click has taken over.
  const myGeneration = ++openFileGeneration;
  // Reapply the 3:7 split not just on the very first open, but whenever the
  // document panel was closed and is being recreated as a fresh 50/50 group.
  const docWasOpen = DocumentPanel.isOpen;
  const needLayout = !layoutAppliedForCurrentReview || !docWasOpen;
  if (needLayout) {
    WorkbenchPanel.setBusy(true, m().workbench.openingFile);
  }
  try {
  const text = await readReviewFileText(relPath, true);
  if (myGeneration !== openFileGeneration) {
    return; // a newer click superseded us — skip the expensive render + show.
  }
  const render = renderFor(relPath, text);
  if (myGeneration !== openFileGeneration) {
    return; // rendering may have yielded; bail before overwriting the panel.
  }
  const cachedDiff = docDiffCache.get(relPath);
  session.setTotalLines(relPath, render.totalLines);
  const anchors = await computeFindingAnchors(relPath, text);
  if (myGeneration !== openFileGeneration) {
    return; // anchoring may have yielded; bail before overwriting the panel.
  }
  const initialModel = buildDocModel(relPath, render, anchors, cachedDiff);
  if (!cachedDiff && session.reviewSet?.comparison && !session.reviewFile(relPath)?.context) {
    initialModel.defaultToDiff = false;
  }
  DocumentPanel.show(initialModel, docActions());
  void ensureDocLocalized(relPath);
  if (!cachedDiff && session.reviewSet?.comparison && !session.reviewFile(relPath)?.context) {
    void buildAndAttachDocDiff(relPath, text, myGeneration);
  }
  // Showing the document beside the workbench just created the second editor
  // group. Apply the narrow-workbench / wide-document split once per review now
  // that there is real content to size — rather than pre-creating an empty group
  // when the workbench opens (which would linger as a blank watermark frame).
  if (needLayout) {
    layoutAppliedForCurrentReview = true;
    await applyWorkbenchLayout();
  }
  } catch (err) {
    if (myGeneration === openFileGeneration) {
      workbenchSelected = previousSelected;
      WorkbenchPanel.refreshIfOpen(relPath);
      if (previousSelected) {
        WorkbenchPanel.refreshIfOpen(previousSelected);
      }
      DocumentPanel.restoreTitle();
      const message = String((err as Error)?.message ?? err);
      if (!WorkbenchPanel.flashNotice(m().review.error(message), 'error')) {
        void vscode.window.showErrorMessage(m().review.error(message));
      }
    }
  } finally {
    if (needLayout) {
      WorkbenchPanel.setBusy(false);
    }
  }
}

async function buildAndAttachDocDiff(
  relPath: string,
  text: string,
  generation: number,
): Promise<void> {
  // Let the lightweight file model paint before base-file I/O and diff work.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const diffLines = await buildDocDiff(relPath, text);
  if (
    generation !== openFileGeneration
    || DocumentPanel.currentPath !== relPath
    || !diffLines
  ) {
    return;
  }
  docDiffCache.set(relPath, diffLines);
  DocumentPanel.setDiff(relPath, diffLines, true);
}

/** Renders (and caches) the highlighted/markdown content for a file. */
function renderFor(relPath: string, text: string): DocumentRender {
  const cached = docRenderCache.get(relPath);
  if (cached) {
    return cached;
  }
  const languageId = languageIdFor(relPath);
  const render = renderDocument(text, languageId, relPath.split('/').pop() ?? relPath);
  docRenderCache.set(relPath, render);
  return render;
}

/** Guesses a VS Code-style languageId from a file extension. */
function languageIdFor(relPath: string): string {
  const ext = relPath.includes('.') ? relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase() : '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
    cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'cpp', py: 'python', java: 'java',
    go: 'go', rs: 'rust', rb: 'ruby', php: 'php', sh: 'shellscript', ps1: 'powershell',
    sql: 'sql', json: 'json', jsonc: 'jsonc', yml: 'yaml', yaml: 'yaml', xml: 'xml',
    html: 'html', vue: 'vue', css: 'css', scss: 'scss', less: 'less', md: 'markdown',
    markdown: 'markdown', ini: 'ini', toml: 'toml',
  };
  return map[ext] ?? ext;
}

/** Builds syntax-highlighted rows for an uncollapsed base-to-head file diff. */
async function buildDocDiff(
  relPath: string,
  headText: string,
): Promise<DocDiffLine[] | undefined> {
  const reviewSet = session.reviewSet;
  const comparison = reviewSet?.comparison;
  const file = session.reviewFile(relPath);
  const cwd = activeCwd();
  if (!comparison || !file || file.context || !cwd) {
    return undefined;
  }

  const basePath = file.previousPath ?? file.path;
  let baseText: string | undefined;
  let baseRender: DocumentRender | undefined;
  if (file.status !== 'added') {
    const cacheKey = `${comparison.baseSha}:${basePath}`;
    if (!baseTextCache.has(cacheKey)) {
      const loaded = session.workflow
        ? await readReviewFileAtRef(cwd, comparison.baseSha, basePath)
        : await readFileAtRef(cwd, comparison.baseSha, basePath);
      baseTextCache.set(cacheKey, loaded ?? null);
    }
    baseText = baseTextCache.get(cacheKey) ?? undefined;
    if (baseText === undefined) {
      return undefined;
    }
    baseRender = baseRenderCache.get(cacheKey);
    if (!baseRender) {
      baseRender = renderDocument(
        baseText,
        languageIdFor(basePath),
        basePath.split('/').pop() ?? basePath,
      );
      baseRenderCache.set(cacheKey, baseRender);
    }
  }

  const headSideText = file.status === 'deleted' ? undefined : headText;
  if (baseText?.includes('\0') || headSideText?.includes('\0')) {
    return undefined;
  }

  return buildFullFileDiff(baseText, headSideText).map((line) => ({
    kind: line.kind,
    oldLine: line.oldLine,
    newLine: line.newLine,
    html: line.kind === 'deleted'
      ? baseRender?.sourceLines[(line.oldLine ?? 1) - 1] ?? ''
      : undefined,
  }));
}

/** Builds the serializable model the document webview renders. */
function buildDocModel(
  relPath: string,
  render: DocumentRender,
  anchors?: Map<string, { line: number; endLine: number }>,
  diffLines?: DocDiffLine[],
): DocModel {
  const state = session.fileState(relPath);
  const rawLines = render.raw;
  const lang = resolveLanguage();
  const findings = localizeFindingsNow(relPath, session.findings(relPath), lang);
  const annotations = localizeAnnotationsNow(relPath, session.annotations(relPath), lang);
  return {
    path: relPath,
    revision: render.revision,
    name: relPath.split('/').pop() ?? relPath,
    isMarkdown: render.isMarkdown,
    readingHtml: render.readingHtml,
    sourceLines: render.sourceLines,
    raw: rawLines,
    diffLines,
    defaultToDiff: !!session.reviewSet?.comparison && !session.reviewFile(relPath)?.context,
    seen: state?.seenLines ?? [],
    findings: findings.map((f) => {
      const d = session.findingDisposition(relPath, f.id);
      // If a Copilot fix was applied, the finding's snapshot line is stale — the
      // edit shifted the file. Re-anchor the inline card to the fix's current
      // content (start + last line), so the card follows the modified code
      // instead of staying pinned to the old line number. `anchors` is computed
      // from the live document (same source as the locate action), so card and
      // locate always agree.
      const a = anchors?.get(f.id);
      return {
        id: f.id,
        line: a?.line ?? f.line,
        endLine: a?.endLine ?? f.endLine,
        severity: f.severity,
        title: f.title,
        detail: f.detail,
        suggestion: f.suggestion,
        disposition: d?.kind,
        dispositionReason: d?.reason,
        verificationStatus: f.verification?.status,
        verificationRationale: f.verification?.rationale,
        verificationEvidence: f.verification?.evidence,
        // The line is an estimate when the finding HAS an anchor snippet but it
        // could not be located (no `anchors` entry) — we fell back to the model's
        // reported line, which may be wrong. No anchor at all = nothing to verify
        // against, so we don't flag it.
        estimatedLine: !!f.anchor && !a,
      };
    }),
    annotations: annotations.map((a) => ({
      id: a.id,
      kind: a.kind,
      startLine: a.startLine,
      endLine: a.endLine,
      sourceText: a.sourceText,
      content: a.content,
    })),
    analyzing: analyzingPaths.has(relPath),
    translationHtml: workspaceMemento?.get<Record<string, string>>(DOC_TR_KEY)?.[docTranslationKey(relPath, render.raw.join('\n'))],
  };
}

/**
 * Computes live-document anchors for findings in a file. Reads the file text
 * once and, per finding, locates either the applied fix's current `newText` or
 * (when no fix is applied) the finding's verbatim `anchor` snippet, returning a
 * map of findingId → 1-based start/last line. Findings whose snippet can no
 * longer be found are omitted, so callers fall back to the stored snapshot
 * lines. This keeps the inline card's line in sync with the real code and with
 * the 「定位」 action, instead of the model's (sometimes wrong) reported line.
 */
async function computeFindingAnchors(
  relPath: string,
  currentText?: string,
): Promise<Map<string, { line: number; endLine: number }>> {
  const anchors = new Map<string, { line: number; endLine: number }>();
  const findings = session.findings(relPath);
  if (findings.length === 0) {
    return anchors;
  }
  const cwd = activeCwd();
  if (!cwd) {
    return anchors;
  }
  try {
    const docLines = currentText !== undefined
      ? currentText.split(/\r?\n/)
      : (await readReviewFileText(relPath)).split(/\r?\n/);
    for (const f of findings) {
      const edit = getAppliedFix(relPath, f.id);
      // Anchor the inline card to real code: prefer an applied fix's current
      // text, otherwise the finding's verbatim `anchor` snippet. This keeps the
      // card's line in sync with the actual code (and with the 「定位」 action),
      // instead of the model's reported line number which can be off.
      const snippet = edit?.newText ?? f.anchor;
      if (!snippet) {
        continue;
      }
      const hit = locateSnippetLines(docLines, snippet, f.line);
      if (hit) {
        anchors.set(f.id, hit);
      }
    }
  } catch (err) {
    console.warn('[codereview] computeFindingAnchors failed:', err);
  }
  return anchors;
}

/**
 * Locates a multi-line snippet inside a document by *line* content, returning
 * its 1-based start and last line. Matching is layered, mirroring the fix-panel
 * apply matcher so finding anchors locate as reliably as fixes do:
 *   1. strict  — trailing-whitespace-insensitive (exact content);
 *   2. tolerant — trim both ends (indentation drift, common when the model
 *      re-emits the snippet with different leading spaces);
 *   3. punct   — also ignore a trailing comma/semicolon (model drops the file's
 *      "}," → "}" on a boundary line).
 * Each layer is tried whole before the next; the first match wins (anchors are
 * meant to be unique). EOL- and trailing-whitespace insensitive throughout,
 * essential because an applied edit's `\n` text may be normalised to CRLF on
 * save. Leading/trailing blank lines in the snippet are ignored. Returns
 * undefined when no layer matches.
 */
function locateSnippetLines(
  docLines: string[],
  snippet: string,
  preferredLine?: number,
): { line: number; endLine: number } | undefined {
  const rawNeedle = snippet.split(/\r?\n/).filter((l, i, arr) => {
    // drop leading/trailing blank lines but keep interior ones
    const before = arr.slice(0, i).every((x) => x.trim() === '');
    const after = arr.slice(i + 1).every((x) => x.trim() === '');
    return !(l.trim() === '' && (before || after));
  });
  if (rawNeedle.length === 0) {
    return undefined;
  }
  const trimEnd = (l: string) => l.replace(/\s+$/, '');
  const trimBoth = (l: string) => l.trim();
  const trimPunct = (l: string) => l.trim().replace(/[,;]$/, '');
  for (const norm of [trimEnd, trimBoth, trimPunct]) {
    const needle = rawNeedle.map(norm);
    const hay = docLines.map(norm);
    const matches: Array<{ line: number; endLine: number }> = [];
    for (let i = 0; i + needle.length <= hay.length; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) {
        if (hay[i + j] !== needle[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        matches.push({ line: i + 1, endLine: i + needle.length });
      }
    }
    if (matches.length > 0) {
      return preferredLine === undefined
        ? matches[0]
        : matches.reduce((best, match) =>
            Math.abs(match.line - preferredLine) < Math.abs(best.line - preferredLine)
              ? match
              : best,
          );
    }
  }
  return undefined;
}

/** Pushes an updated model into the document panel if it shows this file. */
async function refreshDocPanel(relPath: string): Promise<void> {
  if (session.workflow && centerDocument?.path === relPath) {
    const render = docRenderCache.get(relPath);
    if (render) {
      const anchors = await computeFindingAnchors(relPath);
      if (centerDocument?.path === relPath) {
        const model = buildDocModel(relPath, render, anchors, docDiffCache.get(relPath));
        centerDocument = {
          ...centerDocument, ...model,
          annotationHtml: Object.fromEntries(model.annotations.map((annotation) => [annotation.id, renderRequirementMarkdown(annotation.content)])),
        };
        centerEpoch++;
        WorkbenchPanel.refreshNow();
      }
    }
  }
  const render = docRenderCache.get(relPath);
  if (render && DocumentPanel.currentPath === relPath) {
    const anchors = await computeFindingAnchors(relPath);
    if (DocumentPanel.currentPath !== relPath) {
      return;
    }
    const model = buildDocModel(relPath, render, anchors, docDiffCache.get(relPath));
    DocumentPanel.update(session.workflow ? { ...model, findings: [] } : model);
    void ensureDocLocalized(relPath);
  }
}

/**
 * Re-reads the file from disk / dirty editor, re-renders, and refreshes the
 * document panel so the user sees the new content immediately after an edit
 * (e.g. a Copilot fix was applied).
 */
async function reloadDocPanel(relPath: string): Promise<void> {
  if (session.workflow && centerDocument?.path === relPath) {
    docRenderCache.delete(relPath);
    docDiffCache.delete(relPath);
    await openCenterSource(relPath, centerDocument.evidenceOnly);
  }
  if (!isReviewPath(relPath)) {
    docRenderCache.delete(relPath);
    docDiffCache.delete(relPath);
    return;
  }
  if (DocumentPanel.currentPath !== relPath) {
    docRenderCache.delete(relPath);
    docDiffCache.delete(relPath);
    return;
  }
  docRenderCache.delete(relPath);
  docDiffCache.delete(relPath);
  const text = await readReviewFileText(relPath);
  const render = renderFor(relPath, text);
  const diffLines = await buildDocDiff(relPath, text);
  if (diffLines) {
    docDiffCache.set(relPath, diffLines);
  }
  session.setTotalLines(relPath, render.totalLines);
  const anchors = await computeFindingAnchors(relPath);
  if (DocumentPanel.currentPath !== relPath) {
    return;
  }
  DocumentPanel.update(buildDocModel(relPath, render, anchors, diffLines));
  void ensureDocLocalized(relPath);
}

/**
 * Reverts an applied Copilot fix by replacing newText with oldText in the file.
 * Falls back to a warning when the snippet can no longer be uniquely located
 * (file was edited by hand after applying). Returns whether the revert happened.
 */
async function revertAppliedFix(rel: string, findingId: string): Promise<boolean> {
  if (!ensureReviewPath(rel, m().actions.revertFix)) {
    return false;
  }
  const appliedFixKey = fixKey(rel, findingId);
  const legacyAppliedFixKey = legacyFixKey(rel, findingId);
  const edit = getAppliedFix(rel, findingId);
  if (!edit) {
    return false;
  }
  const cwd = activeCwd();
  if (!cwd) {
    return false;
  }
  const fileUri = session.workflow ? await safeRepositoryUri(cwd, rel) : vscode.Uri.joinPath(vscode.Uri.file(cwd), rel);
  try {
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const text = doc.getText();
    const idx = text.indexOf(edit.newText);
    if (idx < 0) {
      void vscode.window.showWarningMessage(m().fix.revertNotFound);
      return false;
    }
    if (text.indexOf(edit.newText, idx + 1) >= 0) {
      void vscode.window.showWarningMessage(m().fix.revertAmbiguous);
      return false;
    }
    const start = doc.positionAt(idx);
    const end = doc.positionAt(idx + edit.newText.length);
    const we = new vscode.WorkspaceEdit();
    we.replace(fileUri, new vscode.Range(start, end), edit.oldText);
    const ok = await vscode.workspace.applyEdit(we);
    if (ok) {
      deleteAppliedFixKeys(appliedFixKey, legacyAppliedFixKey);
      await reloadDocPanel(rel);
    }
    return ok;
  } catch (err) {
    console.warn('[codereview] revertAppliedFix failed:', err);
    return false;
  }
}

/** Wires the document webview's actions back to the session / model. */
function docActions() {
  return {
    seen: (path: string, lines: number[]) => session.markSeen(path, lines),
    translate: (path: string, startLine: number, endLine: number, text: string) =>
      void annotateWithTranslation(path, startLine, endLine, text).catch(reportError),
    translateWhole: (path: string) => void translateWholeDoc(path).catch(reportError),
    explain: (path: string, startLine: number, endLine: number, text: string) =>
      void annotateWithExplanation(path, startLine, endLine, text).catch(reportError),
    note: (path: string, startLine: number, endLine: number, text: string) =>
      void annotateWithNote(path, startLine, endLine, text),
    comment: (path: string, startLine: number, endLine: number, text: string) =>
      void addPrComment(path, startLine, endLine, text),
    removeAnnotation: (path: string, id: string) => {
      session.removeAnnotation(path, id);
      refreshDocPanel(path);
    },
    regenerateAnnotation: (path: string, id: string) => void regenerateAnnotation(path, id),
    convertAnnotationToNote: (path: string, id: string) => {
      session.updateAnnotation(path, id, { kind: 'note' });
      refreshDocPanel(path);
      transientInfo(m().analysis.convertedToNote);
    },
    editAnnotation: (path: string, id: string, content: string) => {
      session.updateAnnotation(path, id, { content });
      refreshDocPanel(path);
    },
    disposeFinding: (path: string, id: string, kind: FindingDispositionKind) => {
      void disposeFinding(path, id, kind);
    },
    viewFix: (path: string, id: string, cachedOnly?: boolean) =>
      void viewFixProposal(path, id, cachedOnly),
    locate: (path: string, line: number, endLine?: number, findingId?: string) =>
      void locateInFile(path, line, endLine, findingId),
    analyze: (path: string) => void analyzeByPath(path),
    jumpNext: (path: string) => jumpToNextUnseen(path),
    focusTree: () => WorkbenchPanel.focusTree(),
  };
}

function newAnnotationId(): string {
  return `anno-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Adds a manual PR review comment as a local draft (pending-review model). The
 * comment is not posted immediately; it is accumulated and submitted together
 * with the conclusion. Only available while reviewing a PR.
 */
async function canPostInlineComment(path: string, start: number, end: number): Promise<boolean> {
  const set = requireReviewSet();
  const file = session.reviewFile(path);
  if (!file || file.context || file.status === 'deleted' || !set.comparison) return false;
  const ranges = await reviewCommentRanges(requireReviewCwd(), set.comparison.baseSha, set.headSha, file);
  return ranges.some((range) => start >= range.start && end <= range.end);
}

async function addPrComment(
  relPath: string,
  startLine: number,
  endLine: number,
  selectedText: string,
): Promise<void> {
  const current = annotationOwner(relPath);
  if (!session.reviewSet) {
    transientWarning(m().review.notStartedWarn);
    return;
  }
  if (!/^pr-\d+$/.test(session.reviewSet.scopeId)) {
    transientWarning(m().documentPanel.commentNotPr);
    return;
  }
  const loc = endLine > startLine ? `${relPath}:${startLine}-${endLine}` : `${relPath}:${startLine}`;
  const input = vscode.window.createInputBox();
  input.title = loc;
  input.prompt = m().documentPanel.commentPrompt;
  input.placeholder = m().documentPanel.commentPlaceholder;
  input.ignoreFocusOut = true;
  const aiButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('sparkle'),
    tooltip: m().documentPanel.commentAiExpand,
  };
  input.buttons = [aiButton];
  const cts = new vscode.CancellationTokenSource();
  const body = await new Promise<string | undefined>((resolve) => {
    input.onDidTriggerButton(async (btn) => {
      if (btn !== aiButton) {
        return;
      }
      const point = input.value.trim();
      if (!point) {
        input.validationMessage = m().documentPanel.commentAiNeedsPoint;
        return;
      }
      const model = await models.resolve();
      if (!model) {
        input.validationMessage = m().model.noModel;
        return;
      }
      input.validationMessage = undefined;
      input.busy = true;
      input.enabled = false;
      try {
        const expanded = (await draftReviewComment(model, selectedText, point, cts.token)).trim();
        if (expanded) {
          input.value = expanded;
        }
      } catch (err) {
        input.validationMessage = String((err as Error)?.message ?? err);
      } finally {
        input.busy = false;
        input.enabled = true;
      }
    });
    input.onDidAccept(() => {
      if (input.value.trim()) {
        resolve(input.value.trim());
        input.hide();
      } else {
        input.validationMessage = m().documentPanel.commentEmpty;
      }
    });
    input.onDidHide(() => resolve(undefined));
    input.show();
  });
  cts.cancel();
  cts.dispose();
  input.dispose();
  if (!body) {
    return;
  }
  if (!current()) { centerNotice(m().reviewCenter.changedDuringReview, true); return; }
  const inline = !session.workflow || await canPostInlineComment(relPath, startLine, endLine);
  if (!current()) { centerNotice(m().reviewCenter.changedDuringReview, true); return; }
  if (!inline) {
    recordLocalCommentNote(relPath, { line: startLine, endLine, anchor: selectedText, title: m().reviewCenter.reviewComment, detail: body });
    centerNotice(m().reviewCenter.commentInBody);
    return;
  }
  session.addPendingComment({
    id: `cmt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    path: relPath,
    startLine,
    endLine,
    body,
    source: 'manual',
    createdAt: Date.now(),
  });
  transientInfo(`${m().documentPanel.commentAdded} (${session.pendingComments.length})`);
}

/** Persisted cache of whole-document translations for the side-by-side view (path → translated reading HTML). */
const DOC_TR_KEY = 'codereview.docTranslation.v3';

function docTranslationKey(path: string, text: string): string {
  return session.workflow ? `${session.workflow.repositoryKey}:${path}:${contentSignature(text.replace(/\r\n/g, '\n'))}` : path;
}

/**
 * Translates a whole Markdown document once and renders it to reading HTML for
 * the RIGHT column of the side-by-side bilingual view. The original (left column)
 * is never touched. Persisted per path so re-opening is instant. No per-block
 * alignment — the whole doc is translated as one Markdown document.
 */
async function translateWholeDoc(path: string): Promise<void> {
  const current = annotationOwner(path);
  const text = await readReviewFileText(path);
  if (!current()) throw new WorkflowError('staleResult');
  const key = docTranslationKey(path, text);
  const store = workspaceMemento?.get<Record<string, string>>(DOC_TR_KEY) ?? {};
  if (store[key]) {
    DocumentPanel.postWholeTranslation(path, store[key], true);
    await refreshDocPanel(path);
    return;
  }
  // De-dupe: a translation for THIS file is already running (e.g. the reviewer
  // toggled reading/source repeatedly before it finished). Don't start another.
  if (activeDocTranslation?.path === path && !activeDocTranslation.cts.token.isCancellationRequested) {
    return;
  }
  // Switching files: cancel the previous file's in-flight translation so stale
  // translations don't pile up and compete for the model.
  activeDocTranslation?.cts.cancel();
  activeDocTranslation?.cts.dispose();
  if (!text.trim()) {
    activeDocTranslation = undefined;
    return;
  }
  const cts = new vscode.CancellationTokenSource();
  activeDocTranslation = { path, cts };
  try {
    const model = await models.resolve();
    if (!model) throw new AnalysisError(m().model.noModel);
    if (!current() || cts.token.isCancellationRequested) return;
    let lastPost = 0;
    const translated = await translateMarkdown(model, text, cts.token, (acc) => {
      if (cts.token.isCancellationRequested || !current()) {
        return;
      }
      // Stream the accumulating translation to the right column (throttled).
      const now = Date.now();
      if (now - lastPost > 120) {
        lastPost = now;
        DocumentPanel.postWholeTranslation(path, acc, false);
      }
    });
    if (cts.token.isCancellationRequested || !current()) {
      return;
    }
    const html = renderDocument(translated, 'markdown', path.split('/').pop() ?? path).readingHtml ?? '';
    store[key] = html;
    await workspaceMemento?.update(DOC_TR_KEY, store);
    DocumentPanel.postWholeTranslation(path, html, true);
    await refreshDocPanel(path);
  } catch (err) {
    if (!cts.token.isCancellationRequested) {
      DocumentPanel.flashNotice(path, String((err as Error)?.message ?? err), 'error');
      centerNotice(workflowErrorText(err), true);
    }
  } finally {
    if (activeDocTranslation?.cts === cts) {
      activeDocTranslation = undefined;
    }
    cts.dispose();
  }
}

/** Translates the selected text and stores it as a persisted annotation. */

async function annotateWithTranslation(
  path: string,
  startLine: number,
  endLine: number,
  text: string,
): Promise<void> {
  const current = annotationOwner(path);
  // Reuse an existing translation for the same selection (see explanation note).
  const existing = findAnnotation(path, 'translate', text, startLine);
  if (existing) {
    DocumentPanel.setAiBusy(path, false);
    await refreshDocPanel(path);
    if (existing.endLine > 0) {
      DocumentPanel.scrollTo(existing.startLine, existing.endLine);
    }
    transientInfo(m().analysis.reuseTranslation);
    return;
  }
  const model = await models.resolve();
  if (!model) {
    DocumentPanel.setAiBusy(path, false);
    void vscode.window.showErrorMessage(m().model.noModel);
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: m().analysis.translating, cancellable: true },
    async (_p, token) => {
      try {
        const content = await translateSelection(model, text, token);
        if (!current()) { centerNotice(m().reviewCenter.changedDuringReview, true); return; }
        const annotation: Annotation = {
          id: newAnnotationId(),
          kind: 'translate',
          startLine,
          endLine,
          sourceText: text,
          content,
          createdAt: Date.now(),
        };
        session.addAnnotation(path, annotation);
        refreshDocPanel(path);
      } catch (err) {
        reportError(err);
      } finally {
        DocumentPanel.setAiBusy(path, false);
      }
    },
  );
}

/**
 * Re-runs the model for an existing AI annotation (translate/explain): removes
 * the current one, then regenerates from its stored `sourceText`. Lets the
 * reviewer get a fresh answer when unhappy with the current one, without having
 * to re-select the code. No-op for note annotations (not model-generated).
 */
async function regenerateAnnotation(path: string, id: string): Promise<void> {
  const existing = session.annotations(path).find((a) => a.id === id);
  if (!existing || (existing.kind !== 'explain' && existing.kind !== 'translate')) {
    return;
  }
  const { kind, startLine, endLine, sourceText } = existing;
  // Drop the old one first so the reuse short-circuit doesn't just re-show it.
  session.removeAnnotation(path, id);
  DocumentPanel.setAiBusy(path, true);
  if (kind === 'explain') {
    await annotateWithExplanation(path, startLine, endLine, sourceText);
  } else {
    await annotateWithTranslation(path, startLine, endLine, sourceText);
  }
}

/**
 * Finds an existing annotation of `kind` for the same selection, so repeated
 * explain/translate clicks reuse the saved result instead of appending a new
 * (differently-worded) one. Matches on the verbatim selection text; when a line
 * is known, also requires the start line to match so identical text at two
 * different places stays distinct.
 */
function findAnnotation(
  path: string,
  kind: Annotation['kind'],
  sourceText: string,
  startLine: number,
): Annotation | undefined {
  const needle = sourceText.trim();
  if (!needle) {
    return undefined;
  }
  return session
    .annotations(path)
    .find(
      (a) =>
        a.kind === kind &&
        a.sourceText.trim() === needle &&
        (startLine <= 0 || a.startLine <= 0 || a.startLine === startLine),
    );
}

/** Explains the selected code and stores it as a persisted annotation. */
async function annotateWithExplanation(
  path: string,
  startLine: number,
  endLine: number,
  text: string,
): Promise<void> {
  const current = annotationOwner(path);
  // Reuse an existing explanation for the same selection instead of calling the
  // model again (which would append a second, differently-worded card). The
  // result is persisted, so the saved one is what the user asked to "explain".
  const existing = findAnnotation(path, 'explain', text, startLine);
  if (existing) {
    DocumentPanel.setAiBusy(path, false);
    await refreshDocPanel(path);
    if (existing.endLine > 0) {
      DocumentPanel.scrollTo(existing.startLine, existing.endLine);
    }
    transientInfo(m().analysis.reuseExplanation);
    return;
  }
  const model = await models.resolve();
  if (!model) {
    DocumentPanel.setAiBusy(path, false);
    void vscode.window.showErrorMessage(m().model.noModel);
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: m().analysis.explaining, cancellable: true },
    async (_p, token) => {
      try {
        const content = await explainCode(model, text, token);
        if (!current()) { centerNotice(m().reviewCenter.changedDuringReview, true); return; }
        const annotation: Annotation = {
          id: newAnnotationId(),
          kind: 'explain',
          startLine,
          endLine,
          sourceText: text,
          content,
          createdAt: Date.now(),
        };
        session.addAnnotation(path, annotation);
        refreshDocPanel(path);
      } catch (err) {
        reportError(err);
      } finally {
        DocumentPanel.setAiBusy(path, false);
      }
    },
  );
}

/** Prompts for note text and stores it as a persisted annotation. */
async function annotateWithNote(
  path: string,
  startLine: number,
  endLine: number,
  text: string,
): Promise<void> {
  const current = annotationOwner(path);
  const note = await vscode.window.showInputBox({
    title: m().annotation.addTitle,
    prompt: startLine > 0 ? m().annotation.linePrompt(startLine, endLine) : m().annotation.selectionPrompt,
    placeHolder: m().annotation.placeholder,
  });
  if (!note) {
    return;
  }
  if (!current()) { centerNotice(m().reviewCenter.changedDuringReview, true); return; }
  const annotation: Annotation = {
    id: newAnnotationId(),
    kind: 'note',
    startLine,
    endLine,
    sourceText: text,
    content: note,
    createdAt: Date.now(),
  };
  session.addAnnotation(path, annotation);
  refreshDocPanel(path);
}

/**
 * Reads the current text of a review file, preferring an already-open document
 * (which includes unsaved edits) over the on-disk copy.
 */
async function readReviewFileText(relPath: string, strict = false): Promise<string> {
  if (session.workflow) {
    if (!session.hasReviewFile(relPath)) throw new WorkflowError('invalidReference', relPath);
    return readWorkflowEvidenceText(relPath);
  }
  if (!ensureReviewPath(relPath, m().actions.read)) {
    return '';
  }
  if (isDeletedReviewFile(relPath)) {
    return m().document.deletedFileNote;
  }
  const cwd = activeCwd();
  if (!cwd) {
    return '';
  }
  const uri = vscode.Uri.joinPath(vscode.Uri.file(cwd), relPath);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (open) {
    return open.getText();
  }
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch (err) {
    if (strict) {
      throw err;
    }
    return '';
  }
}

async function analyzeCurrentFile(): Promise<void> {
  const rel = DocumentPanel.currentPath ?? workbenchSelected;
  if (!rel) {
    transientWarning(m().analysis.pickFileToAnalyze);
    return;
  }
  await analyzeByPath(rel);
}

/** Analyzes a specific review file by its relative path. */
async function analyzeByPath(
  rel: string,
  options?: { model: vscode.LanguageModelChat; workflow: ReviewWorkflowState; token: vscode.CancellationToken },
): Promise<WorkflowFileResult | undefined> {
  if (centerSubmitting) { centerNotice(m().reviewCenter.submitting, true); return; }
  if (session.workflow && !options) {
    try { await reviewCoordinator.run(false, true, session.workflow.revision, new Set([rel])); }
    catch (error) { centerNotice(workflowErrorText(error), true); }
    return;
  }
  if (!ensureReviewPath(rel, m().actions.analyze)) {
    return;
  }
  if (isDeletedReviewFile(rel)) {
    transientInfo(m().analysis.deletedFileHandled(rel));
    return;
  }
  if (analyzingPaths.has(rel) && !fileAnalysisCts.get(rel)?.token.isCancellationRequested) {
    transientInfo(m().analysis.inProgress(rel));
    return;
  }
  const cwd = activeCwd();
  if (!cwd) {
    return;
  }
  const reviewSet = session.reviewSet;
  if (!reviewSet) {
    return;
  }
  const model = options?.model ?? await models.resolve();
  if (session.reviewSet !== reviewSet || activeCwd() !== cwd) {
    return;
  }
  if (!model) {
    if (!DocumentPanel.flashNotice(rel, m().model.noModel, 'error')) {
      void vscode.window.showErrorMessage(m().model.noModel);
    }
    return;
  }

  let document: vscode.TextDocument;
  try {
    const uri = options ? await safeRepositoryUri(cwd, rel) : vscode.Uri.joinPath(vscode.Uri.file(cwd), rel);
    document = await vscode.workspace.openTextDocument(uri);
    if (options && document.getText() !== await readWorkflowEvidenceText(rel)) throw new Error(m().reviewCenter.snapshotMismatch);
  } catch (error) {
    if (options) throw error;
    if (!DocumentPanel.flashNotice(rel, m().analysis.cannotOpen(rel), 'error')) {
      void vscode.window.showWarningMessage(m().analysis.cannotOpen(rel));
    }
    return;
  }
  if (session.reviewSet !== reviewSet || activeCwd() !== cwd) {
    return;
  }

  // Capture the review identity so a result computed against an older review set
  // (the user may switch scope mid-analysis) is discarded instead of overwriting
  // the current session's findings.
  const documentVersion = document.version;
  analyzingPaths.add(rel);
  const cts = new vscode.CancellationTokenSource();
  const cancellation = options?.token.onCancellationRequested(() => cts.cancel());
  if (options?.token.isCancellationRequested) cts.cancel();
  fileAnalysisCts.set(rel, cts);
  WorkbenchPanel.refreshIfOpen(rel);
  // Progress + result feedback lives in the document view (current window), not a
  // parent-window notification that is invisible when the workbench is full-screen.
  // The 「基于此文件分析」 button shows an indeterminate progress bar via setAnalyzing.
  DocumentPanel.setAnalyzing(rel, true);
  let ok = false;
  let hashes: Record<string, string> = {};
  let complete = true;
  try {
    const repositoryAware =
      vscode.workspace
        .getConfiguration('codereview')
        .get<'auto' | 'off'>('repositoryAwareAnalysis', 'auto') !== 'off';
    const stillCurrent = () =>
      !cts.token.isCancellationRequested
      && (options
        ? session.workflow?.scopeKey === options.workflow.scopeKey && session.workflow?.run.id === options.workflow.run.id
        : session.reviewSet === reviewSet)
      && activeCwd() === cwd
      && document.version === documentVersion
      && fileAnalysisCts.get(rel) === cts;
    let summary: FileAnalysisSummary;
    let affectedFiles: string[];
    if (repositoryAware) {
      DocumentPanel.setAnalysisStage(rel, m().analysis.buildingRelatedContext);
      const services = options ? {
        ...defaultRepositoryEvidenceServices,
        readText: (uri: vscode.Uri) => readWorkflowEvidenceText(nodePath.relative(cwd, uri.fsPath).replaceAll('\\', '/')),
      } : defaultRepositoryEvidenceServices;
      let context = await collectRelatedRepositoryContext({
        cwd,
        sourcePath: rel,
        sourceDocument: document,
        preferredPaths: reviewSet?.files.map((file) => file.path),
        token: cts.token,
      }, services);
      if (!stillCurrent()) {
        return;
      }
      inFlightAnalysisDependencies.set(rel, new Set(context.files));
      context = await fitRepositoryContextToTokenBudget(
        model,
        context,
        cts.token,
        vscode.workspace
          .getConfiguration('codereview')
          .get<number>(
            'repositoryContextTokenBudget',
            DEFAULT_REPOSITORY_CONTEXT_TOKEN_BUDGET,
          ),
      );
      if (!stillCurrent()) {
        return;
      }
      inFlightAnalysisDependencies.set(rel, new Set(context.files));
      DocumentPanel.setAnalysisStage(rel, m().analysis.findingRelatedBugs);
      complete = rootContextComplete(context, document.getText());
      hashes = context.fileHashes;
      const candidates = await analyzeRootedRepository(model, context, cts.token, options?.workflow);
      if (!stillCurrent()) {
        return;
      }
      if (!await validateRepositoryAnalysisContext(context, cwd, cts.token, services)) {
        throw new AnalysisError(m().analysis.relatedCodeChanged);
      }
      if (!stillCurrent()) {
        return;
      }
      DocumentPanel.setAnalysisStage(rel, m().analysis.selfReviewingCandidates);
      const verifications = await verifyRootedRepositoryFindings(
        model,
        context,
        candidates,
        cts.token,
        vscode.workspace
          .getConfiguration('codereview')
          .get<number>(
            'repositoryContextTokenBudget',
            DEFAULT_REPOSITORY_CONTEXT_TOKEN_BUDGET,
          ),
        options?.workflow,
      );
      if (!stillCurrent()) {
        return;
      }
      const result = finalizeRootedRepositoryAnalysis(
        context,
        candidates,
        verifications,
        !!options,
      );
      const invalidatesGlobal = !!session.globalReport;
      const update = session.setRootedFindings(
        rel,
        result.findingsByFile,
        result.summary,
        context.files,
      );
      affectedFiles = [
        ...new Set([rel, ...update.updatedFiles, ...update.removedFiles]),
      ];
      if (invalidatesGlobal) {
        fixProposalOpenGeneration += 1;
        FixProposalPanel.closeIfGlobal();
      }
      summary = result.summary;
    } else {
      DocumentPanel.setAnalysisStage(rel, m().analysis.analyzingCurrentFile);
      hashes = { [rel]: contentFingerprint(document.getText()) };
      const candidates = await analyzeFile(model, document, cts.token, options?.workflow);
      if (!stillCurrent()) {
        return;
      }
      const result = finalizeFileAnalysis(candidates, [], false, !!options);
      const invalidatesGlobal = !!session.globalReport;
      const update = session.setRootedFindings(
        rel,
        { [rel]: result.findings },
        result.summary,
        [rel],
      );
      affectedFiles = [
        ...new Set([rel, ...update.updatedFiles, ...update.removedFiles]),
      ];
      if (invalidatesGlobal) {
        fixProposalOpenGeneration += 1;
        FixProposalPanel.closeIfGlobal();
      }
      summary = result.summary;
    }
    GlobalReportPanel.closeIfOpen();
    // Re-analysis replaces this file's findings (new ids), so any fix proposal
    // open for THIS file is now tied to a finding that no longer exists — close
    // it instead of leaving a stale proposal beside the fresh results.
    fixProposalOpenGeneration += 1;
    for (const file of affectedFiles) {
      FixProposalPanel.closeIfFile(file);
    }
    await Promise.all(affectedFiles.map((file) => refreshDocPanel(file)));
    ok = true;
    session.setTotalLines(rel, document.lineCount);
    if (options) return { kind: 'analyzed', hashes, summary, complete };
    DocumentPanel.flashNotice(
      rel,
      repositoryAware
        ? m().analysis.rootedAnalysisSummary(
            rel,
            summary.contextFiles ?? 1,
            summary.confirmed,
            summary.dismissed,
            summary.unresolved,
            summary.contextTruncated
              ? m().analysis.contextBudgetReached(
                  (summary.contextLimitReasons ?? [])
                    .map((reason) => m().analysis.contextLimitReason[reason])
                    .join(', '),
                )
              : '',
          )
        : (summary.confirmed
            ? m().analysis.foundIssues(rel, summary.confirmed)
            : m().analysis.noIssues(rel)),
      'info',
      7000,
    );
  } catch (err) {
    if (options) throw err;
    const message =
      err instanceof AnalysisError ? err.message : String((err as Error)?.message ?? err);
    if (!DocumentPanel.flashNotice(rel, m().review.error(message), 'error')) {
      reportError(err);
    }
  } finally {
    cancellation?.dispose();
    if (fileAnalysisCts.get(rel) === cts) {
      fileAnalysisCts.delete(rel);
      inFlightAnalysisDependencies.delete(rel);
      analyzingPaths.delete(rel);
      WorkbenchPanel.refreshIfOpen(rel);
      DocumentPanel.setAnalyzing(rel, false, ok);
    }
    cts.dispose();
  }
  return undefined;
}

/**
 * Opens (or reveals) the fix-proposal panel for a finding. Cached proposals are
 * restored automatically; applying one flips the finding's disposition to
 * `fixed`. This does NOT itself change the disposition — it's a pure entry point
 * shared by the "Copilot 修复" button and the clickable finding header.
 */
function fixWriteValidator(cwd: string, path: string, lifecycle: number): (undo: boolean) => Promise<void> {
  return async (undo) => {
    if (session.reviewLifecycleVersion !== lifecycle) throw new WorkflowError('staleResult');
    await safeRepositoryUri(cwd, path);
    if (!undo && session.workflow) await reviewCoordinator.validateCurrentResults();
    if (session.reviewLifecycleVersion !== lifecycle) throw new WorkflowError('staleResult');
  };
}

async function openFixProposal(
  rel: string,
  finding: Finding,
  options?: { cacheOnly?: boolean },
): Promise<void> {
  const openGeneration = ++fixProposalOpenGeneration;
  const lifecycle = session.reviewLifecycleVersion;
  const cwd = activeCwd();
  if (!cwd) {
    return;
  }
  const [displayFinding] = localizeFindingsNow(rel, [finding], resolveLanguage());
  const findingId = finding.id;
  const appliedFixKey = fixKey(rel, findingId);
  const legacyAppliedFixKey = legacyFixKey(rel, findingId);
  // Opening the fix panel must NOT move the document — the reviewer is reading a
  // specific spot and only the explicit 「定位」 button should scroll. Resolve the
  // finding's CURRENT line via the shared authority (no side effects), so the
  // panel header/edit-picking use the live line while the document stays put.
  const { startLine: liveLine } = await resolveLiveRange(rel, finding.line, finding.endLine, finding.id);
  if (openGeneration !== fixProposalOpenGeneration) {
    return;
  }
  const fileUri = session.workflow ? await safeRepositoryUri(cwd, rel) : vscode.Uri.joinPath(vscode.Uri.file(cwd), rel);
  FixProposalPanel.show({
    rel,
    validateBeforeWrite: fixWriteValidator(cwd, rel, lifecycle),
    localizationScope: { kind: 'file', rel },
    cacheKey: fixProposalCacheKey(rel, finding),
    fileUri,
    finding: {
      id: finding.id,
      line: liveLine,
      title: displayFinding.title,
      detail: displayFinding.detail,
      suggestion: displayFinding.suggestion,
    },
    getDisplayFinding: () => {
      const [current] = localizeFindingsNow(rel, [finding], resolveLanguage());
      return {
        title: current.title,
        detail: current.detail,
        suggestion: current.suggestion,
      };
    },
    generate: async (token, userContext) => {
      const model = await models.resolve();
      if (token.isCancellationRequested || session.reviewLifecycleVersion !== lifecycle) throw new WorkflowError('staleResult');
      if (!model) {
        const prompt = composeFixPrompt(finding);
        try {
          await vscode.env.clipboard.writeText(prompt);
        } catch {
          // ignore clipboard failures
        }
        throw new Error(m().fix.noModelClipboard);
      }
      const content = await readReviewFileText(rel);
      if (token.isCancellationRequested || session.reviewLifecycleVersion !== lifecycle) throw new WorkflowError('staleResult');
      return generateFixProposals(
        model,
        rel,
        content,
        {
          title: finding.title,
          detail: finding.detail,
          suggestion: finding.suggestion,
          line: finding.line,
          endLine: finding.endLine,
          anchor: finding.anchor,
        },
        token,
        userContext,
        session.workflow,
      );
    },
    onApplied: (edit) => {
      setAppliedFix(appliedFixKey, edit);
      session.setFindingDisposition(rel, findingId, { kind: 'fixed', at: Date.now() });
      WorkbenchPanel.refreshIfOpen();
      // Reload the changed file, then re-center on THIS finding's fixed code so
      // collapsing the now-disposed card (which shifts layout) doesn't make the
      // view jump elsewhere. Keep focus exactly where the reviewer was working.
      void (async () => {
        await reloadDocPanel(rel);
        await locateInFile(rel, finding.line, finding.endLine, findingId);
      })();
      transientInfo(m().fix.applied);
    },
    onSplices: (splices) => session.remapSeenAfterSplices(rel, splices),
    onWillChangeFile: () => beginInternalReviewEdit(fileUri),
    onFileChangeFinished: () => endInternalReviewEdit(fileUri),
    onFileChanged: () => {
      reflectReviewInvalidation(
        session.invalidateAfterFileChange(rel),
        rel,
        false,
      );
    },
    canApply: () => {
      const current = session.findings(rel).find((item) => item.id === findingId);
      return !!current && isActionableFinding(current) && (!session.workflow || (session.workflow.run.status !== 'running' && workflowFindingCurrent(rel, current)));
    },
    onUndone: () => {
      deleteAppliedFixKeys(appliedFixKey, legacyAppliedFixKey);
      session.setFindingDisposition(rel, findingId, null);
      WorkbenchPanel.refreshIfOpen();
      // Reload the reverted file, then re-center on the finding again so the
      // undo keeps focus in place instead of jumping.
      void (async () => {
        await reloadDocPanel(rel);
        await locateInFile(rel, finding.line, finding.endLine, findingId);
      })();
    },
  }, options);
}

/**
 * Opens the fix-proposal panel for *viewing* a finding's proposals (cached or
 * freshly generated) without altering its disposition. Wired to the clickable
 * finding header so reviewers can re-inspect a proposal even after the finding
 * has been disposed.
 */
async function viewFixProposal(
  rel: string,
  findingId: string,
  cachedOnly = false,
): Promise<void> {
  if (!session.reviewSet) {
    return;
  }
  if (!ensureReviewPath(rel, m().actions.viewFixProposals)) {
    return;
  }
  const finding = session.findings(rel).find((f) => f.id === findingId);
  if (!finding) {
    return;
  }
  if (
    finding.verification?.status === 'unresolved'
    || finding.verification?.status === 'overturned'
  ) {
    transientWarning(m().analysis.unresolvedCannotFix);
    return;
  }
  if (
    cachedOnly
    && !FixProposalPanel.canSwitchToCached(fixProposalCacheKey(rel, finding))
  ) {
    // This selection is still the latest user intent even though there is no
    // cached panel to show. Cancel any slower open started by an earlier click.
    fixProposalOpenGeneration += 1;
    return;
  }
  await openFixProposal(rel, finding, { cacheOnly: cachedOnly });
}

/**
 * Routes the reviewer's disposition for a finding to the appropriate side effect
 * (invoke Copilot inline chat, post PR line comment, or capture an ignore reason)
 * and persists the result so the gate can advance.
 */
async function disposeFinding(rel: string, findingId: string, kind: FindingDispositionKind): Promise<void> {
  const currentFinding = findingOwner(rel, findingId);
  const reviewSet = session.reviewSet;
  if (!reviewSet) {
    return;
  }
  if (!ensureReviewPath(rel, m().actions.disposeFinding)) {
    return;
  }
  const current = session.findingDisposition(rel, findingId);
  if (current?.kind === kind) {
    // Toggling off. If the user is removing the 'fixed' mark and we still have
    // the applied edit on record, also revert the file change — that's the
    // intuitive meaning of "undo Copilot fix" from the document panel.
    if (kind === 'fixed') {
      await revertAppliedFix(rel, findingId);
    } else if (kind === 'commented' && current.ref) {
      if (/^pr-\d+$/.test(reviewSet.scopeId)) {
        // Draft PR comment lives in the pending review; drop it on toggle-off.
        session.removePendingComment(current.ref);
      } else {
        // Local comment was stored as an inline note; remove it on toggle-off.
        session.removeAnnotation(rel, current.ref);
      }
    }
    session.setFindingDisposition(rel, findingId, null);
    transientInfo(m().finding.dispositionReverted(rel));
    WorkbenchPanel.refreshIfOpen();
    refreshDocPanel(rel);
    return;
  }
  const finding = session.findings(rel).find((f) => f.id === findingId);
  if (!finding) {
    return;
  }
  const [displayFinding] = localizeFindingsNow(rel, [finding], resolveLanguage());

  const cwd = activeCwd();
  if (!cwd) {
    return;
  }
  const liveRange = kind === 'commented'
    ? await resolveLiveRange(rel, finding.line, finding.endLine, findingId, finding.anchor)
    : undefined;

  if (kind === 'fixed') {
    if (
      finding.verification?.status === 'unresolved'
      || finding.verification?.status === 'overturned'
    ) {
      transientWarning(m().analysis.unresolvedCannotFix);
      return;
    }
    await openFixProposal(rel, finding);
    return;
  } else if (kind === 'commented') {
    const prMatch = reviewSet.scopeId.match(/^pr-(\d+)$/);
    const body = composeCommentBody(displayFinding);
    const inline = !session.workflow || await canPostInlineComment(rel, liveRange?.startLine ?? finding.line, liveRange?.stopLine ?? finding.endLine ?? finding.line);
    if (!currentFinding()) throw new WorkflowError('staleResult');
    if (prMatch && !inline) {
      session.setFindingDisposition(rel, findingId, { kind: 'commented', ref: 'report-body', reason: m().reviewCenter.commentInBody, at: Date.now() });
      centerNotice(m().reviewCenter.commentInBody);
      return;
    }
    if (prMatch) {
      // Accumulate into the pending review (posted together on conclusion),
      // instead of firing an immediate standalone comment.
      const commentId = `cmt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      session.addPendingComment({
        id: commentId,
        path: rel,
        startLine: liveRange?.startLine ?? finding.line,
        endLine: liveRange?.stopLine ?? finding.endLine ?? finding.line,
        body,
        source: 'finding',
        createdAt: Date.now(),
      });
      session.setFindingDisposition(rel, findingId, {
        kind: 'commented',
        ref: commentId,
        at: Date.now(),
      });
      transientInfo(`${m().documentPanel.commentAdded} (${session.pendingComments.length})`);
    } else {
      const annotationId = recordLocalCommentNote(rel, {
        ...finding,
        line: liveRange?.startLine ?? finding.line,
        endLine: liveRange?.stopLine ?? finding.endLine,
      });
      session.setFindingDisposition(rel, findingId, {
        kind: 'commented',
        ref: annotationId,
        at: Date.now(),
      });
      transientInfo(m().finding.recordedInlineNote);
    }
  } else if (kind === 'ignored') {
    const reason = await showIgnoreReasonInput(displayFinding.title);
    if (!reason) {
      return;
    }
    if (!currentFinding()) { centerNotice(m().reviewCenter.changedDuringReview, true); return; }
    session.setFindingDisposition(rel, findingId, {
      kind: 'ignored',
      reason: reason.trim(),
      at: Date.now(),
    });
    transientInfo(m().finding.ignored);
  }

  WorkbenchPanel.refreshIfOpen();
  refreshDocPanel(rel);
}

function composeFixPrompt(finding: { title: string; detail: string; suggestion?: string; line: number }): string {
  const lines: string[] = [
    m().fix.clipboardHeader(finding.line),
    m().fix.clipboardTitle(finding.title),
    m().fix.clipboardIssue(finding.detail),
  ];
  if (finding.suggestion) {
    lines.push(m().fix.clipboardSuggestion(finding.suggestion));
  }
  lines.push(m().fix.clipboardFooter);
  return lines.join('\n');
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function fixProposalCacheKey(rel: string, finding: Finding): string {
  // File-based key: a fix proposal follows the FILE + finding content, not the
  // review scope or commit. Re-selecting a scope (or opening the same file under
  // a different scope/headSha) still hits the cached proposal instead of
  // regenerating. The finding hash already shifts when the file's content moves
  // the finding, so a genuinely stale proposal misses on its own.
  const repoPart = session.workflow
    ? `${session.workflow.repositoryKey}:${workflowResultKey(session.workflow)}:${session.workflow.run.repositoryStamp ?? ''}`
    : session.getRepoName() || 'no-repo';
  const findingPart = [
    finding.id,
    finding.line,
    finding.endLine ?? '',
    finding.title,
    finding.detail,
    finding.suggestion ?? '',
  ].join('\0');
  return `${repoPart}::${rel}::${hashString(findingPart)}`;
}

function composeCommentBody(finding: { title: string; detail: string; suggestion?: string }): string {
  const parts = [`**${finding.title}**`, '', finding.detail];
  if (finding.suggestion) {
    parts.push('', m().fix.suggestionLabel(finding.suggestion));
  }
  parts.push('', '_via AI Coding Review_');
  return parts.join('\n');
}

/**
 * Records a finding's review comment as an inline note anchored to the finding's
 * line, so a local (non-PR) comment shows up next to the code — the same place
 * fixes land — instead of in a separate file. Returns the new annotation id,
 * stored as the disposition ref so toggling the comment off can remove it.
 */
function recordLocalCommentNote(
  rel: string,
  finding: { line: number; endLine?: number; anchor?: string; title: string; detail: string; suggestion?: string },
): string {
  const annotation: Annotation = {
    id: newAnnotationId(),
    kind: 'note',
    startLine: finding.line,
    endLine: finding.endLine ?? finding.line,
    sourceText: finding.anchor ?? '',
    content: composeCommentBody(finding),
    createdAt: Date.now(),
  };
  session.addAnnotation(rel, annotation);
  refreshDocPanel(rel);
  return annotation.id;
}

async function runGlobalAnalysis(): Promise<void> {
  if (!canChangeReview()) return;
  if (session.workflow) {
    try { await reviewCoordinator.run(false, true, session.workflow.revision); }
    catch (error) { centerNotice(workflowErrorText(error), true); }
    return;
  }
  const reviewSet = session.reviewSet;
  if (!reviewSet) {
    WorkbenchPanel.setGlobalProgress(false);
    transientWarning(m().review.notStartedWarn);
    return;
  }
  if (globalAnalysisInFlight) {
    // Already running — re-assert busy so the button stays disabled, then bail.
    WorkbenchPanel.setGlobalProgress(true, m().global.inProgress);
    transientInfo(m().global.inProgressWait);
    return;
  }
  const unready = reviewSet.files.filter((f) => !session.fileFullySeen(f.path));
  if (unready.length) {
    // Do NOT run global analysis until everything is read. Surface this inside
    // the workbench (current window) — a parent-window prompt is invisible when
    // the workbench is in its own auxiliary window — and jump to the first
    // unread file so the reviewer can see exactly what is left.
    WorkbenchPanel.setGlobalProgress(false);
    const shown = WorkbenchPanel.flashNotice(m().global.blockedUnready(unready.length), 'warn');
    if (!shown) {
      transientWarning(m().global.blockedUnready(unready.length));
    }
    void openFileInPanel(unready[0].path);
    return;
  }
  const model = await models.resolve();
  if (!model) {
    WorkbenchPanel.setGlobalProgress(false);
    if (!WorkbenchPanel.flashNotice(m().model.noModel, 'error')) {
      void vscode.window.showErrorMessage(m().model.noModel);
    }
    return;
  }

  // Drive progress inline inside the workbench (where the reviewer is looking)
  // instead of a parent-window notification, which is easy to miss when the
  // workbench is in its own auxiliary window.
  globalAnalysisInFlight = true;
  const cts = new vscode.CancellationTokenSource();
  globalAnalysisCts = cts;
  const token = cts.token;
  const total = reviewSet.files.length;
  WorkbenchPanel.setGlobalProgress(true, m().global.preparing(total));
  try {
    const context: GlobalContextFile[] = [];
    let read = 0;
    for (const f of reviewSet.files) {
      if (token.isCancellationRequested || session.reviewSet !== reviewSet) {
        return;
      }
      read++;
      WorkbenchPanel.setGlobalProgress(true, m().global.reading(read, total, f.path));
      context.push({
        path: f.path,
        findings: session.findings(f.path),
        content: await readReviewFileText(f.path),
      });
    }
    WorkbenchPanel.setGlobalProgress(
      true,
      m().global.analyzing(total),
    );
    if (token.isCancellationRequested || session.reviewSet !== reviewSet) {
      return;
    }
    const globalReport = await analyzeGlobal(model, context, token);
    if (session.reviewSet !== reviewSet || token.isCancellationRequested) {
      return;
    }
    migrateAppliedGlobalFixes(session.globalReport, globalReport);
    session.setGlobalReport(globalReport);
    const reconciledFiles = session.reconcileGlobalVerdicts(globalReport);
    if (reconciledFiles.length > 0) {
      fixProposalOpenGeneration += 1;
    }
    for (const file of reconciledFiles) {
      FixProposalPanel.closeIfFile(file);
    }
    await Promise.all(reconciledFiles.map((file) => refreshDocPanel(file)));
    showGlobalReport();
  } catch (err) {
    if (!token.isCancellationRequested) {
      reportError(err);
    }
  } finally {
    cts.dispose();
    if (globalAnalysisCts === cts) {
      globalAnalysisInFlight = false;
      globalAnalysisCts = undefined;
      WorkbenchPanel.setGlobalProgress(false);
    }
  }
}

/** Cancels the in-flight global analysis, if any. */
function cancelGlobalAnalysis(): void {
  if (globalAnalysisCts) {
    globalAnalysisCts.cancel();
    WorkbenchPanel.setGlobalProgress(false);
    transientInfo(m().global.cancelled);
  }
}

/**
 * Switches from the global report back to the file-level review ("① 文件级审查"
 * tab). Reveals the workbench and brings the document panel to the front of its
 * column so it's no longer hidden behind the global-report tab; if no file is
 * open yet, opens the selected (or first) review file.
 */
async function switchToFileReview(): Promise<void> {
  await openWorkbench();
  if (DocumentPanel.currentPath) {
    DocumentPanel.focus();
    return;
  }
  const first = workbenchSelected ?? session.reviewSet?.files[0]?.path;
  if (first) {
    await openFileInPanel(first);
    DocumentPanel.focus();
  }
}

function showGlobalReport(): void {
  if (session.workflow) {
    void submitConclusion().catch(reportError);
    return;
  }
  const report = session.globalReport;
  if (!report) {
    transientInfo(m().global.noReport);
    return;
  }
  const localizedReport = localizeGlobalReportNow(report, resolveLanguage());
  const cov = session.totalCoverage();
  const reviewSet = session.reviewSet;
  const findingsCount = reviewSet
    ? reviewSet.files.reduce((sum, f) => sum + session.findings(f.path).length, 0)
    : 0;
  GlobalReportPanel.show(localizedReport, session.globalConfirmed, {
    onLocate: (file, line, spotId, findingRef) => {
      const spot = spotId
        ? session.globalReport?.fixSpots.find((item) => item.id === spotId)
        : undefined;
      const finding = findingRef
        ? session.findingByContentRef(file, findingRef)
        : undefined;
      void locateInFile(
        file,
        line,
        spot?.endLine ?? finding?.endLine,
        spotId ?? finding?.id,
        spot?.anchor ?? finding?.anchor,
      );
    },
    onConfirm: () => {
      session.confirmGlobal();
      showGlobalReport();
    },
    onGlobalFix: (spotId, file, line) => void openGlobalFix(spotId, file, line),
    onGlobalIgnore: (spotId, file, line) => void disposeGlobalFix(spotId, file, line, 'ignored'),
    onGlobalComment: (spotId, file, line) => void disposeGlobalFix(spotId, file, line, 'commented'),
    onGlobalRevert: (spotId, file, line) => void revertGlobalFix(spotId, file, line),
    onGotoFiles: () => void switchToFileReview(),
    fixDisposition: (spotId, file, line) =>
      session.globalFixDisposition(spotId, file, line, globalFixAnchor(spotId))?.kind,
    stats: {
      seen: cov.seen,
      total: cov.total,
      filesReady: cov.filesReady,
      filesTotal: cov.filesTotal,
      findings: findingsCount,
      gatePassed: session.gatePassed(),
    },
  });
  void ensureGlobalReportLocalized(report);
}

/** Looks up a global fix spot's anchor snippet by id, for disposition resolution. */
function globalFixAnchor(spotId: string): string | undefined {
  return session.globalReport?.fixSpots.find((s) => s.id === spotId)?.anchor;
}

/**
 * Opens the fix-proposal panel for a global fix spot and, when a proposal is
 * applied, records the disposition via design Y+X (reuse the mapped file-level
 * finding's disposition, else an independent global store). Lets cross-file
 * findings be fixed with the same one-click flow as file-level findings.
 */
async function openGlobalFix(spotId: string, file: string, _line: number): Promise<void> {
  const openGeneration = ++fixProposalOpenGeneration;
  const lifecycle = session.reviewLifecycleVersion;
  if (!ensureReviewPath(file, m().actions.analyze)) {
    return;
  }
  const baseReport = session.globalReport;
  const spot = baseReport?.fixSpots.find((s) => s.id === spotId);
  if (!spot) {
    return;
  }
  const localizedSpot = baseReport
    ? localizeGlobalReportNow(baseReport, resolveLanguage()).fixSpots.find((s) => s.id === spotId) ?? spot
    : spot;
  const cwd = activeCwd();
  if (!cwd) {
    return;
  }
  // Opening the fix panel must NOT move the document — only the report's explicit
  // 「定位」 scrolls. Resolve the spot's current line via the shared authority
  // (no side effects) so the panel header is right while the document stays put.
  const { startLine: liveLine } = await resolveLiveRange(
    file,
    spot.line,
    spot.endLine,
    spotId,
    spot.anchor,
  );
  if (openGeneration !== fixProposalOpenGeneration) {
    return;
  }
  const fileUri = session.workflow ? await safeRepositoryUri(cwd, file) : vscode.Uri.joinPath(vscode.Uri.file(cwd), file);
  const appliedFixKey = fixKey(file, spotId);
  const legacyAppliedFixKey = legacyFixKey(file, spotId);
  const findingLike: Finding = {
    id: spotId,
    line: spot.line,
    endLine: spot.endLine,
    anchor: spot.anchor,
    severity: spot.severity,
    title: spot.title,
    detail: spot.detail,
    suggestion: spot.suggestion,
  };
  FixProposalPanel.show({
    rel: file,
    validateBeforeWrite: fixWriteValidator(cwd, file, lifecycle),
    localizationScope: { kind: 'global' },
    cacheKey: `global::${session.workflow ? `${session.workflow.repositoryKey}:${workflowResultKey(session.workflow)}:${session.workflow.run.repositoryStamp ?? ''}` : session.getRepoName()}::${file}::${hashString(spotId + spot.title + spot.detail)}`,
    fileUri,
    finding: {
      id: spotId,
      line: liveLine,
      title: localizedSpot.title,
      detail: localizedSpot.detail,
      suggestion: localizedSpot.suggestion,
    },
    getDisplayFinding: () => {
      const report = session.globalReport ?? baseReport;
      const current = report
        ? localizeGlobalReportNow(report, resolveLanguage()).fixSpots.find((item) => item.id === spotId)
        : undefined;
      const display = current ?? spot;
      return {
        title: display.title,
        detail: display.detail,
        suggestion: display.suggestion,
      };
    },
    generate: async (token, userContext) => {
      const model = await models.resolve();
      if (token.isCancellationRequested || session.reviewLifecycleVersion !== lifecycle) throw new WorkflowError('staleResult');
      if (!model) {
        throw new Error(m().fix.noModelClipboard);
      }
      const content = await readReviewFileText(file);
      if (token.isCancellationRequested || session.reviewLifecycleVersion !== lifecycle) throw new WorkflowError('staleResult');
      return generateFixProposals(model, file, content, findingLike, token, userContext, session.workflow);
    },
    onApplied: (edit) => {
      setAppliedFix(appliedFixKey, edit);
      session.setGlobalFixDisposition(spotId, file, spot.line, spot.anchor, { kind: 'fixed', at: Date.now() });
      WorkbenchPanel.refreshIfOpen();
      GlobalReportPanel.refreshIfOpen();
      void (async () => {
        await reloadDocPanel(file);
        await locateInFile(file, spot.line, spot.endLine, spotId, spot.anchor);
      })();
      transientInfo(m().fix.applied);
    },
    onSplices: (splices) => session.remapSeenAfterSplices(file, splices),
    onWillChangeFile: () => beginInternalReviewEdit(fileUri),
    onFileChangeFinished: () => endInternalReviewEdit(fileUri),
    onFileChanged: () => {
      reflectReviewInvalidation(
        session.invalidateAfterFileChange(file),
        file,
        false,
      );
    },
    onUndone: () => {
      deleteAppliedFixKeys(appliedFixKey, legacyAppliedFixKey);
      session.setGlobalFixDisposition(spotId, file, spot.line, spot.anchor, null);
      WorkbenchPanel.refreshIfOpen();
      GlobalReportPanel.refreshIfOpen();
      void (async () => {
        await reloadDocPanel(file);
        await locateInFile(file, spot.line, spot.endLine, spotId, spot.anchor);
      })();
    },
    canApply: () => !!session.globalReport?.fixSpots.some((item) => item.id === spotId && isActionableFinding(item))
      && (!session.workflow || (session.workflow.run.status !== 'running' && workflowResultsCurrent() && session.workflow.run.globalComplete)),
  });
}

/**
 * Disposes a global fix spot as `commented` or `ignored` (the `fixed` path goes
 * through {@link openGlobalFix}). Mirrors the file-level {@link disposeFinding}
 * side effects — PR line comment / local note for `commented`, an ignore reason
 * for `ignored` — but records the result via {@link ReviewSession.setGlobalFixDisposition}
 * so spots that map to no file-level finding still persist (design X).
 */
async function disposeGlobalFix(
  spotId: string,
  file: string,
  _line: number,
  kind: 'commented' | 'ignored',
): Promise<void> {
  const lifecycle = session.reviewLifecycleVersion;
  const runId = session.workflow?.run.id;
  const reviewSet = session.reviewSet;
  if (!reviewSet) {
    return;
  }
  if (!ensureReviewPath(file, m().actions.disposeFinding)) {
    return;
  }
  const baseReport = session.globalReport;
  const spot = baseReport?.fixSpots.find((s) => s.id === spotId);
  if (!spot) {
    return;
  }
  const localizedSpot = baseReport
    ? localizeGlobalReportNow(baseReport, resolveLanguage()).fixSpots.find((s) => s.id === spotId) ?? spot
    : spot;
  const cwd = activeCwd();
  if (!cwd) {
    return;
  }
  const findingLike = {
    title: localizedSpot.title,
    detail: localizedSpot.detail,
    suggestion: localizedSpot.suggestion,
  };
  const liveRange = await resolveLiveRange(
    file,
    spot.line,
    spot.endLine,
    spotId,
    spot.anchor,
  );
  if (session.globalReport !== baseReport) {
    return;
  }

  if (kind === 'commented') {
    const prMatch = reviewSet.scopeId.match(/^pr-(\d+)$/);
    const body = composeCommentBody(findingLike);
    const inline = !session.workflow || await canPostInlineComment(file, liveRange.startLine, liveRange.stopLine);
    if (lifecycle !== session.reviewLifecycleVersion || runId !== session.workflow?.run.id) throw new WorkflowError('staleResult');
    if (prMatch && !inline) {
      session.setGlobalFixDisposition(spotId, file, spot.line, spot.anchor, { kind: 'commented', ref: 'report-body', reason: m().reviewCenter.commentInBody, at: Date.now() });
      centerNotice(m().reviewCenter.commentInBody);
      return;
    }
    if (prMatch) {
      // Accumulate into the pending review, posted together on conclusion.
      const commentId = `cmt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      session.addPendingComment({
        id: commentId,
        path: file,
        startLine: liveRange.startLine,
        endLine: liveRange.stopLine,
        body,
        source: 'finding',
        createdAt: Date.now(),
      });
      session.setGlobalFixDisposition(spotId, file, spot.line, spot.anchor, {
        kind: 'commented',
        ref: commentId,
        at: Date.now(),
      });
      transientInfo(`${m().documentPanel.commentAdded} (${session.pendingComments.length})`);
    } else {
      const annotationId = recordLocalCommentNote(file, {
        line: liveRange.startLine,
        endLine: liveRange.stopLine,
        anchor: spot.anchor,
        title: spot.title,
        detail: spot.detail,
        suggestion: spot.suggestion,
      });
      session.setGlobalFixDisposition(spotId, file, spot.line, spot.anchor, {
        kind: 'commented',
        ref: annotationId,
        at: Date.now(),
      });
      transientInfo(m().finding.recordedInlineNote);
    }
  } else {
    const reason = await showIgnoreReasonInput(localizedSpot.title);
    if (!reason) {
      return;
    }
    session.setGlobalFixDisposition(spotId, file, spot.line, spot.anchor, {
      kind: 'ignored',
      reason: reason.trim(),
      at: Date.now(),
    });
    transientInfo(m().finding.ignored);
  }
  WorkbenchPanel.refreshIfOpen();
  GlobalReportPanel.refreshIfOpen();
}

/**
 * Clears a global fix spot's disposition (the "revert" action in the handled
 * list). If the spot was `fixed` and we still hold the applied edit, also revert
 * the file change — matching the file-level undo semantics.
 */
async function revertGlobalFix(spotId: string, file: string, _line: number): Promise<void> {
  if (!ensureReviewPath(file, m().actions.disposeFinding)) {
    return;
  }
  const spot = session.globalReport?.fixSpots.find((s) => s.id === spotId);
  const anchor = spot?.anchor;
  const current = spot
    ? session.globalFixDisposition(spotId, file, spot.line, anchor)
    : undefined;
  if (current?.kind === 'fixed') {
    await revertAppliedFix(file, spotId);
    deleteAppliedFixFor(file, spotId);
  } else if (current?.kind === 'commented' && current.ref) {
    if (/^pr-\d+$/.test(session.reviewSet?.scopeId ?? '')) {
      // Draft PR comment lives in the pending review; drop it on revert.
      session.removePendingComment(current.ref);
    } else {
      // Local comment was stored as an inline note; remove it on revert.
      session.removeAnnotation(file, current.ref);
    }
  }
  if (spot) {
    session.setGlobalFixDisposition(spotId, file, spot.line, anchor, null);
  }
  transientInfo(m().finding.dispositionReverted(file));
  WorkbenchPanel.refreshIfOpen();
  GlobalReportPanel.refreshIfOpen();
  if (spot) {
    void (async () => {
      await reloadDocPanel(file);
      await locateInFile(file, spot.line, spot.endLine, spotId, spot.anchor);
    })();
  }
}

async function localizeReportData(data: ReportData, target: Language): Promise<ReportData> {
  const items: Array<{ cacheKey: string; text: string }> = [];
  for (const f of data.files) {
    for (const finding of f.findings) {
      items.push({
        cacheKey: findingTextCacheKey(f.path, finding.id, 'title', target, finding.title),
        text: finding.title,
      });
      items.push({
        cacheKey: findingTextCacheKey(f.path, finding.id, 'detail', target, finding.detail),
        text: finding.detail,
      });
      if (finding.suggestion) {
        items.push({
          cacheKey: findingTextCacheKey(f.path, finding.id, 'suggestion', target, finding.suggestion),
          text: finding.suggestion,
        });
      }
      if (finding.verification?.rationale) {
        items.push({
          cacheKey: findingTextCacheKey(
            f.path,
            finding.id,
            'verification',
            target,
            finding.verification.rationale,
          ),
          text: finding.verification.rationale,
        });
      }
    }
    for (const a of f.annotations) {
      items.push({
        cacheKey: annotationTextCacheKey(f.path, a.id, target, a.content),
        text: a.content,
      });
    }
  }
  if (data.globalReport) {
    const g = data.globalReport;
    items.push({
      cacheKey: globalTextCacheKey('conclusion', 'main', target, g.conclusion),
      text: g.conclusion,
    });
    for (let i = 0; i < g.evidence.length; i++) {
      items.push({
        cacheKey: globalTextCacheKey('evidence', String(i), target, g.evidence[i]),
        text: g.evidence[i],
      });
    }
    for (let i = 0; i < g.verdicts.length; i++) {
      const v = g.verdicts[i];
      items.push({
        cacheKey: globalTextCacheKey('verdictTitle', `${i}:${v.kind}`, target, v.title),
        text: v.title,
      });
      items.push({
        cacheKey: globalTextCacheKey('verdictBefore', `${i}:${v.kind}`, target, v.before),
        text: v.before,
      });
      items.push({
        cacheKey: globalTextCacheKey('verdictAfter', `${i}:${v.kind}`, target, v.after),
        text: v.after,
      });
    }
    for (let i = 0; i < g.fixSpots.length; i++) {
      const sp = g.fixSpots[i];
      items.push({
        cacheKey: globalTextCacheKey('spotTitle', `${i}:${sp.id}`, target, sp.title),
        text: sp.title,
      });
      items.push({
        cacheKey: globalTextCacheKey('spotDetail', `${i}:${sp.id}`, target, sp.detail),
        text: sp.detail,
      });
      if (sp.suggestion) {
        items.push({
          cacheKey: globalTextCacheKey('spotSuggestion', `${i}:${sp.id}`, target, sp.suggestion),
          text: sp.suggestion,
        });
      }
    }
  }

  await ensureLocalizedTexts(target, items);

  return {
    ...data,
    files: data.files.map((f) => ({
      ...f,
      findings: localizeFindingsNow(f.path, f.findings, target),
      annotations: localizeAnnotationsNow(f.path, f.annotations, target),
    })),
    globalReport: data.globalReport ? localizeGlobalReportNow(data.globalReport, target) : undefined,
  };
}

/** Builds a Markdown review report from the session and opens it as a new document. */
async function exportReviewReport(): Promise<void> {
  const reviewSet = session.reviewSet;
  if (!reviewSet) {
    transientWarning(m().report.noReview);
    return;
  }
  const cov = session.totalCoverage();
  const data: ReportData = {
    repo: session.getRepoName(),
    scopeLabel: reviewSet.label,
    generatedAt: Date.now(),
    coverage: {
      seen: cov.seen,
      total: cov.total,
      filesReady: cov.filesReady,
      filesTotal: cov.filesTotal,
    },
    files: reviewSet.files.map((f) => ({
      path: f.path,
      findings: session.findings(f.path),
      disposition: (findingId: string) => session.findingDisposition(f.path, findingId),
      annotations: session.annotations(f.path),
    })),
    globalReport: session.globalReport,
    conclusion: session.conclusion,
  };
  const localized = await localizeReportData(data, resolveLanguage());
  const markdown = buildReviewReportMarkdown(localized, m().report);
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Active });
  transientInfo(m().report.exported);
}

/**
 * Resolves a finding's CURRENT 1-based line range in the live document — the
 * single source of truth for "where is this finding now". Pure/read-only: it
 * neither opens the document panel nor scrolls. Precedence (content beats the
 * drift-prone stored numbers):
 *   1. an applied Copilot fix → its current text in the live document;
 *   2. otherwise the finding's verbatim `anchor` snippet from analysis;
 *   3. fall back to the stored line numbers.
 * The result is clamped to the file length.
 */
async function resolveLiveRange(
  relPath: string,
  line: number,
  endLine?: number,
  findingId?: string,
  explicitAnchor?: string,
): Promise<{ startLine: number; stopLine: number }> {
  let startLine = Math.max(1, Math.floor(Number.isFinite(line) ? line : 1));
  let stopLine = endLine && endLine > startLine ? Math.floor(endLine) : startLine;

  const reanchored = findingId ? await reanchorToAppliedFix(relPath, findingId) : undefined;
  if (reanchored) {
    startLine = reanchored.startLine;
    stopLine = reanchored.endLine;
  } else if (explicitAnchor || findingId) {
    const byContent = explicitAnchor
      ? await locateByAnchor(relPath, explicitAnchor, line)
      : await locateByFindingAnchor(relPath, findingId!);
    if (byContent) {
      startLine = byContent.startLine;
      stopLine = byContent.endLine;
    }
  }

  const total = session.fileState(relPath)?.totalLines ?? 0;
  if (total > 0) {
    startLine = Math.min(startLine, total);
    stopLine = Math.min(stopLine, total);
  }
  return { startLine, stopLine };
}

/**
 * Reveals a finding in the document panel and SCROLLS it into view. Thin
 * composition over {@link resolveLiveRange} (the line-resolution authority) plus
 * the two side effects — opening the panel and scrolling. Callers that only need
 * the line (e.g. opening the fix panel without moving the document) should call
 * `resolveLiveRange` directly instead of this.
 */
async function locateInFile(
  relPath: string,
  line: number,
  endLine?: number,
  findingId?: string,
  explicitAnchor?: string,
): Promise<void> {
  if (!ensureReviewPath(relPath, m().actions.locate)) {
    return;
  }
  if (DocumentPanel.currentPath !== relPath) {
    await openFileInPanel(relPath);
  }
  const { startLine, stopLine } = await resolveLiveRange(
    relPath,
    line,
    endLine,
    findingId,
    explicitAnchor,
  );
  DocumentPanel.scrollTo(startLine, stopLine);
}

/**
 * Locates a finding by its verbatim `anchor` snippet in the live document,
 * returning 1-based start/end lines. Content-based, so it survives line drift
 * from edits or earlier fixes. Returns undefined when the finding has no anchor
 * or the snippet can no longer be found uniquely (caller falls back to lines).
 */
async function locateByFindingAnchor(
  rel: string,
  findingId: string,
): Promise<{ startLine: number; endLine: number } | undefined> {
  const finding = session.findings(rel).find((f) => f.id === findingId);
  if (!finding?.anchor) {
    return undefined;
  }
  return locateByAnchor(rel, finding.anchor, finding.line);
}

/** Locates an explicit verbatim anchor in a live review file. */
async function locateByAnchor(
  rel: string,
  anchor: string,
  preferredLine?: number,
): Promise<{ startLine: number; endLine: number } | undefined> {
  const cwd = activeCwd();
  if (!cwd) {
    return undefined;
  }
  try {
    const fileUri = vscode.Uri.joinPath(vscode.Uri.file(cwd), rel);
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const hit = locateSnippetLines(
      doc.getText().split(/\r?\n/),
      anchor,
      preferredLine,
    );
    if (!hit) {
      return undefined;
    }
    return { startLine: hit.line, endLine: hit.endLine };
  } catch (err) {
    console.warn('[codereview] locateByAnchor failed:', err);
    return undefined;
  }
}

/**
 * Locates the current line range of an applied fix by searching the live
 * document for its `newText`. Returns 1-based start/end lines, or undefined when
 * no applied fix exists or the snippet can no longer be found uniquely.
 */
async function reanchorToAppliedFix(
  rel: string,
  findingId: string,
): Promise<{ startLine: number; endLine: number } | undefined> {
  const edit = getAppliedFix(rel, findingId);
  if (!edit) {
    return undefined;
  }
  const cwd = activeCwd();
  if (!cwd) {
    return undefined;
  }
  try {
    const fileUri = vscode.Uri.joinPath(vscode.Uri.file(cwd), rel);
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const hit = locateSnippetLines(doc.getText().split(/\r?\n/), edit.newText);
    if (!hit) {
      return undefined;
    }
    return { startLine: hit.line, endLine: hit.endLine };
  } catch (err) {
    console.warn('[codereview] reanchorToAppliedFix failed:', err);
    return undefined;
  }
}


/** Computes the next not-yet-seen line in a file and scrolls the panel to it. */
function jumpToNextUnseen(relPath: string): void {
  if (!ensureReviewPath(relPath, m().actions.jump)) {
    return;
  }
  const state = session.fileState(relPath);
  if (!state) {
    return;
  }
  const total = state.totalLines;
  if (total <= 0) {
    transientInfo(m().analysis.fileNotLoaded);
    return;
  }
  const seen = new Set(state.seenLines);
  let target = -1;
  for (let l = 1; l <= total; l++) {
    if (!seen.has(l)) {
      target = l;
      break;
    }
  }
  if (target < 0) {
    transientInfo(m().analysis.allRead);
    return;
  }
  DocumentPanel.scrollTo(target);
}

/** Jumps to the next unseen line in the file currently shown in the panel. */
function jumpToNextUnseenCurrent(): void {
  const rel = DocumentPanel.currentPath ?? workbenchSelected;
  if (!rel) {
    transientWarning(m().analysis.pickFile);
    return;
  }
  jumpToNextUnseen(rel);
}

async function submitConclusion(): Promise<void> {
  if (!session.workflow || !session.reviewSet) {
    transientWarning(m().review.notStartedWarn);
    return;
  }
  await session.updateWorkflow((state) => { state.stage = 'conclusion'; }, false);
  await openWorkbench();
}

async function submitCenterConclusion(verdict: ReviewVerdict, notes: string, preview: string): Promise<void> {
  if (centerSubmitting) throw new Error(m().reviewCenter.submitting);
  if (scopePickInFlight) throw new WorkflowError('running');
  reviewCoordinator.assertInputsAvailable();
  reviewCoordinator.assertNoDraft();
  const workflow = session.workflow;
  const snapshot = session.snapshot;
  if (!workflow || !snapshot) throw new WorkflowError('noReview');
  if (notes.length > 64_000 || verdict !== workflow.verdict || preview !== centerPreview(notes)) throw new WorkflowError('confirmationChanged');
  const blockers = session.workflowBlockers(verdict);
  if (blockers.length) throw new WorkflowError(blockers[0].code, blockers[0].detail);
  const set = requireReviewSet();
  const cwd = requireReviewCwd();
  const frozenBody = composeReviewReport(centerReportBase(), notes, m().reviewCenter.notes);
  const bodySignature = centerSubmissionSignature(verdict, notes);
  const alreadyRecorded = snapshot.conclusion?.verdict === verdict && snapshot.conclusion.bodySignature === bodySignature;
  const pr = /^pr-(\d+)$/.exec(set.scopeId);
  const prNumber = pr ? Number(pr[1]) : undefined;
  const pending = structuredClone(session.pendingComments.length ? session.pendingComments : session.conclusion?.inlineComments ?? []);
  const current = () => session.snapshot === snapshot && session.workflow?.run.id === workflow.run.id
    && !reviewCoordinator.editing && !session.workflowBlockers(verdict).length && centerPreview(notes) === preview;
  const validate = async () => {
    if (!current()) throw new WorkflowError('confirmationChanged');
    await reviewCoordinator.validateCurrentResults();
    if (prNumber !== undefined) {
      const remote = await getPrByNumber(cwd, prNumber);
      if (!set.prUrl || remote.headRefOid !== set.headSha || remote.url !== set.prUrl) throw new WorkflowError('staleResults');
    }
    if (!current()) throw new WorkflowError('confirmationChanged');
  };
  centerSubmitting = true;
  centerEpoch++;
  WorkbenchPanel.refreshNow();
  let published = false;
  let attemptedPublish = false;
  let publishedBody = '';
  try {
    if (workflow.notes !== notes) await session.updateWorkflow((state) => { state.notes = notes; }, workflow.notes.trim() !== notes.trim());
    await validate();
    await session.flushWorkflowEvidence();
    if (alreadyRecorded) {
      centerNotice(fmt(m().reviewCenter.recorded, verdict === 'approve' ? m().reviewCenter.approve : verdict === 'comment' ? m().reviewCenter.comment : m().reviewCenter.requestChanges));
      return;
    }
    if (verdict === 'approve') {
      const approved = await vscode.window.showWarningMessage(
        `${fmt(m().reviewCenter.confirmApprovalBody, set.label, set.headSha === 'live' ? m().reviewCenter.workspaceSnapshot : set.headSha, currentRequirements(workflow).length ? workflow.baseline?.version ?? 0 : m().reviewCenter.technical)}\n\n${prNumber === undefined ? m().reviewCenter.localApprovalBody : fmt(m().reviewCenter.prApprovalBody, prNumber)}`,
        { modal: true }, m().reviewCenter.confirmApprove,
      );
      if (approved !== m().reviewCenter.confirmApprove) return;
    }
    await validate();
    if (prNumber !== undefined) {
      const body = frozenBody;
      publishedBody = frozenBody;
      const repository = set.prUrl ? new URL(set.prUrl).pathname.split('/').slice(1, 3).join('/') : undefined;
      attemptedPublish = true;
      await submitPrReviewWithComments(cwd, prNumber, set.headSha, verdict, body, pending, repository);
      published = true;
    }
    let valid = current();
    if (published && valid) {
      try { await validate(); }
      catch (error) { valid = false; centerNotice(workflowErrorText(error), true); }
    }
    const conclusion: ReviewConclusion = {
      verdict, label: verdict === 'approve' ? m().reviewCenter.approve : verdict === 'comment' ? m().reviewCenter.comment : m().reviewCenter.requestChanges,
      target: prNumber === undefined ? 'local' : 'pr', prNumber, submittedAt: Date.now(),
      headSha: set.headSha, baselineVersion: workflow.baseline?.version, bodySignature,
      repositoryStamp: workflow.run.repositoryStamp, resultKey: workflow.run.key,
      runId: workflow.run.id,
      body: publishedBody || frozenBody, inlineComments: pending,
    };
    if (published) snapshot.pendingComments = snapshot.pendingComments?.filter((item) => !pending.some((sent) => sent.id === item.id));
    await session.recordWorkflowConclusion(conclusion, snapshot, valid);
    centerNotice(valid ? fmt(published ? m().reviewCenter.submitted : m().reviewCenter.recorded, conclusion.label) : m().reviewCenter.oldSnapshotSubmitted);
  } catch (error) {
    centerNotice(published ? `${m().reviewCenter.postedButNotSaved}\n${m().review.saveFailed(workflowErrorText(error))}`
      : `${workflowErrorText(error)}${attemptedPublish ? `\n${m().reviewCenter.submissionUncertain}` : ''}`, true);
  } finally {
    centerSubmitting = false;
    centerEpoch++;
    WorkbenchPanel.refreshNow();
  }
}

/**
 * Lists the pending (draft) PR review comments in a quick pick. Selecting one
 * jumps to its location; the trash button removes it. They are submitted
 * together with the conclusion (pending-review model), not individually.
 */
async function viewPendingComments(): Promise<void> {
  if (session.pendingComments.length === 0) {
    transientInfo(m().documentPanel.commentNonePending);
    return;
  }
  const targetLang = resolveLanguage();
  const trash: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('trash'),
    tooltip: m().documentPanel.commentDelete,
  };
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { id: string }>();
  let hidden = false;
  const build = () =>
    session.pendingComments.map((pc) => ({
      label:
        pc.startLine === pc.endLine
          ? `${pc.path}:${pc.startLine}`
          : `${pc.path}:${pc.startLine}-${pc.endLine}`,
      detail: localizePendingCommentBodyNow(pc, targetLang),
      buttons: [trash],
      id: pc.id,
    }));
  const retitle = () => {
    qp.title = `${m().documentPanel.pendingTitle} (${session.pendingComments.length})`;
  };
  qp.placeholder = m().documentPanel.pendingPlaceholder;
  qp.items = build();
  retitle();
  qp.onDidTriggerItemButton((e) => {
    session.removePendingComment(e.item.id);
    if (session.pendingComments.length === 0) {
      qp.hide();
      return;
    }
    qp.items = build();
    retitle();
  });
  qp.onDidAccept(() => {
    const sel = qp.selectedItems[0];
    qp.hide();
    if (sel) {
      const pc = session.pendingComments.find((p) => p.id === sel.id);
      if (pc) {
        void locateInFile(pc.path, pc.startLine, pc.endLine);
      }
    }
  });
  qp.show();
  void ensurePendingCommentsLocalized().then((changed) => {
    if (!changed || hidden) {
      return;
    }
    qp.items = build();
    retitle();
  });
  qp.onDidHide(() => {
    hidden = true;
    qp.dispose();
  });
}

function reportError(err: unknown): void {
  const message =
    err instanceof AnalysisError ? err.message : String((err as Error)?.message ?? err);
  void vscode.window.showErrorMessage(m().review.error(message));
}

function workspaceFolderPath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function workspaceFolderName(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.name;
}

/** Active review's cwd, falling back to the first workspace folder when no review is loaded. */
function activeCwd(): string | undefined {
  return session.getCwd();
}

/**
 * Older versions hid `workbench.activityBar.location` globally and didn't always
 * restore it. If we still see that lingering value, clear it once per machine so
 * the activity bar reappears for the user.
 */
async function restoreGloballyHiddenActivityBar(context: vscode.ExtensionContext): Promise<void> {
  const FLAG = 'codereview.activityBarRestored.v1';
  if (context.globalState.get<boolean>(FLAG)) {
    return;
  }
  try {
    const wb = vscode.workspace.getConfiguration('workbench');
    if (wb.inspect<string>('activityBar.location')?.globalValue === 'hidden') {
      await wb.update('activityBar.location', undefined, vscode.ConfigurationTarget.Global);
    }
  } catch (err) {
    console.warn('[codereview] activity bar restore failed:', err);
  } finally {
    await context.globalState.update(FLAG, true);
  }
}

export function deactivate(): void {
  // nothing to clean up beyond context.subscriptions
}
