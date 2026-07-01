import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const pexec = promisify(execFile);

/** Only github.com is auto-resolved for now (covers github.com + EMU accounts). */
const GH_HOST = 'github.com';
const TOKEN_TTL_MS = 5 * 60_000;
const ACCOUNTS_TTL_MS = 5 * 60_000;
/** Persisted owner(lowercased) -> account login, so probing happens at most once. */
const CACHE_KEY = 'codereview.gh.ownerAccount.v1';

let memento: vscode.Memento | undefined;

interface Account {
  login: string;
  active: boolean;
}

let accountsCache: { at: number; accounts: Account[] } | undefined;
const tokenCache = new Map<string, { token: string; at: number }>();
const ownerLoginMem = new Map<string, string>();
/** cwd -> parsed slug (null = already checked, not a github.com origin). */
const slugCache = new Map<string, { owner: string; repo: string } | null>();

/** Wires the persistent owner->account cache. Call once from activate(). */
export function initAccountResolver(m: vscode.Memento): void {
  memento = m;
  const stored = m.get<Record<string, string>>(CACHE_KEY);
  if (stored) {
    for (const [owner, login] of Object.entries(stored)) {
      ownerLoginMem.set(owner, login);
    }
  }
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('codereview');
}

/** Parses OWNER/REPO from `origin` (github.com only). Cached per cwd. */
async function repoOwnerRepo(cwd: string): Promise<{ owner: string; repo: string } | undefined> {
  const cached = slugCache.get(cwd);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  let url = '';
  try {
    const { stdout } = await pexec('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 10_000 });
    url = stdout.trim();
  } catch {
    slugCache.set(cwd, null);
    return undefined;
  }
  // https://github.com/OWNER/REPO(.git) or git@github.com:OWNER/REPO(.git)
  const match = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/i);
  const slug = match ? { owner: match[1], repo: match[2] } : null;
  slugCache.set(cwd, slug);
  return slug ?? undefined;
}

/** Parses `gh auth status` into the list of logged-in github.com accounts. */
async function listAccounts(): Promise<Account[]> {
  const now = Date.now();
  if (accountsCache && now - accountsCache.at < ACCOUNTS_TTL_MS) {
    return accountsCache.accounts;
  }
  let out = '';
  try {
    const r = await pexec('gh', ['auth', 'status', '--hostname', GH_HOST], { timeout: 15_000 });
    out = `${r.stdout}\n${r.stderr ?? ''}`;
  } catch (e) {
    // gh exits non-zero when a host has no accounts; still parse whatever it wrote.
    const err = e as { stdout?: string; stderr?: string };
    out = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
  }
  const accounts: Account[] = [];
  let cur: Account | undefined;
  for (const line of out.split(/\r?\n/)) {
    const login = line.match(/Logged in to \S+ account (\S+)/i);
    if (login) {
      cur = { login: login[1], active: false };
      accounts.push(cur);
      continue;
    }
    const active = line.match(/Active account:\s*(true|false)/i);
    if (active && cur) {
      cur.active = active[1].toLowerCase() === 'true';
    }
  }
  accountsCache = { at: now, accounts };
  return accounts;
}

/** Reads a specific account's token from gh's keyring (short-lived cache). */
async function tokenFor(login: string): Promise<string | undefined> {
  const now = Date.now();
  const hit = tokenCache.get(login);
  if (hit && now - hit.at < TOKEN_TTL_MS) {
    return hit.token;
  }
  try {
    const { stdout } = await pexec(
      'gh',
      ['auth', 'token', '--user', login, '--hostname', GH_HOST],
      { timeout: 10_000 },
    );
    const token = stdout.trim();
    if (!token) {
      return undefined;
    }
    tokenCache.set(login, { token, at: now });
    return token;
  } catch {
    return undefined;
  }
}

/** True if `login`'s token can read `owner/repo` (probes the GitHub API). */
async function canAccess(login: string, owner: string, repo: string): Promise<boolean> {
  const token = await tokenFor(login);
  if (!token) {
    return false;
  }
  try {
    await pexec('gh', ['api', `repos/${owner}/${repo}`, '--jq', '.id'], {
      timeout: 15_000,
      env: { ...process.env, GH_TOKEN: token },
    });
    return true;
  } catch {
    return false;
  }
}

function persistOwnerLogin(ownerKey: string, login: string): void {
  ownerLoginMem.set(ownerKey, login);
  if (memento) {
    const stored = memento.get<Record<string, string>>(CACHE_KEY) ?? {};
    stored[ownerKey] = login;
    void memento.update(CACHE_KEY, stored);
  }
}

/**
 * Resolves the gh token to inject for GitHub API calls against `cwd`'s repo, so
 * the account that can actually access the repo is used automatically — without
 * touching the global active gh account. Returns `undefined` to keep gh's
 * default behaviour (single account, disabled, unresolved, or the active
 * account already has access). Never throws: account resolution must not break
 * a gh call.
 */
export async function resolveGhTokenForRepo(cwd: string): Promise<string | undefined> {
  try {
    if (!cfg().get<boolean>('autoAccount', true)) {
      return undefined;
    }
    const slug = await repoOwnerRepo(cwd);
    if (!slug) {
      return undefined;
    }
    const ownerKey = slug.owner.toLowerCase();

    const accounts = await listAccounts();
    if (accounts.length <= 1) {
      return undefined; // nothing to disambiguate
    }
    const activeLogin = accounts.find((a) => a.active)?.login;

    // 1) explicit user override wins.
    const override = cfg().get<Record<string, string>>('accountByOwner') ?? {};
    let login = override[slug.owner] ?? override[ownerKey];

    // 2) previously resolved account (still logged in).
    if (!login) {
      const cachedLogin = ownerLoginMem.get(ownerKey);
      if (cachedLogin && accounts.some((a) => a.login === cachedLogin)) {
        login = cachedLogin;
      }
    }

    // 3) probe: try the active account first, then the rest.
    if (!login) {
      const ordered = [
        ...accounts.filter((a) => a.active),
        ...accounts.filter((a) => !a.active),
      ];
      for (const acc of ordered) {
        if (await canAccess(acc.login, slug.owner, slug.repo)) {
          login = acc.login;
          break;
        }
      }
      if (login) {
        persistOwnerLogin(ownerKey, login);
      }
    }

    if (!login || login === activeLogin) {
      return undefined; // no match, or the active account is already correct
    }
    return await tokenFor(login);
  } catch {
    return undefined;
  }
}
