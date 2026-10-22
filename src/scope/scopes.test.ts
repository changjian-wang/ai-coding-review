import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BranchSnapshotScope, PrByNumberScope, assertPrSnapshotCurrent } from './scopes';
import {
  diffSnapshotFiles, fetchPrSnapshot, parseSnapshotChanges, readSnapshotFile,
  repositoryRoot, resolveCommit, snapshotPaths, validateRepositoryPath,
  remoteRepositoryIdentity, prRepositoryIdentity,
} from './gitClient';
import { getPrByNumber } from '../gh/ghClient';

vi.mock('../gh/ghClient', () => ({ getPrByNumber: vi.fn(), getCurrentPr: vi.fn() }));

const exec = promisify(execFile);

describe('immutable Git review scopes', () => {
  let root: string;
  let base: string;
  let head: string;
  const git = async (...args: string[]) => (await exec('git', args, { cwd: root })).stdout.trim();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'codereview-snapshot-'));
    await mkdir(join(root, 'src'));
    await git('init', '--initial-branch=main');
    await git('config', 'core.autocrlf', 'false');
    await writeFile(join(root, 'src', 'value.ts'), 'export const value = "main";\n');
    await writeFile(join(root, 'src', 'old.ts'), 'export const renamed = true;\n');
    await writeFile(join(root, 'remove.md'), '# Removed in feature\n');
    await git('add', '.');
    await git('-c', 'user.name=Review Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base');
    base = await git('rev-parse', 'HEAD');
    await git('switch', '-c', 'feature/snapshot');
    await writeFile(join(root, 'src', 'value.ts'), 'export const value = "feature";\n');
    await rename(join(root, 'src', 'old.ts'), join(root, 'src', 'renamed.ts'));
    await rm(join(root, 'remove.md'));
    await writeFile(join(root, 'added file.md'), '# Added\n');
    await writeFile(join(root, 'binary.dat'), Buffer.from([1, 0, 255]));
    await writeFile(join(root, 'utf8.txt'), '\ufeff中文\r\n');
    await git('add', '.');
    await git('-c', 'user.name=Review Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'feature');
    head = await git('rev-parse', 'HEAD');
    await git('switch', 'main');
    await writeFile(join(root, 'src', 'value.ts'), 'unsaved local work on main\n');
    await writeFile(join(root, 'untracked.txt'), 'Do not include or stash me');
  }, 20_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('resolves repository roots and exact commits, rejecting invalid refs', async () => {
    expect(await realpath(await repositoryRoot(join(root, 'src')))).toBe(await realpath(root));
    expect(await resolveCommit(root, 'feature/snapshot')).toBe(head);
    await expect(resolveCommit(root, '--help')).rejects.toThrow();
    await expect(resolveCommit(root, 'missing-branch')).rejects.toThrow();
  });

  it('reads a selected branch commit rather than dirty work on another branch', async () => {
    const set = await new BranchSnapshotScope('feature/snapshot').load(root);
    expect(set.headSha).toBe(head);
    expect(set.source).toEqual({ kind: 'commit', headRef: 'feature/snapshot' });
    expect(set.files.map((file) => file.path)).toContain('added file.md');
    expect(set.files.map((file) => file.path)).not.toContain('untracked.txt');
    expect(await readSnapshotFile(root, set.headSha, 'src/value.ts')).toContain('"feature"');
    expect(await git('branch', '--show-current')).toBe('main');
    expect(await readFile(join(root, 'src', 'value.ts'), 'utf8')).toBe('unsaved local work on main\n');
    expect(await git('stash', 'list')).toBe('');
  });

  it('compares exact merge-base/head objects and preserves deletes and renames', async () => {
    const set = await new BranchSnapshotScope('feature/snapshot', 'main').load(root);
    expect(set.comparison).toEqual({ baseSha: base, headSha: head });
    expect(set.files).toContainEqual(expect.objectContaining({ path: 'remove.md', status: 'deleted' }));
    expect(set.files).toContainEqual(expect.objectContaining({ path: 'src/renamed.ts', previousPath: 'src/old.ts', status: 'renamed' }));
    expect(set.files.find((file) => file.path === 'src/value.ts')).toMatchObject({ additions: 1, deletions: 1 });
    expect(set.files.some((file) => file.path === 'untracked.txt')).toBe(false);
    await expect(new BranchSnapshotScope('main', 'main').load(root)).rejects.toThrow(/same commit/);
  });

  it('PR review does not checkout and does not trust a truncated PR API file list', async () => {
    vi.mocked(getPrByNumber).mockResolvedValue({
      number: 42, title: 'Snapshot', url: 'https://github.com/test/repo/pull/42',
      headRefName: 'feature/snapshot', baseRefName: 'main', headRefOid: head, baseRefOid: base, files: [],
    });
    const set = await new PrByNumberScope(42).load(root);
    expect(set.repositoryIdentity).toBe('github.com/test/repo');
    const pr = await getPrByNumber(root, 42);
    expect(() => assertPrSnapshotCurrent(set, pr)).not.toThrow();
    expect(() => assertPrSnapshotCurrent(set, { ...pr, headRefOid: 'c'.repeat(40) })).toThrow(/changed/);
    expect(() => assertPrSnapshotCurrent(set, { ...pr, baseRefOid: 'd'.repeat(40) })).toThrow(/changed/);
    expect(() => assertPrSnapshotCurrent(set, { ...pr, url: 'https://github.com/another/repo/pull/42' })).toThrow(/changed/);
    expect(set.files).toHaveLength(6);
    expect(set.files).toEqual(await diffSnapshotFiles(root, base, head));
    expect(await git('branch', '--show-current')).toBe('main');
    expect(await git('stash', 'list')).toBe('');
    expect(await readFile(join(root, 'untracked.txt'), 'utf8')).toBe('Do not include or stash me');
  });

  it('normalizes GitHub remote identity without persisting URL credentials', () => {
    expect(remoteRepositoryIdentity('https://example-user:not-a-real-password@github.com/Owner/Repo.git')).toBe('github.com/owner/repo');
    expect(remoteRepositoryIdentity('git@github.com:Owner/Repo.git')).toBe('github.com/owner/repo');
    expect(remoteRepositoryIdentity('ssh://git@github.com:22/Owner/Repo.git')).toBe('github.com/owner/repo');
    expect(prRepositoryIdentity('https://github.com/Owner/Repo/pull/42')).toBe('github.com/owner/repo');
    expect(() => prRepositoryIdentity('https://example.com/Owner/Repo/pull/42')).toThrow();
  });

  it('preserves UTF-8 and BOM/line endings, and explicitly rejects unreadable content', async () => {
    expect(await readSnapshotFile(root, head, 'utf8.txt')).toBe('\ufeff中文\r\n');
    await expect(readSnapshotFile(root, head, 'binary.dat')).rejects.toThrow(/binary/);
    await expect(readSnapshotFile(root, head, 'missing.ts')).rejects.toThrow();
    expect(await snapshotPaths(root, head)).toContain('binary.dat');
  });

  it('rejects out-of-repository paths and non-GitHub fetch targets without networking', async () => {
    for (const path of ['../secret', 'a/../../secret', '/etc/passwd', 'C:/private', 'a\\b', 'a//b', '', 'a/./b']) {
      expect(() => validateRepositoryPath(path)).toThrow();
    }
    await expect(fetchPrSnapshot(root, 'https://example.com/test/repo/pull/42', 42, 'main')).rejects.toThrow(/target/);
    await expect(fetchPrSnapshot(root, 'https://github.com/test/repo/pull/42', 43, 'main')).rejects.toThrow(/target/);
  });
});

it('parses NUL-delimited paths without trimming whitespace or losing renamed files', () => {
  const files = parseSnapshotChanges(
    'M\0 a\tname.ts\0R100\0old\nname.ts\0new\nname.ts\0',
    ['1\t2\t a\tname.ts', '0\t0\t', 'old\nname.ts', 'new\nname.ts', ''].join('\0'),
  );
  expect(files).toEqual([
    { path: ' a\tname.ts', status: 'modified', previousPath: undefined, additions: 1, deletions: 2 },
    { path: 'new\nname.ts', previousPath: 'old\nname.ts', status: 'renamed', additions: 0, deletions: 0 },
  ]);
  expect(() => parseSnapshotChanges('R100\0old\0', '')).toThrow(/invalid/);
});
