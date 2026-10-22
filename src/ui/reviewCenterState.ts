import { m, fmt } from '../i18n';
import { findingContentSignature, isActionableFinding, type Finding } from '../ai/types';
import { businessBindingKey, businessHash, businessBlockers, coverageComplete, type BusinessCitation, type BusinessFinding } from '../review/businessReview';
import type { BusinessReviewStatus } from '../review/businessReview';
import { ConclusionDraftDataError, type ConclusionDraft, type ConclusionVerdict } from '../review/conclusionDraft';
import { legacySelectionId, type ReviewWorkspaceView } from '../review/reviewWorkspace';
import type { ReviewSession } from '../review/reviewSession';
import type { RequirementItem } from '../review/requirements';
import { businessReportReferences } from './businessReviewPanel';
import { esc, escAttr } from './html';
import { renderRequirementMarkdown } from './requirementMarkdown';
import { tokenSummary, tokenTooltip } from './workbenchPanel';

export type CenterReference =
  | { kind: 'business'; citation: BusinessCitation }
  | { kind: 'legacy'; path: string; line: number; endLine?: number };

export interface CenterRow {
  id: string;
  kind: 'unit' | 'finding' | 'critical' | 'legacy';
  title: string;
  detail: string;
  badge?: string;
  tone?: string;
}

export interface CenterInspector {
  title: string;
  subtitle: string;
  html: string;
  primaryReference?: string;
  primaryFile?: { path: string; line?: number };
  findingId?: string;
  canFix?: boolean;
  legacy?: { path: string; id: string };
}

export interface CenterConclusion {
  draft?: ConclusionDraft;
  error?: string;
  stale: boolean;
  previewCurrent: boolean;
  previewHtml?: string;
  canApprove: boolean;
  canComment: boolean;
  canRequestChanges: boolean;
  publishBusy: boolean;
  target: string;
  blockers: string[];
  confirmed: boolean;
  published: boolean;
  unknownAttempt?: { id: string; error?: string };
}

export interface ReviewCenterState {
  contextKey: string;
  view: ReviewWorkspaceView;
  viewError?: string;
  scope: string;
  repository: string;
  head: string;
  base?: string;
  running: boolean;
  analysisBusy: boolean;
  globalRunning: boolean;
  runStatus?: BusinessReviewStatus;
  isPr: boolean;
  requirementStatus: string;
  progress: string;
  model: string;
  language: string;
  units: CenterRow[];
  findings: CenterRow[];
  legacy: CenterRow[];
  inspector: CenterInspector;
  conclusion: CenterConclusion;
  status: string;
  sourceCoverage: { reviewed: number; total: number };
  tokens?: { label: string; tooltip: string };
}

export function centerReferenceId(ref: CenterReference): string {
  return businessHash(JSON.stringify(ref));
}

export function reviewCenterContextKey(session: ReviewSession): string {
  if (!session.reviewSet || !session.getCwd()) return '';
  return businessHash(JSON.stringify([
    businessBindingKey(session.getCwd()!, session.reviewSet, session.requirements),
    session.businessReview?.id, [...centerLegacyFindings(session).keys()],
  ]));
}

export function centerReferences(session: ReviewSession): Map<string, CenterReference> {
  const all: CenterReference[] = session.businessReview
    ? businessReportReferences(session.businessReview).map((citation) => ({ kind: 'business', citation })) : [];
  for (const [path, state] of Object.entries(session.snapshot?.perFile ?? {})) {
    if (!session.hasReviewFile(path)) continue;
    for (const finding of state.findings) {
      for (const evidence of finding.verification?.evidence ?? []) {
        all.push({ kind: 'legacy', path: evidence.file, line: evidence.line, endLine: evidence.endLine });
      }
    }
  }
  return new Map(all.map((ref) => [centerReferenceId(ref), ref]));
}

export function centerLegacyFindings(session: ReviewSession): Map<string, { path: string; finding: Finding }> {
  const result = new Map<string, { path: string; finding: Finding }>();
  for (const [path, state] of Object.entries(session.snapshot?.perFile ?? {})) {
    if (!session.hasReviewFile(path)) continue;
    for (const finding of state.findings) result.set(legacySelectionId(path, findingContentSignature(finding)), { path, finding });
  }
  return result;
}

function sourceLink(ref: CenterReference): string {
  const path = ref.kind === 'business' ? ref.citation.path : ref.path;
  const line = ref.kind === 'business' ? ref.citation.line : ref.line;
  return `<button class="reference-link" data-center-action="reference" data-id="${centerReferenceId(ref)}">${esc(path)} · L${line}</button>`;
}

function citations(refs: readonly BusinessCitation[]): string {
  return refs.map((citation) => `<details class="reference-card"><summary>${esc(citation.path)} [${citation.side}] · L${citation.line}–${citation.endLine}</summary>
    <pre>${esc(citation.quote)}</pre><small>sha256 ${esc(citation.sourceHash)}</small>${sourceLink({ kind: 'business', citation })}</details>`).join('');
}

function rulesHtml(session: ReviewSession, rules: readonly RequirementItem[]): string {
  const run = session.businessReview;
  return rules.map((rule) => `<details class="rule"><summary>${esc(rule.id)} · ${esc(rule.title)}</summary><div class="markdown">${renderRequirementMarkdown(rule.text)}</div>
    <small>${esc(rule.basis === 'human' ? m().requirements.human : m().requirements.explicit)}</small>
    ${rule.origins.map((origin) => {
      const source = run?.baseline.materials.find((source) => source.sourceId === origin.sourceId && source.version === origin.version);
      const citation: BusinessCitation = {
        evidenceId: `origin-${origin.sourceId}-${origin.version}-${origin.line}`, kind: 'material', side: 'material',
        sourceId: origin.sourceId, version: origin.version, sourceHash: source?.hash ?? '',
        path: source?.path ?? origin.sourceId, line: origin.line, endLine: origin.endLine, quote: origin.quote,
      };
      return sourceLink({ kind: 'business', citation });
    }).join('')}</details>`).join('');
}

function findingInspector(session: ReviewSession, finding: BusinessFinding): CenterInspector {
  const t = m().reviewCenter;
  const b = m().businessReview;
  const run = session.businessReview!;
  const rules = run.baseline.requirements.filter((rule) => finding.requirementIds.includes(rule.id));
  const primary = finding.evidence.find((ref) => ref.kind === 'code' && ref.side === 'head') ?? finding.evidence[0] ?? finding.counterEvidence[0];
  const note = run.dispositions[finding.id];
  const tab = session.workspaceView.inspector;
  const html = tab === 'evidence'
    ? `<h3>${esc(b.evidenceLabel)}</h3>${citations(finding.evidence)}<h3>${esc(b.counterEvidence)}</h3>${citations(finding.counterEvidence)}<p>${esc(finding.counterRationale)}</p>`
    : tab === 'handling'
      ? `<p class="boundary">${esc(t.history)}</p>${note ? `<article class="markdown">${renderRequirementMarkdown(note.reason)}</article><small>${new Date(note.at).toISOString()}</small>` : `<p>${esc(t.notPublished)}</p>`}`
      : `<h3>${esc(t.requirements)}</h3>${rules.length ? rulesHtml(session, rules) : `<p>${esc(run.mode === 'technical' ? b.modeTechnical : b.evidenceLabel)}</p>`}
        <h3>${esc(t.cause)}</h3><div class="markdown">${renderRequirementMarkdown(finding.cause)}</div>
        <h3>${esc(t.trigger)}</h3><div class="markdown">${renderRequirementMarkdown(finding.trigger)}</div>
        <h3>${esc(t.impact)}</h3><div class="markdown">${renderRequirementMarkdown(finding.impact)}</div>
        <h3>${esc(b.counterRationale)}</h3><p>${esc(finding.counterRationale)}</p>
        ${finding.critical ? `<div class="boundary warning"><strong>${esc(b.criticalBlocked)}</strong><p>${esc(finding.critical.dependsOn)}</p><p>${esc(finding.critical.impact)}</p><p>${esc(finding.critical.missingEvidence)}</p><p>${esc(finding.critical.question)}</p></div>` : ''}`;
  return {
    title: finding.title, subtitle: `${b[finding.kind]} · ${b[finding.status]} · ${b[finding.severity]} · ${b[finding.attribution]}`,
    html, primaryReference: primary ? centerReferenceId({ kind: 'business', citation: primary }) : undefined, findingId: finding.id,
    canFix: finding.kind === 'implementation' && finding.status === 'confirmed',
  };
}

export function buildReviewCenterState(
  session: ReviewSession, input: { running: boolean; analysisBusy?: boolean; globalRunning?: boolean; publishBusy: boolean; model: string; language: string },
): ReviewCenterState {
  const t = m().reviewCenter;
  const b = m().businessReview;
  const run = session.businessReview;
  const view = session.workspaceView;
  const set = session.reviewSet;
  const legacy = centerLegacyFindings(session);
  const units: CenterRow[] = (run?.units ?? []).map((unit) => ({
    id: unit.id, kind: 'unit', title: unit.goal, detail: unit.files.join(' · '), badge: unit.id,
  }));
  const findings: CenterRow[] = (run?.findings ?? []).map((finding) => ({
    id: finding.id, kind: 'finding', title: finding.title,
    detail: finding.evidence.filter((ref) => ref.kind === 'code').map((ref) => ref.path).join(' · '),
    badge: `${b[finding.kind]} · ${b[finding.status]}`, tone: finding.status === 'confirmed' ? 'error' : finding.status === 'unresolved' ? 'warning' : 'ok',
  }));
  findings.push(...(run?.priorCritical ?? []).map((item): CenterRow => ({
    id: item.id, kind: 'critical', title: item.title, detail: b.priorCritical,
    badge: b[run?.priorCriticalVerdicts.find((verdict) => verdict.id === item.id)?.status ?? 'unknown'], tone: 'warning',
  })));
  const legacyRows: CenterRow[] = [...legacy].map(([id, { path, finding }]) => ({
    id, kind: 'legacy', title: finding.title, detail: `${path} · L${finding.line}`, badge: m().severity[finding.severity],
  }));
  const reviewed = run?.coverage.filter(coverageComplete).length ?? 0;
  const total = run?.coverage.length ?? 0;
  let inspector: CenterInspector = {
    title: t.overview, subtitle: session.requirementStatus,
    html: `<p class="boundary">${esc(b.boundary)}</p><h3>${esc(b.coverage)}</h3><p>${reviewed}/${total}</p>
      <h3>${esc(b.limits)}</h3>${run ? [...businessBlockers(run), ...run.limitations, ...run.errors].map((reason) => `<p>${esc(reason)}</p>`).join('') : `<p>${esc(t.noRun)}</p>`}
      <h3>${esc(t.evidenceRequests)}</h3>${(run?.requests ?? []).map((result) => `<details><summary>${esc(result.request.symbol)} · ${esc(result.request.kind)}</summary><p>${esc(result.request.question)}</p><p>${esc(result.paths.join(', '))}</p>${result.error ? `<p class="error-text">${esc(result.error)}</p>` : ''}</details>`).join('')}
      <h3>${esc(b.requirementStatus)}</h3>${(run?.requirements ?? []).map((verdict) => {
        const rule = [...run!.baseline.requirements, ...run!.baseline.excluded].find((rule) => rule.id === verdict.id);
        return `<details><summary>${esc(verdict.id)} · ${esc(b[verdict.status])} · ${esc(rule?.title ?? '')}</summary><p>${esc(verdict.rationale)}</p>${rule ? rulesHtml(session, [rule]) : ''}${citations(verdict.evidence)}</details>`;
      }).join('')}`,
  };
  const selected = view.selection;
  let validSelection = selected.kind === 'overview';
  if (selected.kind === 'finding') {
    const finding = run?.findings.find((finding) => finding.id === selected.id);
    if (finding) { inspector = findingInspector(session, finding); validSelection = true; }
  } else if (selected.kind === 'unit') {
    const unit = run?.units.find((unit) => unit.id === selected.id);
    if (unit) {
      validSelection = true;
      inspector = {
        title: unit.goal, subtitle: t.unitBoundary, primaryFile: unit.files[0] ? { path: unit.files[0] } : undefined,
        html: `<h3>${esc(t.requirements)}</h3>${rulesHtml(session, run!.baseline.requirements.filter((rule) => unit.requirementIds.includes(rule.id)))}
        <h3>${esc(t.formalFiles)}</h3>${unit.files.map((path) => `<button class="reference-link" data-center-action="file" data-path="${escAttr(path)}">${esc(path)}</button>`).join('')}
        ${(run?.unitSummaries ?? []).filter((summary) => summary.id.startsWith(`${unit.id}-`)).map((summary) => `<div class="markdown">${renderRequirementMarkdown(summary.text)}</div>`).join('')}`,
      };
    }
  } else if (selected.kind === 'critical') {
    const item = run?.priorCritical.find((item) => item.id === selected.id);
    if (item) {
      const verdict = run?.priorCriticalVerdicts.find((verdict) => verdict.id === item.id);
      validSelection = true;
      inspector = {
        title: item.title, subtitle: `${b.priorCritical} · ${b[verdict?.status ?? 'unknown']}`,
        html: `<div class="markdown">${renderRequirementMarkdown(item.detail)}</div><p>${esc(verdict?.rationale ?? b.criticalBlocked)}</p>${citations(verdict?.evidence ?? [])}`,
        primaryReference: verdict?.evidence[0] ? centerReferenceId({ kind: 'business', citation: verdict.evidence[0] }) : undefined,
      };
    }
  } else if (selected.kind === 'legacy') {
    const item = legacy.get(selected.id);
    if (item) {
      const { path, finding } = item;
      validSelection = true;
      inspector = {
        title: finding.title, subtitle: `${t.moreTools} · ${m().severity[finding.severity]}`,
        html: `<div class="markdown">${renderRequirementMarkdown(finding.detail)}</div><p>${esc(finding.verification?.rationale ?? b.legacyUnverified)}</p>
          ${(finding.verification?.evidence ?? []).map((ref) => sourceLink({ kind: 'legacy', path: ref.file, line: ref.line, endLine: ref.endLine })).join('')}`,
        primaryFile: { path, line: finding.line }, legacy: isActionableFinding(finding) ? { path, id: finding.id } : undefined,
      };
    }
  }
  let draft: ConclusionDraft | undefined;
  let draftError: string | undefined;
  try { draft = session.conclusionDraft; }
  catch (error) {
    if (!(error instanceof ConclusionDraftDataError)) throw error;
    draftError = error.message;
  }
  const pr = set?.scopeId.match(/^pr-(\d+)$/);
  const stale = !!draft && draft.bindingKey !== session.conclusionBinding;
  const published = !!draft && (!!session.snapshot?.postedConclusions?.some((receipt) => receipt.draftId === draft.id && receipt.draftRevision === draft.revision)
    || session.conclusion?.draftId === draft.id && session.conclusion.draftRevision === draft.revision);
  const unknownAttempt = session.snapshot?.publicationAttempts?.find((attempt) => attempt.status === 'unknown' && !attempt.checked);
  const usage = session.tokenUsage;
  const tokens = usage ? { input: usage.totalInput, output: usage.totalOutput, calls: usage.calls, byOp: usage.byOp } : undefined;
  return {
    contextKey: reviewCenterContextKey(session), view, viewError: session.workspaceViewError ?? (!validSelection ? t.viewChanged : undefined),
    scope: set?.label ?? '', repository: set?.repositoryIdentity ?? session.getRepoLabel(), head: set?.headSha ?? '',
    base: set?.comparison?.baseSha, running: input.running, analysisBusy: !!input.analysisBusy, globalRunning: !!input.globalRunning, runStatus: run?.status, isPr: !!pr, requirementStatus: session.requirementStatus,
    model: input.model, language: input.language,
    progress: input.running && run?.status !== 'running' ? b.read : run ? fmt(b.progress, b[run.phase], reviewed, total, run.calls) : t.noRun,
    units, findings, legacy: legacyRows, inspector,
    status: input.running ? b.running : run ? `${b[run.status]} · ${run.modelId}` : t.noRun, sourceCoverage: { reviewed, total },
    tokens: tokens ? { label: `${m().workbench.tokens}: ${tokenSummary(tokens, m().workbench)}`, tooltip: tokenTooltip(tokens, m().workbench) } : undefined,
    conclusion: {
      draft, error: draftError, stale: stale && !published, published,
      unknownAttempt: unknownAttempt ? { id: unknownAttempt.id, error: unknownAttempt.error } : undefined,
      previewCurrent: !draftError && !stale && session.conclusionPreviewCurrent,
      previewHtml: draft?.previewKey ? renderRequirementMarkdown(draft.body) : undefined,
      canApprove: !input.running && !input.analysisBusy && session.canSubmitConclusion('approve'),
      canComment: !input.running && !input.analysisBusy && session.canSubmitConclusion('comment'),
      canRequestChanges: !input.running && !input.analysisBusy && session.canSubmitConclusion('request-changes'),
      publishBusy: input.publishBusy,
      target: pr ? `${set?.repositoryIdentity ?? session.getRepoLabel()} · PR #${pr[1]}` : `${session.getRepoLabel()} · ${t.localTarget}`,
      blockers: input.running || input.analysisBusy ? [b.incomplete] : run ? businessBlockers(run) : session.technicalGatePassed() ? [] : [b.incomplete],
      confirmed: run?.confirmed ?? false,
    },
  };
}

export interface CenterDraftEdit {
  id: string;
  revision: number;
  body: string;
  verdict: ConclusionVerdict;
}

export interface CenterAction {
  type: 'center';
  action: 'ready' | 'stage' | 'navigator' | 'select' | 'file' | 'reference' | 'inspector' | 'focus' | 'next'
    | 'run' | 'cancel' | 'model' | 'language' | 'export' | 'confirmReport' | 'note' | 'fix'
    | 'generateDraft' | 'savePreview' | 'previewRendered' | 'publish' | 'appendFinding' | 'legacyAnalyze' | 'legacyGlobal' | 'checkPublication';
  contextKey: string;
  id?: string;
  kind?: string;
  value?: string;
  path?: string;
  revision?: number;
  previewKey?: string;
  clientId?: string;
  requestId?: number;
  draft?: CenterDraftEdit;
}
