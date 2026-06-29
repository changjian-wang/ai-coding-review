import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { m } from '../i18n';
import type { ReviewFile } from './types';

const pexec = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;
/** Hard ceiling so a hung git process can never freeze the review UI. */
const GIT_TIMEOUT_MS = 30_000;

/** Raised for any git failure with a user-facing message. */
export class GitError extends Error {}

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

function parseNameStatus(out: string): Map<string, ReviewFile['status']> {
  const statusByPath = new Map<string, ReviewFile['status']>();
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split('\t');
    const code = parts[0];
    let status: ReviewFile['status'];
    let filePath = parts[1];
    if (code.startsWith('R')) {
      status = 'renamed';
      filePath = parts[2] ?? filePath;
    } else if (code === 'A') {
      status = 'added';
    } else if (code === 'D') {
      status = 'deleted';
    } else {
      status = 'modified';
    }
    if (filePath) {
      statusByPath.set(filePath, status);
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
    status: statuses.get(file.path) ?? file.status,
  }));
}

/** Files changed for an arbitrary diff range, e.g. "main...HEAD". */
export async function diffFiles(cwd: string, range: string): Promise<ReviewFile[]> {
  return diffFilesWithStatus(cwd, [range]);
}

/** Tracked changes in the working tree and index vs HEAD. */
export async function workingTreeFiles(cwd: string): Promise<ReviewFile[]> {
  return diffFilesWithStatus(cwd, ['HEAD']);
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
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const out = await git(['status', '--porcelain'], cwd);
  return out.trim().length > 0;
}

/**
 * Switches to an existing local branch. If the working tree is dirty, auto-stashes
 * (including untracked files) first so the checkout always succeeds; returns whether
 * a stash was created so the caller can tell the user how to restore it.
 */
export async function switchBranchTo(cwd: string, branch: string): Promise<{ stashed: boolean }> {
  const stashed = await hasUncommittedChanges(cwd);
  if (stashed) {
    await git(['stash', 'push', '-u', '-m', `ai-coding-review: auto-stash before switch to ${branch}`], cwd);
  }
  await git(['switch', branch], cwd);
  return { stashed };
}
