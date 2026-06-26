import * as git from './gitClient';
import { checkoutPr, ensureAuth, ensureGhAvailable, getCurrentPr, getPrByNumber } from '../gh/ghClient';
import { m } from '../i18n';
import type { ReviewFile, ReviewScope, ReviewSet } from './types';

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

/** PR associated with the current branch (via GitHub CLI). Lists files only. */
export class PrScope implements ReviewScope {
  async load(cwd: string): Promise<ReviewSet> {
    await ensureGhAvailable(cwd);
    await ensureAuth(cwd);
    const pr = await getCurrentPr(cwd);
    let files = pr.files;
    try {
      files = await git.diffFiles(cwd, `origin/${pr.baseRefName}...HEAD`);
    } catch {
      // Fall back to gh's file list when the base ref is not available locally.
    }
    return {
      scopeId: `pr-${pr.number}`,
      label: `PR #${pr.number} · ${pr.title}`,
      headSha: pr.headRefOid,
      files,
    };
  }
}

/**
 * A specific PR chosen from the picker — may live on a branch we don't have
 * checked out, so the file list comes straight from gh (no local git range).
 */
export class PrByNumberScope implements ReviewScope {
  constructor(private readonly number: number) {}

  async load(cwd: string): Promise<ReviewSet> {
    await ensureGhAvailable(cwd);
    await ensureAuth(cwd);
    // Check out the PR's branch so the working tree matches the PR under review;
    // a chosen PR is usually not the branch currently checked out.
    await checkoutPr(cwd, this.number);
    const pr = await getPrByNumber(cwd, this.number);
    let files = pr.files;
    try {
      files = await git.diffFiles(cwd, `origin/${pr.baseRefName}...HEAD`);
    } catch {
      // Fall back to gh's file list when the base ref is not available locally.
    }
    return {
      scopeId: `pr-${pr.number}`,
      label: `PR #${pr.number} · ${pr.title}`,
      headSha: pr.headRefOid,
      files,
    };
  }
}

/** Files differing between the current branch and its base (pure git). */
export class BranchVsBaseScope implements ReviewScope {
  constructor(private readonly base?: string) {}

  async load(cwd: string): Promise<ReviewSet> {
    await git.ensureGitRepo(cwd);
    const base = this.base ?? (await git.detectBaseBranch(cwd));
    const headSha = await git.headSha(cwd);
    const files = await git.diffFiles(cwd, `${base}...HEAD`);
    return {
      scopeId: `branch-vs-${base}`,
      label: m().scope.branchVsBase(base),
      headSha,
      files,
    };
  }
}

/** Uncommitted tracked changes in the working tree (pure git). */
export class WorkingTreeScope implements ReviewScope {
  async load(cwd: string): Promise<ReviewSet> {
    await git.ensureGitRepo(cwd);
    const headSha = await git.headSha(cwd);
    const files = await git.workingTreeFiles(cwd);
    return {
      scopeId: 'working-tree',
      label: m().scope.workingTree,
      headSha,
      files,
    };
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
