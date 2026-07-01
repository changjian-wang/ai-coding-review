import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { m } from '../i18n';
import type { PullRequest, PrSummary } from './types';

const pexec = promisify(execFile);

/** Raised for any gh-related failure with a user-facing message. */
export class GhError extends Error {
  constructor(message: string, readonly code?: 'not-found' | 'not-authed') {
    super(message);
  }
}

const MAX_BUFFER = 32 * 1024 * 1024;
/** Hard ceiling so a hung gh process (network stall) can never freeze the UI. */
const GH_TIMEOUT_MS = 60_000;

/**
 * Optional hook returning a gh token to use for a given repo `cwd`, so the
 * account is selected per repository. Injected from activate() to keep this
 * module free of vscode dependencies. Returns undefined to use gh's default
 * (global active) account.
 */
type GhTokenResolver = (cwd: string) => Promise<string | undefined>;
let tokenResolver: GhTokenResolver | undefined;

/** Registers the per-repo gh token resolver (see GhTokenResolver). */
export function setGhTokenResolver(fn: GhTokenResolver): void {
  tokenResolver = fn;
}

async function runGh(args: string[], cwd: string): Promise<string> {
  let env: NodeJS.ProcessEnv | undefined;
  if (tokenResolver) {
    const token = await tokenResolver(cwd).catch(() => undefined);
    if (token) {
      env = { ...process.env, GH_TOKEN: token };
    }
  }
  try {
    const { stdout } = await pexec('gh', args, { cwd, env, maxBuffer: MAX_BUFFER, timeout: GH_TIMEOUT_MS });
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
    throw new GhError(m().gh.notFound, 'not-found');
  }
}

/** Throws GhError if the user is not authenticated with gh. */
export async function ensureAuth(cwd: string): Promise<void> {
  try {
    await pexec('gh', ['auth', 'status'], { cwd });
  } catch {
    throw new GhError(m().gh.notAuthed, 'not-authed');
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
    files?: { path: string; additions?: number; deletions?: number; changeType?: string }[];
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
      status: normaliseFileStatus(f.changeType),
    })),
  };
}

/**
 * Lists OPEN pull requests (drafts included — a draft is an open PR) for the
 * repo, as lightweight summaries (no file lists) for the PR picker. Single gh
 * call; ordering is whatever gh returns (newest-updated first by default).
 */
export async function listPrs(cwd: string, opts?: { author?: string }): Promise<PrSummary[]> {
  const args = [
    'pr', 'list',
    '--state', 'all',
    '--limit', '100',
    '--json',
    'number,title,url,author,isDraft,state,headRefName,baseRefName,updatedAt,additions,deletions,changedFiles',
  ];
  if (opts?.author) {
    args.push('--author', opts.author);
  }
  const json = await runGh(args, cwd);
  let raw: Array<{
    number: number;
    title: string;
    url: string;
    author?: { login?: string };
    isDraft?: boolean;
    state?: string;
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
    state: p.state ?? 'OPEN',
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    updatedAt: p.updatedAt,
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    changedFiles: p.changedFiles ?? 0,
  }));
}

/** Merges PR summary lists, de-duplicating by number, newest-updated first. */
export function mergePrsByNumber(...lists: PrSummary[][]): PrSummary[] {
  const byNum = new Map<number, PrSummary>();
  for (const list of lists) {
    for (const p of list) {
      byNum.set(p.number, p);
    }
  }
  return [...byNum.values()].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
  );
}

/** Base-repo slug (OWNER/REPO) gh resolves for this clone (upstream for a fork). */
export async function repoSlug(cwd: string): Promise<string> {
  return (await runGh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], cwd)).trim();
}

/** Login of the currently authenticated gh user (for the "Mine" PR filter). */
export async function currentLogin(cwd: string): Promise<string> {
  return (await runGh(['api', 'user', '--jq', '.login'], cwd)).trim();
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
    files?: { path: string; additions?: number; deletions?: number; changeType?: string }[];
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
      status: normaliseFileStatus(f.changeType),
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
