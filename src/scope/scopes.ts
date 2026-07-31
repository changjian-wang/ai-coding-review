import * as git from './gitClient';
import { checkoutPr, getCurrentPr, getPrByNumber } from '../gh/ghClient';
import { m } from '../i18n';
import type { ReviewFile, ReviewScope, ReviewSet } from './types';
import type { PullRequest } from '../gh/types';

/** Stable, order-independent short hash of a set of paths (FNV-1a, base36). */
function hashPaths(paths: string[]): string {
  const joined = [...paths].sort().join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

async function prReviewSet(cwd: string, pr: PullRequest): Promise<ReviewSet> {
  let baseSha: string | undefined;
  const candidates = [pr.baseRefOid, `origin/${pr.baseRefName}`, pr.baseRefName].filter(Boolean);
  for (const candidate of candidates) {
    try {
      baseSha = await git.mergeBase(cwd, candidate, pr.headRefOid);
      break;
    } catch {
      // A fork may not have the upstream base tip locally; try the next ref.
    }
  }
  if (!baseSha) {
    console.warn(
      `[codereview] Diff unavailable for PR #${pr.number}: no local merge-base for ${candidates.join(', ')}.`,
    );
  }

  let files = pr.files;
  if (baseSha) {
    try {
      const localFiles = await git.diffFiles(cwd, `${baseSha}...${pr.headRefOid}`);
      const localByPath = new Map(localFiles.map((file) => [file.path, file]));
      files = pr.files.map((file) => ({
        ...file,
        previousPath: localByPath.get(file.path)?.previousPath,
      }));
    } catch {
      // GitHub's file list remains authoritative; only rename metadata is lost.
    }
  }

  return {
    scopeId: `pr-${pr.number}`,
    label: `PR #${pr.number} · ${pr.title}`,
    headSha: pr.headRefOid,
    files,
    comparison: baseSha ? { baseSha, headSha: pr.headRefOid } : undefined,
  };
}

/** PR associated with the current branch (via GitHub CLI). Lists files only. */
export class PrScope implements ReviewScope {
  async load(cwd: string): Promise<ReviewSet> {
    const pr = await getCurrentPr(cwd);
    // Use gh's authoritative changed-file list, not a local `git diff` range:
    // on a fork the local `origin/<base>` lags upstream, so the range would
    // include thousands of unrelated files.
    return prReviewSet(cwd, pr);
  }
}

/**
 * A specific PR chosen from the picker — may live on a branch we don't have
 * checked out, so the file list comes straight from gh (no local git range).
 */
export class PrByNumberScope implements ReviewScope {
  constructor(private readonly number: number) {}

  async load(cwd: string): Promise<ReviewSet> {
    // Check out the PR's branch so the working tree matches the PR under review;
    // a chosen PR is usually not the branch currently checked out.
    await checkoutPr(cwd, this.number);
    const pr = await getPrByNumber(cwd, this.number);
    // Use gh's authoritative changed-file list, not a local `git diff` range:
    // on a fork the local `origin/<base>` lags upstream, so the range would
    // include thousands of unrelated files.
    return prReviewSet(cwd, pr);
  }
}

/**
 * All changes carried by the current branch, including committed, staged,
 * unstaged, and untracked files, compared with the branch's merge base.
 */
export class CurrentBranchScope implements ReviewScope {
  constructor(private readonly base?: string) {}

  async load(cwd: string): Promise<ReviewSet> {
    await git.ensureGitRepo(cwd);
    const base = this.base ?? (await git.detectBaseBranch(cwd));
    const headSha = await git.headSha(cwd);
    const baseSha = await git.mergeBase(cwd, base, 'HEAD');
    const [branchFiles, workingTreeFiles] = await Promise.all([
      // A single commit argument compares that commit with index + working tree,
      // so tracked staged/unstaged changes are already included here.
      git.diffFiles(cwd, baseSha),
      // Supplies untracked additions, which `git diff <base>` cannot report.
      git.untrackedFiles(cwd),
    ]);
    const files = mergeCurrentBranchFiles(branchFiles, workingTreeFiles);
    return {
      scopeId: `current-branch-vs-${base}`,
      label: m().scope.branchVsBase(base),
      headSha,
      files,
      comparison: { baseSha, headSha },
    };
  }
}

export function mergeCurrentBranchFiles(
  branchFiles: ReviewFile[],
  workingTreeFiles: ReviewFile[],
): ReviewFile[] {
  const byPath = new Map(branchFiles.map((file) => [file.path, file]));
  for (const file of workingTreeFiles) {
    if (!byPath.has(file.path)) {
      byPath.set(file.path, file);
    }
  }
  return [...byPath.values()];
}

/**
 * Source files chosen directly by the user — pure source review, no diff.
 * `relPaths` are repository-relative paths already expanded from the selection.
 */
export class FileSystemScope implements ReviewScope {
  constructor(private readonly relPaths: string[]) {}

  async load(_cwd: string): Promise<ReviewSet> {
    const files: ReviewFile[] = this.relPaths.map((path) => ({ path }));
    return {
      scopeId: `files-${files.length}-${hashPaths(this.relPaths)}`,
      label: m().scope.selectedSources(files.length),
      // Pure source review is about the working-tree source, not a specific
      // commit — so the snapshot is NOT bound to a git SHA. Using a fixed
      // 'live' head keeps review progress (findings / seen / dispositions /
      // annotations) intact across pulls, commits and branch switches. Diff
      // scopes (PR / branch-vs-base) still pin to a real SHA on purpose.
      headSha: 'live',
      files,
    };
  }
}
