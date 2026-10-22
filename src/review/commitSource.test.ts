import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CommitSource } from './commitSource';
import { readSnapshotFile, snapshotPaths } from '../scope/gitClient';
import { collectRelatedRepositoryContext, validateRepositoryAnalysisContext } from './repositoryEvidence';
import type { ReviewSet } from '../scope/types';

vi.mock('../scope/gitClient', async (original) => ({
  ...await original<typeof import('../scope/gitClient')>(),
  readSnapshotFile: vi.fn(),
  snapshotPaths: vi.fn(),
}));

const cwd = path.resolve('commit-source-fixture');
const set: ReviewSet = {
  scopeId: 'pr-1', label: 'PR #1', headSha: 'a'.repeat(40),
  comparison: { baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40) },
  source: { kind: 'commit', headRef: 'feature', baseRef: 'main' },
  files: [{ path: 'root.ts' }, { path: 'deleted.ts', status: 'deleted' }],
};

describe('commit source and related evidence', () => {
  it('reads deleted code from the base and other sources from the selected head, caching immutable reads', async () => {
    vi.mocked(readSnapshotFile).mockImplementation(async (_cwd, sha, file) => `${sha}:${file}`);
    const source = new CommitSource(cwd, set);
    expect(await source.readReviewFile('root.ts')).toBe(`${set.headSha}:root.ts`);
    const before = vi.mocked(readSnapshotFile).mock.calls.length;
    await source.readReviewFile('root.ts');
    expect(vi.mocked(readSnapshotFile).mock.calls).toHaveLength(before);
    expect(await source.readReviewFile('deleted.ts')).toBe(`${set.comparison!.baseSha}:deleted.ts`);
    expect(() => source.read('../outside.ts')).toThrow();
  });

  it('searches only the target commit, reports unavailable language services, and does not use working-tree providers', async () => {
    const texts = new Map([
      ['root.ts', 'export function submit() { return Inventory.reserve(); }'],
      ['inventory.ts', 'export class Inventory { static reserve() { return false; } }'],
      ['tests/inventory.test.ts', 'Inventory.reserve();'],
    ]);
    vi.mocked(snapshotPaths).mockResolvedValue([...texts.keys()]);
    vi.mocked(readSnapshotFile).mockImplementation(async (_cwd, sha, file) => {
      expect(sha).toBe(set.headSha);
      const text = texts.get(file);
      if (text === undefined) throw new Error('Not part of this snapshot');
      return text;
    });
    const source = new CommitSource(cwd, set);
    const services = source.evidenceServices();
    const root = texts.get('root.ts')!;
    const token = new vscode.CancellationTokenSource();
    const context = await collectRelatedRepositoryContext({
      cwd, sourcePath: 'root.ts',
      sourceDocument: { uri: vscode.Uri.file(path.join(cwd, 'root.ts')), getText: () => root },
      token: token.token,
    }, services);
    expect(context.files).toContain('inventory.ts');
    expect(context.snippets.find((snippet) => snippet.file === 'inventory.ts')?.kind).toBe('search');
    expect(context.limitReasons).toContain('language-services-unavailable');
    expect(context.truncated).toBe(true);
    expect(context.providerCalls).toBe(0);
    expect(await validateRepositoryAnalysisContext(context, cwd, token.token, services)).toBe(true);
    await expect(services.readText(vscode.Uri.file(path.join(cwd, '..', 'private.ts')))).rejects.toThrow();
    token.dispose();
  });
});
