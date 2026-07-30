import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import {
  BranchVsBaseScope,
  FileSystemScope,
  PrScope,
  PrByNumberScope,
  WorkingTreeScope,
} from './scopes';
import { pickScopeTree } from './scopePickerPanel';
import { pickPr } from './prPickerPanel';
import { pickScopeKind } from './scopeKindPicker';
import { currentLogin, ensureAuth, ensureGhAvailable, GhError, listPrs, mergePrsByNumber, repoSlug } from '../gh/ghClient';
import { promptInstallGh } from '../gh/ghInstall';
import { withWorkbenchProgress } from '../ui/workbenchPanel';
import type { ReviewScope, ReviewSet } from './types';
import type { PrSummary } from '../gh/types';
import { m } from '../i18n';
import { transientWarning } from '../ui/toast';
import { listWorkingFiles } from './gitClient';

/** Result of {@link pickScope}: the chosen scope plus the workspace-folder cwd it should run against. */
export interface PickedScope {
  scope: ReviewScope;
  /**
   * Workspace folder that should act as the working directory for git / gh
   * operations during this review. In a multi-root workspace this is the root
   * that **contains** the picked path, not necessarily the first root.
   */
  cwd: string;
}

export interface LoadedScope extends PickedScope {
  reviewSet: ReviewSet;
}

export type PreferredScopeKind = 'currentPr' | 'branch' | 'workingTree';

export interface PreferredLoadedScope extends LoadedScope {
  kind: PreferredScopeKind;
}

export interface PreferredScopeCandidate {
  kind: PreferredScopeKind;
  scope: ReviewScope;
}

/** Best-effort current-branch PR lookup; failures deliberately fall back locally. */
export async function tryLoadCurrentPrScope(
  cwd: string,
  scope: ReviewScope = new PrScope(),
): Promise<LoadedScope | undefined> {
  try {
    return { scope, cwd, reviewSet: await scope.load(cwd) };
  } catch {
    return undefined;
  }
}

/**
 * Picks the first non-empty change scope without ever falling back to a whole
 * repository scan. Callers can still offer explicit file/folder selection.
 */
export async function tryLoadPreferredScope(
  cwd: string,
  onAttempt?: (kind: PreferredScopeKind) => void,
  candidates: PreferredScopeCandidate[] = [
    { kind: 'currentPr', scope: new PrScope() },
    { kind: 'branch', scope: new BranchVsBaseScope() },
    { kind: 'workingTree', scope: new WorkingTreeScope() },
  ],
): Promise<PreferredLoadedScope | undefined> {
  for (const candidate of candidates) {
    onAttempt?.(candidate.kind);
    try {
      const reviewSet = await candidate.scope.load(cwd);
      if (reviewSet.files.length > 0) {
        return { ...candidate, cwd, reviewSet };
      }
    } catch {
      // Best effort: move to the next local scope.
    }
  }
  return undefined;
}

/** Live counters reported while recursively discovering reviewable files. */
export interface ScopeScanProgress {
  directoriesScanned: number;
  filesFound: number;
  percent: number;
  etaSeconds?: number;
  estimated: boolean;
}

/** Lets the user choose how the set of source files under review is scoped. */
export async function pickScope(
  defaultCwd: string,
  viewColumn?: vscode.ViewColumn,
  preselectedKind?: string,
): Promise<PickedScope | undefined> {
  const kind = preselectedKind ?? await pickScopeKind({
    title: m().scope.pickTitle,
    heading: m().scope.pickTitle,
    viewColumn,
    options: [
      {
        id: 'files',
        label: m().scope.pickFilesLabel,
        description: m().scope.pickFilesDescription,
        detail: m().scope.pickFilesDetail,
      },
      {
        id: 'currentPr',
        label: m().scope.pickPrLabel,
        description: 'gh pr view',
        detail: m().scope.pickPrDetail,
      },
      {
        id: 'prList',
        label: m().scope.pickPrListLabel,
        description: 'gh pr list',
        detail: m().scope.pickPrListDetail,
      },
    ],
  });
  switch (kind) {
    case 'files':
      return buildFileSystemScope();
    case 'currentPr':
      return (await ensureGhReady(defaultCwd))
        ? { scope: new PrScope(), cwd: defaultCwd }
        : undefined;
    case 'prList':
      return buildPrListScope();
    default:
      return undefined;
  }

  async function buildFileSystemScope(): Promise<PickedScope | undefined> {
    // Scan the whole project root once, then let the reviewer narrow down via a
    // webview tree that is *locked* to this root. Because the tree is built only
    // from paths under `defaultCwd`, nothing outside the project can be picked —
    // unlike the native open dialog, which can wander out of the root and then
    // fail with an error that is invisible when the workbench is full-screen.
    const relPaths = await withWorkbenchProgress(
      m().scope.scanning,
      (progress) => expandToRelPaths(
        [vscode.Uri.file(defaultCwd)],
        defaultCwd,
        ({ directoriesScanned, filesFound, percent, etaSeconds, estimated }) =>
          progress.report(
            m().scope.scanProgress(directoriesScanned, filesFound),
            'scan',
            { percent, etaSeconds, estimated },
          ),
      ),
    );
    if (relPaths.length === 0) {
      transientWarning(m().scope.noFiles);
      return undefined;
    }
    const picked = await pickScopeTree({
      rootLabel: path.basename(defaultCwd) || defaultCwd,
      relPaths,
      viewColumn,
    });
    if (!picked || picked.length === 0) {
      return undefined;
    }
    return { scope: new FileSystemScope(picked), cwd: defaultCwd };
  }

  async function buildPrListScope(): Promise<PickedScope | undefined> {
    // Keep the busy bar covering gh readiness + listing (shown immediately),
    // and run the gh queries in parallel; it closes before the interactive picker.
    const data = await withWorkbenchProgress(m().scope.loadingPrs, async () => {
      if (!(await ensureGhReady(defaultCwd))) {
        return null;
      }
      const [recent, mine, slug, login] = await Promise.all([
        listPrs(defaultCwd),
        listPrs(defaultCwd, { author: '@me' }).catch(() => [] as PrSummary[]),
        repoSlug(defaultCwd).catch(() => ''),
        currentLogin(defaultCwd).catch(() => ''),
      ]);
      return { prs: mergePrsByNumber(recent, mine), slug, login };
    });
    if (!data) {
      return undefined;
    }
    if (data.prs.length === 0) {
      transientWarning(m().scope.noPrs);
      return undefined;
    }
    const number = await pickPr({
      repoLabel: data.slug || path.basename(defaultCwd) || defaultCwd,
      currentLogin: data.login,
      prs: data.prs,
      viewColumn,
    });
    if (number === undefined) {
      return undefined;
    }
    return { scope: new PrByNumberScope(number), cwd: defaultCwd };
  }
}

/** Ensures gh is installed and authenticated; otherwise prompts (install guide
 * for a missing CLI, login hint for missing auth). Returns readiness. */
async function ensureGhReady(cwd: string): Promise<boolean> {
  try {
    await ensureGhAvailable(cwd);
  } catch (err) {
    if (err instanceof GhError && err.code === 'not-found') {
      await promptInstallGh();
    } else {
      transientWarning(String((err as Error)?.message ?? err));
    }
    return false;
  }
  try {
    await ensureAuth(cwd);
  } catch (err) {
    transientWarning(err instanceof GhError ? err.message : String((err as Error)?.message ?? err));
    return false;
  }
  return true;
}

interface ScanState {
  directoriesScanned: number;
  workDiscovered: number;
  workCompleted: number;
  percent: number;
  startedAt: number;
  lastReportAt: number;
  onProgress?: (progress: ScopeScanProgress) => void;
}

/** Expands selected files/folders into a de-duplicated, sorted list of relative file paths. */
async function expandToRelPaths(
  uris: vscode.Uri[],
  cwd: string,
  onProgress?: (progress: ScopeScanProgress) => void,
): Promise<string[]> {
  if (uris.length === 1 && path.resolve(uris[0].fsPath) === path.resolve(cwd)) {
    try {
      return await expandGitWorkingTree(cwd, onProgress);
    } catch {
      // Non-Git folder or Git failure: use the filesystem walker below.
    }
  }
  const out = new Set<string>();
  const scan: ScanState = {
    directoriesScanned: 0,
    workDiscovered: 0,
    workCompleted: 0,
    percent: 0,
    startedAt: Date.now(),
    lastReportAt: 0,
    onProgress,
  };
  reportScanProgress(scan, out, true);
  // Walk each picked entry concurrently. For folders this fans out to
  // walkDir's internal Promise.all so big trees finish much faster than the
  // old sequential vscode.workspace.fs.stat-based walk.
  await Promise.all(uris.map((u) => collect(u.fsPath, out, cwd, scan)));
  reportScanProgress(scan, out, true, true);
  return [...out].sort();
}

async function expandGitWorkingTree(
  cwd: string,
  onProgress?: (progress: ScopeScanProgress) => void,
): Promise<string[]> {
  const candidates = (await listWorkingFiles(cwd)).filter((file) => {
    const segments = file.path.split('/');
    if (segments.some((segment) => segment.startsWith('.') || SKIP_DIRS.has(segment))) {
      return false;
    }
    return isReviewableExt(segments.at(-1) ?? file.path)
      && (file.size === undefined || file.size <= MAX_FILE_BYTES);
  });
  const out: string[] = [];
  const directories = new Set<string>();
  const startedAt = Date.now();
  let nextIndex = 0;
  let completed = 0;
  let lastReportAt = 0;

  const report = (force = false): void => {
    if (!onProgress) {
      return;
    }
    const now = Date.now();
    if (!force && now - lastReportAt < 100) {
      return;
    }
    lastReportAt = now;
    const percent = candidates.length === 0
      ? 100
      : Math.round((completed / candidates.length) * 100);
    const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
    const etaSeconds = completed > 0 && completed < candidates.length
      ? Math.max(1, Math.round((elapsedSeconds * (candidates.length - completed)) / completed))
      : undefined;
    onProgress({
      directoriesScanned: directories.size,
      filesFound: out.length,
      percent,
      etaSeconds,
      estimated: false,
    });
  };

  report(true);
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= candidates.length) {
        return;
      }
      const file = candidates[index];
      const relPath = file.path;
      try {
        const valid = file.size !== undefined
          || await fs.lstat(path.join(cwd, ...relPath.split('/'))).then(
            (stat) => stat.isFile() && stat.size <= MAX_FILE_BYTES,
          );
        if (valid) {
          out.push(relPath);
          const dir = path.posix.dirname(relPath);
          if (dir !== '.') {
            directories.add(dir);
          }
        }
      } catch {
        // File disappeared between Git enumeration and stat; ignore it.
      }
      completed++;
      report();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(64, Math.max(1, candidates.length)) }, worker),
  );
  report(true);
  return out.sort();
}

/** Throttles UI updates so large repositories do not flood the extension host. */
function reportScanProgress(
  scan: ScanState,
  out: Set<string>,
  force = false,
  complete = false,
): void {
  if (!scan.onProgress) {
    return;
  }
  const now = Date.now();
  if (!force && now - scan.lastReportAt < 100) {
    return;
  }
  scan.lastReportAt = now;
  const discovered = Math.max(scan.workDiscovered, 1);
  const candidate = complete
    ? 100
    : Math.min(95, Math.floor((scan.workCompleted / discovered) * 95));
  scan.percent = Math.max(scan.percent, candidate);
  const elapsedSeconds = Math.max((now - scan.startedAt) / 1000, 0.001);
  const etaSeconds = scan.percent > 0 && scan.percent < 100
    ? Math.max(1, Math.round((elapsedSeconds * (100 - scan.percent)) / scan.percent))
    : undefined;
  scan.onProgress({
    directoriesScanned: scan.directoriesScanned,
    filesFound: out.size,
    percent: scan.percent,
    etaSeconds,
    estimated: !complete,
  });
}

/**
 * Fast recursive walk via `node:fs/promises`. Uses `withFileTypes` (single
 * syscall returns name + type), fans out subdirectory walks in parallel, and
 * aggressively skips well-known build / vendor dirs and obvious non-source
 * files. Errors on individual entries are swallowed so a single unreadable
 * file or symlink can't abort the whole scan.
 */
async function collect(absPath: string, out: Set<string>, cwd: string, scan: ScanState): Promise<void> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(absPath);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    // Don't follow symlinks — cheap protection against cycles and surprise
    // out-of-tree paths (e.g. pnpm's symlink farm).
    return;
  }
  if (stat.isDirectory()) {
    scan.workDiscovered += 1;
    await walkDir(absPath, out, cwd, scan);
    return;
  }
  scan.workDiscovered += 1;
  scan.workCompleted += 1;
  if (stat.isFile() && isReviewableFile(absPath, stat.size)) {
    addRel(absPath, cwd, out);
  }
  reportScanProgress(scan, out);
}

async function walkDir(dir: string, out: Set<string>, cwd: string, scan: ScanState): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    scan.workCompleted += 1;
    reportScanProgress(scan, out);
    return;
  }
  scan.directoriesScanned += 1;
  scan.workCompleted += 1;
  const subdirs: string[] = [];
  const filePromises: Promise<void>[] = [];
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const child = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) {
        // Hidden directories (.git, .vscode, .next, .nuxt, .idea, .gradle, …)
        // are virtually never review targets. Skipping by prefix catches new
        // tools without us having to maintain a list.
        continue;
      }
      subdirs.push(child);
    } else if (e.isFile()) {
      // Cheap-path: filter by extension first to avoid even calling stat.
      if (!isReviewableExt(e.name)) continue;
      filePromises.push(
        fs.stat(child).then(
          (s) => {
            if (s.size <= MAX_FILE_BYTES) {
              addRel(child, cwd, out);
            }
          },
          () => {/* ignore */},
        ).finally(() => {
          scan.workCompleted += 1;
          reportScanProgress(scan, out);
        }),
      );
    }
  }
  scan.workDiscovered += subdirs.length + filePromises.length;
  reportScanProgress(scan, out);
  await Promise.all([
    ...filePromises,
    ...subdirs.map((d) => walkDir(d, out, cwd, scan)),
  ]);
  reportScanProgress(scan, out);
}

function addRel(absPath: string, cwd: string, out: Set<string>): void {
  const rel = path.relative(cwd, absPath).split(path.sep).join('/');
  if (rel && !rel.startsWith('..')) {
    out.add(rel);
  }
}

function isReviewableFile(absPath: string, size: number): boolean {
  return size <= MAX_FILE_BYTES && isReviewableExt(path.basename(absPath));
}

function isReviewableExt(name: string): boolean {
  // Reject lock files & minified bundles early — they bloat the tree and
  // nobody reviews them.
  if (SKIP_FILES.has(name)) return false;
  if (name.endsWith('.min.js') || name.endsWith('.min.css') || name.endsWith('.map')) return false;
  const dotAt = name.lastIndexOf('.');
  if (dotAt < 0) {
    // No extension: typical README, Makefile, Dockerfile etc. — keep if name
    // is in the allow list, otherwise skip.
    return EXTENSIONLESS_ALLOW.has(name);
  }
  const ext = name.slice(dotAt + 1).toLowerCase();
  return !SKIP_EXTS.has(ext);
}

const MAX_FILE_BYTES = 1_000_000; // 1 MB: anything bigger is almost never reviewable source.

/** Directories that are virtually never review targets. */
const SKIP_DIRS = new Set([
  'node_modules', 'bower_components', 'vendor', 'Pods',
  'dist', 'out', 'build', 'target', 'bin', 'obj',
  '__pycache__', 'venv', 'env',
  'coverage', '.nyc_output',
]);

/** Specific files to drop on sight. */
const SKIP_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-lock.yml',
  'composer.lock', 'Gemfile.lock', 'poetry.lock', 'Cargo.lock',
  '.DS_Store', 'Thumbs.db',
]);

/** Binary / non-source extensions — skip these even if they slipped through. */
const SKIP_EXTS = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'tif', 'tiff',
  // archives
  'zip', 'tar', 'gz', 'tgz', 'bz2', '7z', 'rar', 'xz',
  // binaries
  'exe', 'dll', 'so', 'dylib', 'a', 'lib', 'class', 'jar', 'war', 'pdb',
  // media
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'flac', 'wav', 'ogg',
  // documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // misc
  'wasm', 'snap',
]);

/** Files without an extension we still want to review. */
const EXTENSIONLESS_ALLOW = new Set([
  'Dockerfile', 'Makefile', 'Rakefile', 'Gemfile', 'Procfile', 'Jenkinsfile',
  'README', 'LICENSE', 'NOTICE', 'CHANGELOG', 'CONTRIBUTING', 'AUTHORS',
]);

/**
 * Builds a {@link FileSystemScope} covering every reviewable file under `cwd`
 * (skipping the same `SKIP_DIRS` as the interactive picker). Returns
 * `undefined` if the folder has no reviewable files.
 */
export async function buildFolderScope(
  cwd: string,
  onProgress?: (progress: ScopeScanProgress) => void,
): Promise<PickedScope | undefined> {
  const rels = await expandToRelPaths([vscode.Uri.file(cwd)], cwd, onProgress);
  if (rels.length === 0) {
    return undefined;
  }
  return { scope: new FileSystemScope(rels), cwd };
}
