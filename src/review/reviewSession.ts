import * as vscode from 'vscode';
import * as path from 'node:path';
import { m } from '../i18n';
import type { ReviewFile, ReviewSet } from '../scope/types';
import {
  findingAnalysisRoots,
  findingContentSignatures,
  findingHasAnalysisRoot,
  globalFixSpotSignatures,
  isActionableFinding,
  type FileAnalysisSummary,
  type Finding,
  type GlobalReport,
} from '../ai/types';
import type { TokenUsage } from '../ai/analyzer';
import type { PerFileState, ReviewKey, ReviewSnapshot, ReviewStore, Annotation, ReviewConclusion, FindingDisposition, PendingComment, TokenAccount } from './reviewStore';
import { isBlankFileState } from './reviewStore';

export interface ReviewSessionChange {
  filePath?: string;
  structureChanged?: boolean;
}

export interface ReviewInvalidation {
  changed: boolean;
  affectedFiles: string[];
  removedFiles: string[];
}

export interface RootedFindingsUpdate {
  addedFiles: string[];
  updatedFiles: string[];
  removedFiles: string[];
}

/**
 * Holds the in-memory state of the active review and persists it through a
 * ReviewStore. Emits onDidChange whenever progress changes so UI can refresh.
 */
export class ReviewSession {
  private readonly _onDidChange = new vscode.EventEmitter<ReviewSessionChange>();
  readonly onDidChange = this._onDidChange.event;
  private readonly pendingFilePersists = new Map<string, ReturnType<typeof setTimeout>>();
  private reviewFilesByPath = new Map<string, ReviewFile>();
  private deletedPaths = new Set<string>();
  private structureVersion = 0;

  reviewSet?: ReviewSet;
  snapshot?: ReviewSnapshot;
  /** Workspace folder picked for this review (set by start()). */
  private cwd?: string;
  /** Repo name override for the active review (typically basename of cwd). */
  private repoName?: string;

  constructor(
    private readonly store: ReviewStore,
    private readonly defaultRepo: string,
  ) {}

  /**
   * Returns the working directory for the active review (the picked workspace
   * folder). Falls back to the first workspace folder when no review is active.
   */
  getCwd(): string | undefined {
    return this.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** Returns the repo name used as the storage key prefix for the active review. */
  getRepoName(): string {
    return this.repoName ?? this.defaultRepo;
  }

  /** Loads or initialises review progress for the given review set. */
  async start(reviewSet: ReviewSet, cwd?: string): Promise<void> {
    await this.flushPendingFilePersists();
    this.cwd = cwd;
    this.repoName = cwd ? path.basename(cwd) : this.defaultRepo;
    const repo = this.repoName;
    const key: ReviewKey = {
      repo,
      scopeId: reviewSet.scopeId,
      headSha: reviewSet.headSha,
    };

    // Scope-level data (global report / conclusion / token usage) stays keyed to
    // the scope. Per-FILE progress (reading / findings / dispositions / notes)
    // now lives in its own per-file store so it follows the file across scope
    // re-selections instead of vanishing when the scope id changes.
    let scopeSnap = await this.store.load(key);
    if (!scopeSnap && reviewSet.headSha === 'live' && this.store.findLatestForScope) {
      const legacy = await this.store.findLatestForScope(repo, reviewSet.scopeId);
      if (legacy) {
        scopeSnap = { ...legacy, headSha: 'live' };
      }
    }

    const originalPaths = new Set(reviewSet.files.map((file) => file.path));
    const contextFiles = [...new Set(
      (scopeSnap?.contextFiles ?? [])
        .map((filePath) => filePath.replaceAll('\\', '/').replace(/^\.\//, ''))
        .filter((filePath) =>
          !!filePath
          && filePath !== '..'
          && !filePath.startsWith('../')
          && !originalPaths.has(filePath),
        ),
    )];
    const effectiveFiles: ReviewFile[] = [
      ...reviewSet.files,
      ...contextFiles.map((filePath) => ({ path: filePath, context: true })),
    ];
    this.reviewSet = { ...reviewSet, files: effectiveFiles };
    this.reviewFilesByPath = new Map(effectiveFiles.map((file) => [file.path, file]));
    this.deletedPaths = new Set(
      effectiveFiles.filter((file) => file.status === 'deleted').map((file) => file.path),
    );
    this.structureVersion++;

    // Keep state sparse: untouched files do not allocate promises or empty
    // PerFileState objects. Existing progress is loaded in one key scan.
    const perFile: Record<string, PerFileState> = {};
    const toMigrate: string[] = [];
    const activePaths = new Set(this.reviewFilesByPath.keys());
    const stored = await this.loadStoredFileStates(repo, activePaths);
    for (const [filePath, state] of stored) {
      if (!isBlankFileState(state)) {
        perFile[filePath] = normaliseFileState(state);
      }
    }

    const legacyIndex = this.store.buildLegacyFileIndex
      ? await this.store.buildLegacyFileIndex(repo)
      : new Map<string, PerFileState>();
    for (const [filePath, state] of Object.entries(scopeSnap?.perFile ?? {})) {
      if (!legacyIndex.has(filePath)) {
        legacyIndex.set(filePath, state);
      }
    }
    for (const [filePath, recovered] of legacyIndex) {
      if (
        activePaths.has(filePath)
        && !perFile[filePath]
        && !isBlankFileState(recovered)
      ) {
        perFile[filePath] = normaliseFileState(recovered);
        toMigrate.push(filePath);
      }
    }

    this.snapshot = {
      repo,
      scopeId: reviewSet.scopeId,
      headSha: reviewSet.headSha,
      perFile,
      contextFiles,
      analysisDependencies: scopeSnap?.analysisDependencies,
      globalReport: scopeSnap?.globalReport,
      globalDone: scopeSnap?.globalDone ?? false,
      globalFixDispositions: scopeSnap?.globalFixDispositions,
      conclusion: scopeSnap?.conclusion,
      pendingComments: scopeSnap?.pendingComments,
      tokenUsage: scopeSnap?.tokenUsage,
      updatedAt: Date.now(),
    };
    // Surface the panel immediately; persist migrated/initial state in the
    // background so a large review set doesn't block opening.
    this._onDidChange.fire({ structureChanged: true });
    void this.persistInBackground(repo, toMigrate);
  }

  /**
   * Persists the freshly-assembled scope snapshot and any per-file records that
   * were migrated or newly created — off the startup path so a large review set
   * opens immediately.
   */
  private async persistInBackground(repo: string, migratedPaths: string[]): Promise<void> {
    if (!this.snapshot) {
      return;
    }
    try {
      if (this.store.saveFile) {
        for (const p of migratedPaths) {
          const s = this.snapshot.perFile[p];
          if (s) {
            await this.store.saveFile(repo, p, s);
          }
        }
      }
      await this.persistScopeMeta();
    } catch {
      // Non-fatal: progress stays in memory and re-persists on the next change.
    }
  }

  fileState(path: string): PerFileState | undefined {
    return this.snapshot?.perFile[path];
  }

  /** Adds confirmed out-of-scope bug locations to the active review and persists them. */
  addContextReviewFiles(paths: readonly string[]): string[] {
    if (!this.reviewSet || !this.snapshot) {
      return [];
    }
    const added: string[] = [];
    const files = [...this.reviewSet.files];
    for (const filePath of paths) {
      const normalized = filePath.replaceAll('\\', '/').replace(/^\.\//, '');
      if (
        !normalized
        || normalized === '..'
        || normalized.startsWith('../')
        || this.reviewFilesByPath.has(normalized)
      ) {
        continue;
      }
      const file: ReviewFile = { path: normalized, context: true };
      files.push(file);
      this.reviewFilesByPath.set(normalized, file);
      added.push(normalized);
    }
    if (added.length === 0) {
      return [];
    }
    this.reviewSet = { ...this.reviewSet, files };
    this.snapshot.contextFiles = [
      ...new Set([...(this.snapshot.contextFiles ?? []), ...added]),
    ];
    this.structureVersion++;
    void this.persistScopeMeta().catch(() => {/* non-fatal */});
    this._onDidChange.fire({ structureChanged: true });
    return added;
  }

  private ensureFileState(path: string): PerFileState | undefined {
    if (!this.snapshot || !this.reviewFilesByPath.has(path)) {
      return undefined;
    }
    return (this.snapshot.perFile[path] ??= normaliseFileState(undefined));
  }

  private async loadStoredFileStates(
    repo: string,
    activePaths: ReadonlySet<string>,
  ): Promise<Map<string, PerFileState>> {
    if (this.store.loadFiles) {
      return this.store.loadFiles(repo, activePaths);
    }
    const states = new Map<string, PerFileState>();
    if (!this.store.loadFile) {
      return states;
    }
    const paths = [...activePaths];
    const batchSize = 1000;
    for (let i = 0; i < paths.length; i += batchSize) {
      const batch = paths.slice(i, i + batchSize);
      const loaded = await Promise.all(batch.map(async (filePath) => [
        filePath,
        await this.store.loadFile!(repo, filePath),
      ] as const));
      for (const [filePath, state] of loaded) {
        if (state && !isBlankFileState(state)) {
          states.set(filePath, state);
        }
      }
    }
    return states;
  }

  reviewFile(path: string): ReviewFile | undefined {
    return this.reviewFilesByPath.get(path);
  }

  hasReviewFile(path: string): boolean {
    return this.reviewFilesByPath.has(path);
  }

  get reviewStructureVersion(): number {
    return this.structureVersion;
  }

  private isDeletedFile(path: string): boolean {
    return this.deletedPaths.has(path);
  }

  /**
   * Resolves a file-scheme document/URI to its review-set relative path, or
   * undefined if the file is not part of the active review set. This is the
   * single source of truth for "is this document under review, and as what path".
   */
  relPathInSet(uri: vscode.Uri): string | undefined {
    const rel = this.relPathInRepo(uri);
    return rel && this.reviewFilesByPath.has(rel) ? rel : undefined;
  }

  /** Resolves a file URI under the active repository, whether or not it is in scope. */
  relPathInRepo(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file' || !this.reviewSet) {
      return undefined;
    }
    // Prefer the session's chosen cwd, then the URI's workspace folder, then
    // the first workspace folder. Multi-root workspaces can have several roots
    // and the review may belong to any of them.
    const root =
      this.cwd
      ?? vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath
      ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return undefined;
    }
    const rel = path.relative(root, uri.fsPath).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) {
      return undefined;
    }
    return rel;
  }

  hasAnalysisDependency(path: string): boolean {
    return Object.values(this.snapshot?.analysisDependencies ?? {})
      .some((files) => files.includes(path));
  }

  /** Coverage for a file: how many of its lines have been seen, out of total. */
  coverage(path: string): { seen: number; total: number } {
    if (this.isDeletedFile(path)) {
      return { seen: 0, total: 0 };
    }
    const s = this.fileState(path);
    const total = s?.totalLines ?? 0;
    const seen = s?.seenLines.length ?? 0;
    // Clamp so historical out-of-range data can never render as e.g. 190/189.
    return { seen: total > 0 ? Math.min(seen, total) : seen, total };
  }

  /** Records the file's total line count, the first time it is opened. */
  setTotalLines(path: string, total: number): void {
    if (this.isDeletedFile(path)) {
      return;
    }
    const s = this.ensureFileState(path);
    if (s && s.totalLines !== total) {
      s.totalLines = total;
      // Drop any seen lines now beyond the (re-measured) end of file, so seen can
      // never exceed total — otherwise a later, smaller line count leaves stale
      // out-of-range entries and coverage shows e.g. 190/189.
      if (total > 0) {
        const trimmed = s.seenLines.filter((l) => l <= total);
        if (trimmed.length !== s.seenLines.length) {
          s.seenLines = trimmed;
        }
      }
      this.persistFile(path);
    }
  }

  /**
   * Marks the given 1-based line numbers as seen. Returns true if anything
   * changed (so callers can avoid redundant persistence / redraws).
   */
  markSeen(path: string, lines: Iterable<number>): boolean {
    if (this.isDeletedFile(path)) {
      return false;
    }
    const s = this.ensureFileState(path);
    if (!s) {
      return false;
    }
    const set = new Set(s.seenLines);
    const before = set.size;
    for (const line of lines) {
      if (line >= 1 && (s.totalLines === 0 || line <= s.totalLines)) {
        set.add(line);
      }
    }
    if (set.size === before) {
      return false;
    }
    s.seenLines = [...set].sort((a, b) => a - b);
    this.persistFile(path, 1000);
    return true;
  }

  /**
   * Remaps seen-line coverage after an applied fix splices the file. The applied
   * code is AI-generated, so the WHOLE new block is marked unread (so the reviewer
   * must re-read what the model wrote), while lines outside the block keep their
   * prior read/unread state attached to the same code: lines below the edit shift
   * by the line delta, lines above are untouched. Splices are in the file's
   * pre-edit coordinates; multiple splices (one proposal, several edits) are
   * folded high-line-first so each stays valid in original coordinates.
   */
  remapSeenAfterSplices(
    path: string,
    splices: { startLine: number; oldLineCount: number; newLineCount: number }[],
  ): void {
    if (this.isDeletedFile(path) || splices.length === 0) {
      return;
    }
    const s = this.ensureFileState(path);
    if (!s) {
      return;
    }
    const ordered = [...splices].sort((a, b) => b.startLine - a.startLine);
    let seen = new Set(s.seenLines);
    for (const sp of ordered) {
      const delta = sp.newLineCount - sp.oldLineCount;
      const removedEnd = sp.startLine + sp.oldLineCount; // 1-based, exclusive (pre-edit coords)
      const next = new Set<number>();
      for (const p of seen) {
        if (p < sp.startLine) {
          next.add(p); // above the edit: untouched
        } else if (p >= removedEnd) {
          next.add(p + delta); // below the edit: shift, keep state
        }
        // else: inside the replaced region → drop, so the whole applied block
        // [startLine, startLine+newLineCount) ends up unread (never re-added).
      }
      seen = next;
    }
    s.seenLines = [...seen].sort((a, b) => a - b);
    this.persistFile(path);
  }

  /** A file is "ready" when it has been analyzed and every finding has a disposition. */
  fileReady(path: string): boolean {
    if (this.isDeletedFile(path)) {
      return true;
    }
    const s = this.fileState(path);
    if (!s || !s.analyzed) {
      return false;
    }
    const dispositions = s.dispositions ?? {};
    return s.findings
      .filter(isActionableFinding)
      .every((f) => !!dispositions[f.id]);
  }

  /** Whether every line of the file has been seen (coverage complete). */
  fileFullySeen(path: string): boolean {
    if (this.isDeletedFile(path)) {
      return true;
    }
    const s = this.fileState(path);
    return !!s && s.totalLines > 0 && s.seenLines.length >= s.totalLines;
  }

  /** Stores file-level analysis results and marks the file analyzed. */
  setFindings(
    path: string,
    findings: Finding[],
    analysisSummary?: FileAnalysisSummary,
  ): void {
    const s = this.ensureFileState(path);
    if (!s) {
      return;
    }
    // Finding ids are positional (`f0`, `f1`, …) and therefore NOT stable across
    // re-analysis. Re-keying dispositions by id would resurrect already-handled
    // findings as fresh, unconfirmed ones. Instead, carry each prior disposition
    // forward by matching the new finding to the old one by content signature.
    const keyed = rekeyFindings(
      s.findings,
      findings.map((finding) => ({
        ...finding,
        analysisRoot: path,
        analysisRoots: [path],
      })),
      s.dispositions ?? {},
    );
    const invalidatedFiles = this.invalidateGlobalAnalysis();
    s.findings = keyed.findings;
    s.analysisSummary = analysisSummary;
    s.analyzed = true;
    s.dispositions = keyed.dispositions;
    s.confirmedFindings = [];
    if (this.snapshot) {
      (this.snapshot.analysisDependencies ??= {})[path] = [path];
    }
    for (const invalidatedFile of invalidatedFiles) {
      if (invalidatedFile !== path) {
        this.persistFile(invalidatedFile);
      }
    }
    this.persistFile(path);
  }

  /**
   * Replaces every finding previously produced from one entry file, including
   * findings located in related files. Only the entry file becomes analyzed;
   * newly-added related files still require their own rooted review.
   */
  setRootedFindings(
    rootPath: string,
    findingsByFile: Record<string, Finding[]>,
    analysisSummary: FileAnalysisSummary,
    contextFiles: readonly string[] = [rootPath],
  ): RootedFindingsUpdate {
    if (!this.snapshot || !this.reviewSet || !this.reviewFilesByPath.has(rootPath)) {
      return { addedFiles: [], updatedFiles: [], removedFiles: [] };
    }
    const resultPaths = Object.keys(findingsByFile);
    const added = this.addContextReviewFiles(
      resultPaths.filter((filePath) => !this.reviewFilesByPath.has(filePath)),
    );
    const affected = new Set<string>([rootPath, ...resultPaths]);
    for (const [filePath, state] of Object.entries(this.snapshot.perFile)) {
      if (state.findings.some((finding) => findingHasAnalysisRoot(finding, rootPath))) {
        affected.add(filePath);
      }
    }
    for (const invalidatedFile of this.invalidateGlobalAnalysis()) {
      affected.add(invalidatedFile);
    }
    (this.snapshot.analysisDependencies ??= {})[rootPath] = [
      ...new Set(contextFiles),
    ];

    const updatedFiles: string[] = [];
    for (const filePath of affected) {
      if (!this.reviewFilesByPath.has(filePath)) {
        continue;
      }
      const state = this.ensureFileState(filePath);
      if (!state) {
        continue;
      }
      const incoming = (findingsByFile[filePath] ?? []).map((finding) => ({
        ...finding,
        analysisRoot: rootPath,
        analysisRoots: [rootPath],
      }));
      const retained: Finding[] = [];
      for (const finding of state.findings) {
        const roots = findingAnalysisRoots(finding);
        if (roots.includes(rootPath)) {
          const remainingRoots = roots.filter((root) => root !== rootPath);
          if (remainingRoots.length > 0) {
            retained.push({
              ...finding,
              analysisRoot: remainingRoots[0],
              analysisRoots: remainingRoots,
            });
          }
          continue;
        }
        if (roots.length === 0 && filePath === rootPath) {
          continue;
        }
        retained.push(finding);
      }
      for (const finding of incoming) {
        const key = rootedFindingKey(finding);
        const existingIndex = retained.findIndex(
          (existing) => rootedFindingKey(existing) === key,
        );
        if (existingIndex < 0) {
          retained.push(finding);
          continue;
        }
        const existing = retained[existingIndex];
        const roots = [
          ...new Set([...findingAnalysisRoots(existing), rootPath]),
        ];
        retained[existingIndex] = {
          ...finding,
          ...existing,
          analysisRoot: roots[0],
          analysisRoots: roots,
          verification: mergeFindingVerification(
            existing.verification,
            finding.verification,
          ),
        };
      }
      const keyed = rekeyFindings(
        state.findings,
        retained,
        state.dispositions ?? {},
      );
      state.findings = keyed.findings;
      state.dispositions = keyed.dispositions;
      state.confirmedFindings = [];
      if (filePath === rootPath) {
        state.analyzed = true;
        state.analysisSummary = analysisSummary;
      }
      updatedFiles.push(filePath);
    }
    const removedFiles = this.pruneOrphanedContextFiles(rootPath);
    const removed = new Set(removedFiles);
    for (const filePath of updatedFiles) {
      if (!removed.has(filePath)) {
        this.persistFile(filePath);
      }
    }
    return {
      addedFiles: added,
      updatedFiles: [...new Set(updatedFiles)],
      removedFiles,
    };
  }

  /** A file edit invalidates both its rooted analysis and the cross-file conclusion. */
  invalidateAfterFileChange(path: string): ReviewInvalidation {
    if (!this.snapshot) {
      return { changed: false, affectedFiles: [], removedFiles: [] };
    }
    const roots = new Set<string>([path]);
    for (const [root, dependencies] of Object.entries(
      this.snapshot.analysisDependencies ?? {},
    )) {
      if (dependencies.includes(path)) {
        roots.add(root);
      }
    }
    for (const finding of this.fileState(path)?.findings ?? []) {
      for (const root of findingAnalysisRoots(finding)) {
        roots.add(root);
      }
    }
    const affected = new Set<string>();
    let changed = false;
    for (const [filePath, state] of Object.entries(this.snapshot.perFile)) {
      const nextFindings: Finding[] = [];
      for (const finding of state.findings) {
        if (filePath === path) {
          continue;
        }
        const owners = findingAnalysisRoots(finding);
        const remainingOwners = owners.filter((root) => !roots.has(root));
        if (owners.length > 0 && remainingOwners.length === 0) {
          continue;
        }
        nextFindings.push(
          remainingOwners.length !== owners.length
            ? {
                ...finding,
                analysisRoot: remainingOwners[0],
                analysisRoots: remainingOwners,
              }
            : finding,
        );
      }
      const findingsChanged =
        nextFindings.length !== state.findings.length
        || nextFindings.some((finding, index) => finding !== state.findings[index]);
      if (findingsChanged) {
        const keyed = rekeyFindings(
          state.findings,
          nextFindings,
          state.dispositions ?? {},
        );
        state.findings = keyed.findings;
        state.dispositions = keyed.dispositions;
        affected.add(filePath);
        changed = true;
      }
      if (roots.has(filePath) && (state.analyzed || state.analysisSummary)) {
        state.analyzed = false;
        state.analysisSummary = undefined;
        affected.add(filePath);
        changed = true;
      }
    }
    for (const root of roots) {
      if (this.snapshot.analysisDependencies?.[root]) {
        delete this.snapshot.analysisDependencies[root];
        changed = true;
      }
    }
    const hadGlobalAnalysis = !!this.snapshot.globalReport || this.snapshot.globalDone;
    for (const invalidatedFile of this.invalidateGlobalAnalysis()) {
      affected.add(invalidatedFile);
    }
    changed ||= hadGlobalAnalysis;
    const removedFiles = this.pruneOrphanedContextFiles(path);
    const removed = new Set(removedFiles);
    for (const filePath of removedFiles) {
      affected.add(filePath);
    }
    for (const filePath of affected) {
      if (this.reviewFilesByPath.has(filePath) && !removed.has(filePath)) {
        this.persistFile(filePath);
      }
    }
    if (changed && affected.size === 0) {
      this.persistScope();
    }
    return {
      changed: changed || removed.size > 0,
      affectedFiles: [...affected],
      removedFiles,
    };
  }

  /** Removes untouched auto-added files once no rooted finding still justifies them. */
  private pruneOrphanedContextFiles(activeRoot: string): string[] {
    if (!this.reviewSet || !this.snapshot?.contextFiles?.length) {
      return [];
    }
    const removed = this.snapshot.contextFiles.filter((filePath) => {
      if (filePath === activeRoot) {
        return false;
      }
      const state = this.snapshot?.perFile[filePath];
      return !state
        || (
          state.findings.length === 0
          && !state.analyzed
          && state.totalLines === 0
          && state.seenLines.length === 0
          && (state.annotations?.length ?? 0) === 0
          && Object.keys(state.dispositions ?? {}).length === 0
        );
    });
    if (removed.length === 0) {
      return [];
    }
    const removedSet = new Set(removed);
    this.snapshot.contextFiles = this.snapshot.contextFiles.filter(
      (filePath) => !removedSet.has(filePath),
    );
    this.reviewSet = {
      ...this.reviewSet,
      files: this.reviewSet.files.filter((file) => !removedSet.has(file.path)),
    };
    for (const filePath of removed) {
      const pending = this.pendingFilePersists.get(filePath);
      if (pending) {
        clearTimeout(pending);
        this.pendingFilePersists.delete(filePath);
      }
      this.reviewFilesByPath.delete(filePath);
      this.deletedPaths.delete(filePath);
      delete this.snapshot.perFile[filePath];
      if (this.store.clearFile) {
        void this.store.clearFile(this.getRepoName(), filePath).catch((err) => {
          console.warn('[codereview] failed to clear orphaned context file state:', err);
        });
      }
    }
    this.structureVersion++;
    void this.persistScopeMeta().catch(() => {/* non-fatal */});
    this._onDidChange.fire({ structureChanged: true });
    return removed;
  }

  /** Invalidates stale global analysis and removes its replaceable finding overlays. */
  private invalidateGlobalAnalysis(): string[] {
    if (!this.snapshot) {
      return [];
    }
    const changedFiles: string[] = [];
    for (const [file, state] of Object.entries(this.snapshot.perFile)) {
      let changed = false;
      for (const finding of state.findings) {
        if (finding.verification?.source !== 'global') {
          continue;
        }
        finding.verification = finding.verification.prior
          ? { ...finding.verification.prior, source: 'file' }
          : undefined;
        changed = true;
      }
      if (changed) {
        changedFiles.push(file);
      }
    }
    const dispositions = this.snapshot.globalFixDispositions;
    const previousSpots = this.snapshot.globalReport?.fixSpots ?? [];
    const stableSpotIds = globalFixSpotSignatures(previousSpots);
    for (let index = 0; index < previousSpots.length; index++) {
      const spot = previousSpots[index];
      const disposition = dispositions?.[spot.id];
      if (disposition) {
        dispositions![stableSpotIds[index]] = disposition;
      }
    }
    this.snapshot.globalReport = undefined;
    this.snapshot.globalDone = false;
    return changedFiles;
  }

  findings(path: string): Finding[] {
    return this.fileState(path)?.findings ?? [];
  }

  findingByContentRef(path: string, findingRef: string): Finding | undefined {
    const findings = this.findings(path);
    const index = findingContentSignatures(findings).indexOf(findingRef);
    return index >= 0 ? findings[index] : undefined;
  }

  actionableFindings(path: string): Finding[] {
    return this.findings(path).filter(isActionableFinding);
  }

  /** Disposition of a single finding, if the reviewer has acted on it. */
  findingDisposition(path: string, findingId: string): FindingDisposition | undefined {
    return this.fileState(path)?.dispositions?.[findingId];
  }

  /** Records the reviewer's disposition for a finding. Returns true if changed. */
  setFindingDisposition(path: string, findingId: string, disposition: FindingDisposition | null): boolean {
    const s = this.fileState(path);
    if (!s) {
      return false;
    }
    s.dispositions ??= {};
    if (disposition === null) {
      if (!(findingId in s.dispositions)) {
        return false;
      }
      delete s.dispositions[findingId];
    } else {
      s.dispositions[findingId] = { ...disposition, at: disposition.at || Date.now() };
    }
    this.persistFile(path);
    return true;
  }

  /** Count of findings that still have no disposition. */
  unconfirmedCount(path: string): number {
    if (this.isDeletedFile(path)) {
      return 0;
    }
    const s = this.fileState(path);
    if (!s) {
      return 0;
    }
    const dispositions = s.dispositions ?? {};
    return s.findings
      .filter(isActionableFinding)
      .filter((f) => !dispositions[f.id])
      .length;
  }

  /** Reviewer translations / notes attached to a file. */
  annotations(path: string): Annotation[] {
    return this.fileState(path)?.annotations ?? [];
  }

  /** Adds a translation / note to a file and persists it. */
  addAnnotation(path: string, annotation: Annotation): void {
    const s = this.ensureFileState(path);
    if (!s) {
      return;
    }
    (s.annotations ??= []).push(annotation);
    this.persistFile(path);
  }

  /** Removes an annotation by id. */
  removeAnnotation(path: string, id: string): void {
    const s = this.fileState(path);
    if (!s?.annotations) {
      return;
    }
    const next = s.annotations.filter((a) => a.id !== id);
    if (next.length !== s.annotations.length) {
      s.annotations = next;
      this.persistFile(path);
    }
  }

  /**
   * Updates an annotation in place (content edit and/or kind change, e.g.
   * converting an AI explanation into an editable note). No-op if not found.
   */
  updateAnnotation(
    path: string,
    id: string,
    patch: { content?: string; kind?: Annotation['kind'] },
  ): void {
    const a = this.fileState(path)?.annotations?.find((x) => x.id === id);
    if (!a) {
      return;
    }
    if (typeof patch.content === 'string') {
      a.content = patch.content;
    }
    if (patch.kind) {
      a.kind = patch.kind;
    }
    this.persistFile(path);
  }

  /** Stores the cross-file global report (reviewer must still confirm it). */
  setGlobalReport(report: GlobalReport): void {
    if (this.snapshot) {
      const previousReport = this.snapshot.globalReport;
      const previousDispositions = this.snapshot.globalFixDispositions ?? {};
      const nextDispositions: Record<string, FindingDisposition> = {};
      const previousSpots = previousReport?.fixSpots ?? [];
      const previousStableIds = globalFixSpotSignatures(previousSpots);
      for (const spot of report.fixSpots) {
        const direct = previousDispositions[spot.id];
        if (direct) {
          nextDispositions[spot.id] = direct;
          continue;
        }
        const previousIndex = previousStableIds.indexOf(spot.id);
        const previousSpot = previousIndex >= 0 ? previousSpots[previousIndex] : undefined;
        if (previousSpot && previousDispositions[previousSpot.id]) {
          nextDispositions[spot.id] = previousDispositions[previousSpot.id];
        }
      }
      this.snapshot.globalReport = report;
      this.snapshot.globalDone = false;
      this.snapshot.globalFixDispositions =
        Object.keys(nextDispositions).length > 0 ? nextDispositions : undefined;
      this.persistScope();
    }
  }

  get globalReport(): GlobalReport | undefined {
    return this.snapshot?.globalReport;
  }

  /**
   * Applies global confirmed/flip verdicts back to file findings through stable
   * content signatures. Positional finding ids are intentionally never used.
   */
  reconcileGlobalVerdicts(
    report: GlobalReport,
    onlyFile?: string,
    persist = true,
  ): string[] {
    const states = Object.entries(this.snapshot?.perFile ?? {})
      .filter(([file]) => !onlyFile || file === onlyFile);
    const before = new Map<string, string>();
    for (const [file, state] of states) {
      before.set(file, JSON.stringify(state.findings.map((finding) => finding.verification)));
      for (const finding of state.findings) {
        if (finding.verification?.source !== 'global') {
          continue;
        }
        finding.verification = finding.verification.prior
          ? { ...finding.verification.prior, source: 'file' }
          : undefined;
      }
    }

    for (const verdict of report.verdicts) {
      if (
        (verdict.kind !== 'flip' && verdict.kind !== 'confirmed')
        || !verdict.file
        || !verdict.findingRef
        || (onlyFile && verdict.file !== onlyFile)
      ) {
        continue;
      }
      const finding = this.findingByContentRef(verdict.file, verdict.findingRef);
      if (!finding) {
        continue;
      }
      const status = verdict.kind === 'flip' ? 'overturned' : 'repo-confirmed';
      if (
        finding.verification?.status === status
        && finding.verification.rationale === verdict.after
      ) {
        continue;
      }
      finding.verification = {
        status,
        rationale: verdict.after,
        evidence: finding.verification?.evidence ?? [],
        source: 'global',
        prior: finding.verification
          ? {
              status: finding.verification.status === 'unresolved'
                ? 'unresolved'
                : 'repo-confirmed',
              rationale: finding.verification.rationale,
              evidence: finding.verification.evidence,
            }
          : undefined,
      };
    }

    const changedFiles: string[] = [];
    for (const [file, state] of states) {
      const after = JSON.stringify(state.findings.map((finding) => finding.verification));
      if (before.get(file) !== after) {
        changedFiles.push(file);
        if (persist) {
          this.persistFile(file);
        }
      }
    }
    return changedFiles;
  }

  /**
   * Maps a global fix spot to the file-level finding it refers to, when one
   * exists (same file + overlapping line, or matching anchor). Lets a global
   * fix reuse — and stay in sync with — the file-level disposition (design Y).
   * Returns undefined for pure cross-file discoveries (design X applies).
   */
  resolveFixSpotFinding(file: string, line: number, anchor?: string): Finding | undefined {
    const findings = this.findings(file);
    if (anchor && anchor.trim()) {
      const byAnchor = findings.filter(
        (finding) => finding.anchor?.trim() === anchor.trim(),
      );
      if (byAnchor.length === 1) {
        return byAnchor[0];
      }
      if (byAnchor.length > 1) {
        const atLine = byAnchor.filter((finding) => {
          const end = finding.endLine && finding.endLine > finding.line
            ? finding.endLine
            : finding.line;
          return line >= finding.line && line <= end;
        });
        return atLine.length === 1 ? atLine[0] : undefined;
      }
    }
    return findings.find((f) => {
      const start = f.line;
      const end = f.endLine && f.endLine > f.line ? f.endLine : f.line;
      return line >= start && line <= end;
    });
  }

  /**
   * Disposition of a global fix spot, resolving design Y (file-level finding) or
   * design X (independent store) automatically.
   */
  globalFixDisposition(
    spotId: string,
    file: string,
    line: number,
    anchor?: string,
  ): FindingDisposition | undefined {
    const finding = this.resolveFixSpotFinding(file, line, anchor);
    if (finding) {
      return this.findingDisposition(file, finding.id);
    }
    return this.snapshot?.globalFixDispositions?.[spotId];
  }

  /**
   * Records (or clears) a global fix spot's disposition. Writes to the mapped
   * file-level finding when one exists (Y), else to the independent store (X).
   */
  setGlobalFixDisposition(
    spotId: string,
    file: string,
    line: number,
    anchor: string | undefined,
    disposition: FindingDisposition | null,
  ): void {
    const finding = this.resolveFixSpotFinding(file, line, anchor);
    if (finding) {
      this.setFindingDisposition(file, finding.id, disposition);
      return;
    }
    if (!this.snapshot) {
      return;
    }
    const store = (this.snapshot.globalFixDispositions ??= {});
    if (disposition) {
      store[spotId] = disposition;
    } else {
      delete store[spotId];
    }
    this.persistScope();
  }

  /** Reviewer confirms they have read the global conclusion. */
  confirmGlobal(): void {
    if (this.snapshot?.globalReport) {
      this.snapshot.globalDone = true;
      this.persistScope();
    }
  }

  get globalConfirmed(): boolean {
    return !!this.snapshot?.globalDone;
  }

  /** Records the reviewer's final verdict so it survives reloads. */
  setConclusion(conclusion: ReviewConclusion): void {
    if (this.snapshot) {
      this.snapshot.conclusion = conclusion;
      this.persistScope();
    }
  }

  get conclusion(): ReviewConclusion | undefined {
    return this.snapshot?.conclusion;
  }

  /** Draft PR review comments awaiting submission (pending-review model). */
  get pendingComments(): PendingComment[] {
    return this.snapshot?.pendingComments ?? [];
  }

  /** Adds a draft PR review comment to the pending review. */
  addPendingComment(comment: PendingComment): void {
    if (!this.snapshot) {
      return;
    }
    (this.snapshot.pendingComments ??= []).push(comment);
    this.persistScope();
  }

  /** Removes a pending comment by id. */
  removePendingComment(id: string): void {
    if (!this.snapshot?.pendingComments) {
      return;
    }
    const next = this.snapshot.pendingComments.filter((c) => c.id !== id);
    if (next.length !== this.snapshot.pendingComments.length) {
      this.snapshot.pendingComments = next;
      this.persistScope();
    }
  }

  /** Clears all pending comments (e.g. after they have been submitted). */
  clearPendingComments(): void {
    if (this.snapshot?.pendingComments?.length) {
      this.snapshot.pendingComments = [];
      this.persistScope();
    }
  }

  /**
   * Accumulates one LLM call's estimated token usage onto the review snapshot,
   * bucketed by operation. Totals are approximate (countTokens-based), not the
   * provider's billed counts. Persisted so usage survives reloads.
   */
  recordTokenUsage(usage: TokenUsage): void {
    if (!this.snapshot) {
      return;
    }
    const acct = this.snapshot.tokenUsage ?? {
      totalInput: 0,
      totalOutput: 0,
      calls: 0,
      byOp: {},
    };
    acct.totalInput += usage.input;
    acct.totalOutput += usage.output;
    acct.calls += 1;
    const bucket = acct.byOp[usage.op] ?? { input: 0, output: 0, calls: 0 };
    bucket.input += usage.input;
    bucket.output += usage.output;
    bucket.calls += 1;
    acct.byOp[usage.op] = bucket;
    this.snapshot.tokenUsage = acct;
    this.persistScope();
  }

  /** Estimated token usage accumulated over this review, if any. */
  get tokenUsage(): TokenAccount | undefined {
    return this.snapshot?.tokenUsage;
  }

  allFilesReady(): boolean {
    const coverage = this.totalCoverage();
    return !!this.reviewSet && coverage.filesReady === coverage.filesTotal;
  }

  /** Overall coverage across all files in the review set, as seen/total lines. */
  totalCoverage(): { seen: number; total: number; filesReady: number; filesTotal: number } {
    let seen = 0;
    let total = 0;
    let filesReady = this.deletedPaths.size;
    for (const [filePath, state] of Object.entries(this.snapshot?.perFile ?? {})) {
      if (!this.reviewFilesByPath.has(filePath) || this.deletedPaths.has(filePath)) {
        continue;
      }
      const fileSeen = state.seenLines.length;
      seen += state.totalLines > 0 ? Math.min(fileSeen, state.totalLines) : fileSeen;
      total += state.totalLines;
      if (
        state.analyzed
        && state.findings
          .filter(isActionableFinding)
          .every((finding) => !!state.dispositions?.[finding.id])
      ) {
        filesReady++;
      }
    }
    return { seen, total, filesReady, filesTotal: this.reviewFilesByPath.size };
  }

  /** Gate passes only when every file is ready and global analysis is confirmed. */
  gatePassed(): boolean {
    return this.allFilesReady() && !!this.snapshot?.globalDone;
  }

  async persist(): Promise<void> {
    if (!this.snapshot) {
      return;
    }
    const repo = this.getRepoName();
    try {
      // Per-file progress → per-file storage (the source of truth). The scope
      // snapshot keeps only scope-level data; writing every file here too would
      // make each change re-serialize a huge object, so we DON'T — see
      // persistScopeMeta / persistFile for the granular writes.
      if (this.store.saveFile) {
        for (const [filePath, state] of Object.entries(this.snapshot.perFile)) {
          await this.store.saveFile(repo, filePath, state);
        }
      }
      await this.persistScopeMeta();
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      void vscode.window.showWarningMessage(m().review.saveFailed(message));
      return;
    }
    this._onDidChange.fire({});
  }

  /**
   * Persists ONE file's progress plus the (small) scope metadata — the granular
   * path used by per-file mutations so a 300-file review doesn't re-write every
   * record on each keystroke/scroll.
   */
  private persistFile(filePath: string, delayMs = 0): void {
    if (!this.snapshot) {
      return;
    }
    const pending = this.pendingFilePersists.get(filePath);
    if (pending) {
      clearTimeout(pending);
      this.pendingFilePersists.delete(filePath);
    }
    if (delayMs > 0) {
      this.pendingFilePersists.set(filePath, setTimeout(() => {
        this.pendingFilePersists.delete(filePath);
        void this.persistFileNow(filePath);
      }, delayMs));
    } else {
      void this.persistFileNow(filePath);
    }
    this._onDidChange.fire({ filePath });
  }

  private async persistFileNow(filePath: string): Promise<void> {
    if (!this.snapshot) {
      return;
    }
    const repo = this.getRepoName();
    const state = this.snapshot.perFile[filePath];
    try {
      if (state && this.store.saveFile) {
        await this.store.saveFile(repo, filePath, state);
      }
      await this.persistScopeMeta();
    } catch {
      // Non-fatal; stays in memory and re-persists on the next change.
    }
  }

  private async flushPendingFilePersists(): Promise<void> {
    const filePaths = [...this.pendingFilePersists.keys()];
    for (const timer of this.pendingFilePersists.values()) {
      clearTimeout(timer);
    }
    this.pendingFilePersists.clear();
    await Promise.all(filePaths.map((filePath) => this.persistFileNow(filePath)));
  }

  /** Saves the scope-level snapshot (global report / conclusion / token usage),
   * with the bulky perFile map stripped — per-file storage owns that. */
  private async persistScopeMeta(): Promise<void> {
    if (!this.snapshot) {
      return;
    }
    this.snapshot.updatedAt = Date.now();
    await this.store.save({ ...this.snapshot, perFile: {} });
  }

  /** Fire-and-forget scope-meta persist for scope-level mutations (no per-file rewrite). */
  private persistScope(): void {
    void this.persistScopeMeta().catch(() => {/* non-fatal */});
    this._onDidChange.fire({});
  }

  dispose(): void {
    void this.flushPendingFilePersists();
    this._onDidChange.dispose();
  }
}

function rootedFindingKey(finding: Finding): string {
  return [
    finding.line,
    finding.endLine ?? finding.line,
    finding.severity,
    (finding.anchor ?? '').trim(),
    finding.title.trim().replace(/\s+/g, ' ').toLowerCase(),
    finding.detail.trim().replace(/\s+/g, ' ').toLowerCase(),
  ].join('\u0000');
}

function mergeFindingVerification(
  current: Finding['verification'],
  incoming: Finding['verification'],
): Finding['verification'] {
  if (!current) {
    return incoming;
  }
  if (!incoming) {
    return current;
  }
  const evidence = [...current.evidence];
  const keys = new Set(
    evidence.map((item) =>
      `${item.kind}\u0000${item.file}\u0000${item.line}\u0000${item.endLine ?? item.line}`,
    ),
  );
  for (const item of incoming.evidence) {
    const key =
      `${item.kind}\u0000${item.file}\u0000${item.line}\u0000${item.endLine ?? item.line}`;
    if (!keys.has(key)) {
      keys.add(key);
      evidence.push(item);
    }
  }
  return {
    ...incoming,
    evidence,
  };
}

function rekeyFindings(
  previous: Finding[],
  next: Finding[],
  previousDispositions: Record<string, FindingDisposition>,
): { findings: Finding[]; dispositions: Record<string, FindingDisposition> } {
  const bySignature = new Map<string, FindingDisposition>();
  const previousSignatures = findingContentSignatures(previous);
  for (let index = 0; index < previous.length; index++) {
    const disposition = previousDispositions[previous[index].id];
    if (disposition) {
      bySignature.set(previousSignatures[index], disposition);
    }
  }
  const findings = next.map((finding, index) => ({ ...finding, id: `f${index}` }));
  const dispositions: Record<string, FindingDisposition> = {};
  const nextSignatures = findingContentSignatures(findings);
  for (let index = 0; index < findings.length; index++) {
    const disposition = bySignature.get(nextSignatures[index]);
    if (disposition) {
      dispositions[findings[index].id] = disposition;
    }
  }
  return { findings, dispositions };
}

/**
 * Returns a well-formed PerFileState from a possibly-undefined or legacy record:
 * fills missing arrays/maps and migrates the legacy `confirmedFindings` marks to
 * `commented` dispositions. Never mutates the input.
 */
function normaliseFileState(s: PerFileState | undefined): PerFileState {
  const out: PerFileState = {
    seenLines: Array.isArray(s?.seenLines) ? [...s!.seenLines] : [],
    totalLines: s?.totalLines ?? 0,
    analyzed: s?.analyzed ?? false,
    // Older repository-aware builds persisted evidence-insufficient candidates
    // as manual-review cards. The rooted analyzer now reports only independently
    // confirmed bugs, so drop those legacy non-findings during migration.
    findings: Array.isArray(s?.findings)
      ? s!.findings
          .filter((finding) => finding.verification?.status !== 'unresolved')
          .map((finding) => ({ ...finding }))
      : [],
    analysisSummary: s?.analysisSummary
      ? { ...s.analysisSummary }
      : undefined,
    confirmedFindings: [],
    dispositions: { ...(s?.dispositions ?? {}) },
    annotations: Array.isArray(s?.annotations) ? [...s!.annotations] : [],
  };
  // Migrate legacy "confirmed read" marks to the commented disposition.
  if (s?.confirmedFindings?.length) {
    for (const id of s.confirmedFindings) {
      if (!out.dispositions![id]) {
        out.dispositions![id] = { kind: 'commented', at: Date.now() };
      }
    }
  }
  return out;
}
