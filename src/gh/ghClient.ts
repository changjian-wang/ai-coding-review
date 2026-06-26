import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { m } from '../i18n';
import type { PullRequest, PrSummary } from './types';

const pexec = promisify(execFile);

/** Raised for any gh-related failure with a user-facing message. */
export class GhError extends Error {}

const MAX_BUFFER = 32 * 1024 * 1024;
/** Hard ceiling so a hung gh process (network stall) can never freeze the UI. */
const GH_TIMEOUT_MS = 60_000;

async function runGh(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await pexec('gh', args, { cwd, maxBuffer: MAX_BUFFER, timeout: GH_TIMEOUT_MS });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string; killed?: boolean; signal?: string };
    if (e.killed || e.signal === 'SIGTERM') {
      throw new GhError(m().gh.timeout(args[0], GH_TIMEOUT_MS / 1000));
    }
    const msg = (e.stderr || e.message || String(err)).trim();
    throw new GhError(msg);
  }
}

/** Throws GhError if the GitHub CLI is not installed / not on PATH. */
export async function ensureGhAvailable(cwd: string): Promise<void> {
  try {
    await pexec('gh', ['--version'], { cwd });
  } catch {
    throw new GhError(m().gh.notFound);
  }
}

/** Throws GhError if the user is not authenticated with gh. */
export async function ensureAuth(cwd: string): Promise<void> {
  try {
    await pexec('gh', ['auth', 'status'], { cwd });
  } catch {
    throw new GhError(m().gh.notAuthed);
  }
}

/** Loads the PR associated with the current branch in `cwd`. */
export async function getCurrentPr(cwd: string): Promise<PullRequest> {
  let json: string;
  try {
    json = await runGh(
      ['pr', 'view', '--json', 'number,title,url,headRefName,baseRefName,headRefOid,files'],
      cwd,
    );
  } catch {
    // gh exits non-zero when the current branch has no associated PR (e.g. on
    // main). Surface a clear, actionable message instead of the raw gh stderr.
    throw new GhError(m().gh.noCurrentPr);
  }
  let raw: {
    number: number;
    title: string;
    url: string;
    headRefName: string;
    baseRefName: string;
    headRefOid: string;
    files?: { path: string; additions?: number; deletions?: number; status?: string }[];
  };
  try {
    raw = JSON.parse(json);
  } catch {
    throw new GhError(m().gh.prParseFailed);
  }
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    headRefOid: raw.headRefOid,
    files: (raw.files ?? []).map((f) => ({
      path: f.path,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      status: normaliseFileStatus(f.status),
    })),
  };
}

/**
 * Lists OPEN pull requests (drafts included — a draft is an open PR) for the
 * repo, as lightweight summaries (no file lists) for the PR picker. Single gh
 * call; ordering is whatever gh returns (newest-updated first by default).
 */
export async function listPrs(cwd: string): Promise<PrSummary[]> {
  const json = await runGh(
    [
      'pr', 'list',
      '--state', 'open',
      '--limit', '50',
      '--json',
      'number,title,url,author,isDraft,headRefName,baseRefName,updatedAt,additions,deletions,changedFiles',
    ],
    cwd,
  );
  let raw: Array<{
    number: number;
    title: string;
    url: string;
    author?: { login?: string };
    isDraft?: boolean;
    headRefName: string;
    baseRefName: string;
    updatedAt: string;
    additions?: number;
    deletions?: number;
    changedFiles?: number;
  }>;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new GhError(m().gh.prListParseFailed);
  }
  return raw.map((p) => ({
    number: p.number,
    title: p.title,
    url: p.url,
    author: p.author?.login ?? '',
    isDraft: p.isDraft ?? false,
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    updatedAt: p.updatedAt,
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    changedFiles: p.changedFiles ?? 0,
  }));
}

/** Loads a specific PR by number — may be a branch we don't have checked out. */
export async function getPrByNumber(cwd: string, number: number): Promise<PullRequest> {
  const json = await runGh(
    ['pr', 'view', String(number), '--json', 'number,title,url,headRefName,baseRefName,headRefOid,files'],
    cwd,
  );
  let raw: {
    number: number;
    title: string;
    url: string;
    headRefName: string;
    baseRefName: string;
    headRefOid: string;
    files?: { path: string; additions?: number; deletions?: number; status?: string }[];
  };
  try {
    raw = JSON.parse(json);
  } catch {
    throw new GhError(m().gh.prParseFailed);
  }
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    headRefOid: raw.headRefOid,
    files: (raw.files ?? []).map((f) => ({
      path: f.path,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      status: normaliseFileStatus(f.status),
    })),
  };
}

/** Checks out the PR's head branch locally so the working tree matches the PR. */
export async function checkoutPr(cwd: string, number: number): Promise<void> {
  try {
    await runGh(['pr', 'checkout', String(number)], cwd);
  } catch {
    throw new GhError(m().gh.checkoutFailed);
  }
}

function normaliseFileStatus(status: string | undefined): PullRequest['files'][number]['status'] {
  switch ((status ?? '').toUpperCase()) {
    case 'ADDED':
    case 'A':
      return 'added';
    case 'REMOVED':
    case 'DELETED':
    case 'D':
      return 'deleted';
    case 'RENAMED':
    case 'R':
      return 'renamed';
    case 'MODIFIED':
    case 'CHANGED':
    case 'M':
      return 'modified';
    default:
      return undefined;
  }
}

/** Raw unified diff for the current branch's PR. */
export async function getPrDiff(cwd: string): Promise<string> {
  return runGh(['pr', 'diff'], cwd);
}

/** Posts a review verdict to a PR via `gh pr review`. */
export async function submitPrReview(
  cwd: string,
  prNumber: number,
  verdict: 'approve' | 'request-changes' | 'comment',
  body: string,
): Promise<void> {
  const flag =
    verdict === 'approve' ? '--approve' : verdict === 'request-changes' ? '--request-changes' : '--comment';
  const args = ['pr', 'review', String(prNumber), flag];
  if (body.trim()) {
    args.push('--body', body);
  }
  await runGh(args, cwd);
}

/** Posts a non-line-anchored PR comment. Used when a finding is outside the PR diff. */
export async function postPrComment(cwd: string, prNumber: number, body: string): Promise<void> {
  await runGh(['pr', 'comment', String(prNumber), '--body', body], cwd);
}

/** Posts a single line-anchored review comment to a PR via the GitHub REST API. */
export async function postPrLineComment(
  cwd: string,
  prNumber: number,
  commitSha: string,
  filePath: string,
  line: number,
  body: string,
): Promise<{ id: number; url: string }> {
  // gh api needs the owner/repo, derivable from the remote.
  const repoJson = await runGh(['repo', 'view', '--json', 'owner,name'], cwd);
  let repo: { owner: { login: string }; name: string };
  try {
    repo = JSON.parse(repoJson);
  } catch {
    throw new GhError(m().gh.repoViewParseFailed);
  }
  const slug = `${repo.owner.login}/${repo.name}`;
  const out = await runGh(
    [
      'api',
      `repos/${slug}/pulls/${prNumber}/comments`,
      '-X', 'POST',
      '-f', `body=${body}`,
      '-f', `commit_id=${commitSha}`,
      '-f', `path=${filePath}`,
      '-F', `line=${line}`,
      '-f', 'side=RIGHT',
    ],
    cwd,
  );
  try {
    const parsed = JSON.parse(out);
    return { id: parsed.id, url: parsed.html_url };
  } catch {
    throw new GhError(m().gh.commentParseFailed);
  }
}
