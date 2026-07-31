import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { m } from '../i18n';
import type { ReviewFile } from './types';

const pexec = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;
/** Hard ceiling so a hung git process can never freeze the review UI. */
const GIT_TIMEOUT_MS = 30_000;

/** Raised for any git failure with a user-facing message. */
class GitError extends Error {}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await pexec('git', args, { cwd, maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string; killed?: boolean; signal?: string };
    if (e.killed || e.signal === 'SIGTERM') {
      throw new GitError(m().git.timeout(args[0], GIT_TIMEOUT_MS / 1000));
    }
    throw new GitError((e.stderr || e.message || String(err)).trim());
  }
}

/** Throws GitError if cwd is not inside a git work tree. */
export async function ensureGitRepo(cwd: string): Promise<void> {
  try {
    await pexec('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  } catch {
    throw new GitError(m().git.notRepo);
  }
}

/** Current HEAD commit SHA. */
export async function headSha(cwd: string): Promise<string> {
  return (await git(['rev-parse', 'HEAD'], cwd)).trim();
}

/**
 * Best-effort default base branch: origin/HEAD's target, else main, else master.
 */
export async function detectBaseBranch(cwd: string): Promise<string> {
  try {
    const ref = (await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd)).trim();
    const name = ref.replace(/^refs\/remotes\/origin\//, '');
    if (name) {
      return `origin/${name}`;
    }
  } catch {
    // fall through to heuristics
  }
  for (const candidate of ['main', 'master']) {
    try {
      await git(['rev-parse', '--verify', '--quiet', candidate], cwd);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new GitError(m().git.noDefaultBranch);
}

/** Parses `git diff --numstat` output into ReviewFile[]. */
function parseNumstat(out: string): ReviewFile[] {
  const files: ReviewFile[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split('\t');
    if (parts.length < 3) {
      continue;
    }
    const [add, del, ...rest] = parts;
    let path = rest.join('\t');
    // Renames appear as "old => new" or "dir/{old => new}/file".
    const arrow = path.indexOf(' => ');
    const status: ReviewFile['status'] | undefined = arrow >= 0 ? 'renamed' : undefined;
    if (arrow >= 0) {
      path = path.replace(/\{[^}]*=> ([^}]*)\}/, '$1').replace(/^.* => /, '');
    }
    files.push({
      path,
      additions: add === '-' ? 0 : Number.parseInt(add, 10) || 0,
      deletions: del === '-' ? 0 : Number.parseInt(del, 10) || 0,
      status,
    });
  }
  return files;
}

interface NameStatus {
  status: ReviewFile['status'];
  previousPath?: string;
}

function parseNameStatus(out: string): Map<string, NameStatus> {
  const statusByPath = new Map<string, NameStatus>();
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split('\t');
    const code = parts[0];
    let status: ReviewFile['status'];
    let filePath = parts[1];
    let previousPath: string | undefined;
    if (code.startsWith('R')) {
      status = 'renamed';
      previousPath = parts[1];
      filePath = parts[2] ?? filePath;
    } else if (code === 'A') {
      status = 'added';
    } else if (code === 'D') {
      status = 'deleted';
    } else {
      status = 'modified';
    }
    if (filePath) {
      statusByPath.set(filePath, { status, previousPath });
    }
  }
  return statusByPath;
}

async function diffFilesWithStatus(cwd: string, args: string[]): Promise<ReviewFile[]> {
  const [numstat, nameStatus] = await Promise.all([
    git(['diff', '--numstat', ...args], cwd),
    git(['diff', '--name-status', ...args], cwd),
  ]);
  const statuses = parseNameStatus(nameStatus);
  return parseNumstat(numstat).map((file) => ({
    ...file,
    status: statuses.get(file.path)?.status ?? file.status,
    previousPath: statuses.get(file.path)?.previousPath,
  }));
}

/** Files changed for an arbitrary diff range, e.g. "main...HEAD". */
export async function diffFiles(cwd: string, range: string): Promise<ReviewFile[]> {
  return diffFilesWithStatus(cwd, [range]);
}

export interface GitWorkingFile {
  path: string;
  /** Git object size for tracked files; undefined for untracked files. */
  size?: number;
}

/** Tracked plus untracked, non-ignored files in the current Git work tree. */
export async function listWorkingFiles(cwd: string): Promise<GitWorkingFile[]> {
  const untrackedPromise = git(['ls-files', '-o', '--exclude-standard', '-z'], cwd).then(
    (out) => ({ out }),
    (error: unknown) => ({ error }),
  );
  let tracked: GitWorkingFile[];
  try {
    const out = await git(
      ['ls-files', '-z', '--format=%(objectsize)%x09%(path)'],
      cwd,
    );
    tracked = out.split('\0').filter(Boolean).map((record) => {
      const tab = record.indexOf('\t');
      return {
        path: tab >= 0 ? record.slice(tab + 1) : record,
        size: tab >= 0 ? Number(record.slice(0, tab)) : undefined,
      };
    });
  } catch {
    // Older Git versions do not support objectsize in --format.
    const out = await git(['ls-files', '-c', '-z'], cwd);
    tracked = out.split('\0').filter(Boolean).map((filePath) => ({ path: filePath }));
  }
  const untrackedResult = await untrackedPromise;
  if ('error' in untrackedResult) {
    throw untrackedResult.error;
  }
  const untracked = untrackedResult.out;
  return [
    ...tracked,
    ...untracked.split('\0').filter(Boolean).map((filePath) => ({ path: filePath })),
  ];
}

/** The common ancestor Git uses as the old side of a three-dot comparison. */
export async function mergeBase(cwd: string, baseRef: string, headRef: string): Promise<string> {
  return (await git(['merge-base', baseRef, headRef], cwd)).trim();
}

/** Reads a UTF-8 text file from a commit, returning undefined when it did not exist. */
export async function readFileAtRef(cwd: string, ref: string, relPath: string): Promise<string | undefined> {
  try {
    return await git(['show', `${ref}:${relPath}`], cwd);
  } catch {
    return undefined;
  }
}

/**
 * Current branch name. On a detached HEAD `git branch --show-current` is empty,
 * so fall back to a short SHA prefixed with '@' (e.g. '@1a2b3c4') for the HUD.
 */
export async function currentBranch(cwd: string): Promise<string> {
  const name = (await git(['branch', '--show-current'], cwd)).trim();
  if (name) {
    return name;
  }
  const sha = (await git(['rev-parse', '--short', 'HEAD'], cwd)).trim();
  return sha ? `@${sha}` : '';
}

/** Local branch names (for the inline branch switch menu). */
export async function listBranches(cwd: string): Promise<string[]> {
  const out = await git(['branch', '--format=%(refname:short)'], cwd);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** True when the working tree or index has uncommitted changes. */
async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const out = await git(['status', '--porcelain'], cwd);
  return out.trim().length > 0;
}

/**
 * Switches to an existing local branch. If the working tree is dirty, auto-stashes
 * (including untracked files) first so the checkout always succeeds; returns whether
 * a stash was created so the caller can tell the user how to restore it.
 */
export async function switchBranchTo(cwd: string, branch: string): Promise<{ stashed: boolean }> {
  // Fast path: try switch with NO upfront `git status` (full-tree scans are slow
  // in large repos). Only when switch is refused — typically a dirty tree — do
  // we pay the status check and auto-stash, then retry.
  try {
    await git(['switch', branch], cwd);
    return { stashed: false };
  } catch (err) {
    if (!(await hasUncommittedChanges(cwd))) {
      throw err;
    }
    await git(['stash', 'push', '-u', '-m', `ai-coding-review: auto-stash before switch to ${branch}`], cwd);
    await git(['switch', branch], cwd);
    return { stashed: true };
  }
}
