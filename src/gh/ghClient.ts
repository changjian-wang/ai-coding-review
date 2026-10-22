import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { m } from '../i18n';
import type { PullRequest, PrSummary, GitHubRepositoryTarget } from './types';

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
  const json = await runGh(
    ['pr', 'view', '--json', 'number,title,url,headRefName,baseRefName,baseRefOid,headRefOid,files'],
    cwd,
  );
  let raw: {
    number: number;
    title: string;
    url: string;
    headRefName: string;
    baseRefName: string;
    baseRefOid: string;
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
    baseRefOid: raw.baseRefOid,
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
function validateTarget(target: GitHubRepositoryTarget | undefined): void {
  if (target && (target.host !== 'github.com' || !/^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(target.nameWithOwner)
    || ['.', '..'].includes(target.nameWithOwner.split('/')[1]))) {
    throw new GhError(m().git.invalidPrTarget);
  }
}

export async function getPrByNumber(cwd: string, number: number, target?: GitHubRepositoryTarget): Promise<PullRequest> {
  validateTarget(target);
  const json = await runGh(
    ['pr', 'view', String(number), '--json', 'number,title,url,headRefName,baseRefName,baseRefOid,headRefOid,files',
      ...(target ? ['--repo', `${target.host}/${target.nameWithOwner}`] : [])],
    cwd,
  );
  let raw: {
    number: number;
    title: string;
    url: string;
    headRefName: string;
    baseRefName: string;
    baseRefOid: string;
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
    baseRefOid: raw.baseRefOid,
    headRefOid: raw.headRefOid,
    files: (raw.files ?? []).map((f) => ({
      path: f.path,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      status: normaliseFileStatus(f.changeType),
    })),
  };
}

/** Reads only an explicitly supplied GitHub requirement URL using the selected repo account. */
export async function readGitHubRequirement(cwd: string, url: URL): Promise<{ name: string; text: string }> {
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) {
    throw new GhError(m().requirements.unsafeUrl);
  }
  const issue = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/([1-9][0-9]*)\/?$/.exec(url.pathname);
  if (issue) {
    const endpoint = `repos/${issue[1]}/${issue[2]}/${issue[3] === 'pull' ? 'pulls' : 'issues'}/${issue[4]}`;
    const output = await runGh(['api', '--hostname', 'github.com', endpoint], cwd);
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== 'object' || !('body' in value) || typeof value.body !== 'string'
      || !('title' in value) || typeof value.title !== 'string') throw new GhError(m().requirements.urlType);
    return { name: value.title, text: value.body };
  }
  const blob = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/blob\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!blob) throw new GhError(m().requirements.urlType);
  const file = blob[4].split('/').map(decodeURIComponent);
  if (file.some((part) => !part || part === '..' || part === '.' || part.includes('\0') || part.includes('\\'))
    || !/\.(md|markdown|txt)$/i.test(file.at(-1) ?? '')) throw new GhError(m().requirements.fileUnsupported);
  const ref = decodeURIComponent(blob[3]);
  if (!ref || ref.includes('\0')) throw new GhError(m().requirements.unsafeUrl);
  const endpoint = `repos/${blob[1]}/${blob[2]}/contents/${file.map(encodeURIComponent).join('/')}`;
  const text = await runGh([
    'api', '--hostname', 'github.com', endpoint, '-X', 'GET', '-f', `ref=${ref}`,
    '-H', 'Accept: application/vnd.github.raw+json',
  ], cwd);
  return { name: file.at(-1) ?? file.join('/'), text };
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

/**
 * Submits ONE PR review carrying any number of line-anchored comments in a
 * single request (the pending-review model): all draft comments post together
 * with the verdict, instead of appearing as separate standalone comments.
 * Multi-line comments use `start_line`..`line`. The payload is a nested array
 * gh api cannot express with `-f` flags, so it is sent via a temp JSON file
 * through `--input`; `runGh` still applies the per-repo account token.
 */
export async function submitPrReviewWithComments(
  cwd: string,
  prNumber: number,
  commitSha: string,
  verdict: 'approve' | 'request-changes' | 'comment',
  body: string,
  comments: { path: string; startLine: number; endLine: number; body: string }[],
  target?: GitHubRepositoryTarget,
): Promise<void> {
  validateTarget(target);
  let slug = target?.nameWithOwner;
  if (!slug) {
    const repoJson = await runGh(['repo', 'view', '--json', 'owner,name'], cwd);
    let repo: { owner: { login: string }; name: string };
    try {
      repo = JSON.parse(repoJson);
    } catch {
      throw new GhError(m().gh.repoViewParseFailed);
    }
    slug = `${repo.owner.login}/${repo.name}`;
  }
  const event =
    verdict === 'approve' ? 'APPROVE' : verdict === 'request-changes' ? 'REQUEST_CHANGES' : 'COMMENT';
  const payload = {
    commit_id: commitSha,
    body,
    event,
    comments: comments.map((c) => {
      const entry: {
        path: string;
        side: string;
        line: number;
        body: string;
        start_line?: number;
        start_side?: string;
      } = { path: c.path, side: 'RIGHT', line: c.endLine, body: c.body };
      if (c.endLine > c.startLine) {
        entry.start_line = c.startLine;
        entry.start_side = 'RIGHT';
      }
      return entry;
    }),
  };
  const tmp = path.join(
    os.tmpdir(),
    `codereview-review-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
  try {
    await runGh(
      ['api', `repos/${slug}/pulls/${prNumber}/reviews`, '-X', 'POST', '--input', tmp,
        ...(target ? ['--hostname', target.host] : [])],
      cwd,
    );
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {
      /* temp file cleanup is best-effort */
    });
  }
}
