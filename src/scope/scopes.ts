import * as git from './gitClient';
import { getCurrentPr, getPrByNumber } from '../gh/ghClient';
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
  const endpoints = () => Promise.all([
    git.resolveCommit(cwd, pr.headRefOid), git.resolveCommit(cwd, pr.baseRefOid),
  ]);
  try {
    await endpoints();
  } catch (error) {
    console.info('[codereview] Loading missing PR objects without checkout:', error);
    await git.fetchPrSnapshot(cwd, pr.url, pr.number, pr.baseRefName);
    await endpoints();
  }
  const baseSha = await git.mergeBase(cwd, pr.baseRefOid, pr.headRefOid);
  const files = await git.diffSnapshotFiles(cwd, baseSha, pr.headRefOid);

  return {
    repositoryIdentity: git.prRepositoryIdentity(pr.url),
    scopeId: `pr-${pr.number}`,
    label: `PR #${pr.number} · ${pr.title}`,
    headSha: pr.headRefOid,
    files,
    comparison: { baseSha, headSha: pr.headRefOid },
    source: { kind: 'commit', headRef: pr.headRefName, baseRef: pr.baseRefName, baseTipSha: pr.baseRefOid },
  };
}

/** PR associated with the current branch (via GitHub CLI). Lists files only. */
export class PrScope implements ReviewScope {
  async load(cwd: string): Promise<ReviewSet> {
    const pr = await getCurrentPr(cwd);
    // Use the API's exact endpoints, not a potentially stale origin/base on a fork.
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
    const pr = await getPrByNumber(cwd, this.number);
    return prReviewSet(cwd, pr);
  }
}

export class BranchSnapshotScope implements ReviewScope {
  constructor(readonly headRef: string, readonly baseRef?: string) {}

  async load(cwd: string): Promise<ReviewSet> {
    const headSha = await git.resolveCommit(cwd, this.headRef);
    const repositoryIdentity = await git.repositoryRemoteIdentity(cwd);
    if (!this.baseRef) {
      const paths = await git.snapshotPaths(cwd, headSha);
      return {
        repositoryIdentity,
        scopeId: `branch-full-${this.headRef}`,
        label: m().scope.branchSnapshot(this.headRef, paths.length),
        headSha, files: paths.map((path) => ({ path })),
        source: { kind: 'commit', headRef: this.headRef },
      };
    }

    const baseTip = await git.resolveCommit(cwd, this.baseRef);
    if (baseTip === headSha) throw new Error(m().scope.sameComparison);
    const baseSha = await git.mergeBase(cwd, baseTip, headSha);
    const files = await git.diffSnapshotFiles(cwd, baseSha, headSha);
    return {
      repositoryIdentity,
      scopeId: `branch-changes-${this.headRef}-vs-${this.baseRef}`,
      label: m().scope.branchChanges(this.headRef, this.baseRef, files.length),
      headSha, files, comparison: { baseSha, headSha },
      source: { kind: 'commit', headRef: this.headRef, baseRef: this.baseRef, baseTipSha: baseTip },
    };
  }
}
export function assertPrSnapshotCurrent(set: ReviewSet, pr: PullRequest): void {
  if (set.repositoryIdentity !== git.prRepositoryIdentity(pr.url)
    || set.scopeId !== `pr-${pr.number}` || set.headSha !== pr.headRefOid
    || set.source?.baseTipSha !== pr.baseRefOid) {
    throw new Error(m().scope.prSnapshotChanged);
  }
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
