import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewSet } from './types';
import {
  CurrentBranchSourceScope,
  scanReviewablePaths,
  tryLoadPreferredScope,
  type ScopeScanProgress,
} from './scopePicker';

const sampleReviewSet: ReviewSet = {
  scopeId: 'pr-42',
  label: 'PR #42 · Faster startup',
  headSha: 'abc123',
  files: [{ path: 'src/extension.ts' }],
};

describe('scanReviewablePaths progress', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it('reports live scan counters and the final reviewable file count', async () => {
    root = await mkdtemp(join(tmpdir(), 'ai-coding-review-scan-'));
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules'));
    await Promise.all([
      writeFile(join(root, 'src', 'one.ts'), 'export const one = 1;'),
      writeFile(join(root, 'src', 'two.ts'), 'export const two = 2;'),
      writeFile(join(root, 'node_modules', 'ignored.ts'), 'export const ignored = true;'),
      writeFile(join(root, 'image.png'), 'not an image'),
    ]);

    const updates: ScopeScanProgress[] = [];
    const relPaths = await scanReviewablePaths(
      [{ fsPath: root } as import('vscode').Uri],
      root,
      (progress) => updates.push(progress),
    );

    expect(relPaths).toEqual(['src/one.ts', 'src/two.ts']);
    expect(updates[0]).toMatchObject({ directoriesScanned: 0, filesFound: 0, percent: 0 });
    expect(updates.at(-1)).toEqual({
      directoriesScanned: 2,
      filesFound: 2,
      percent: 100,
      etaSeconds: undefined,
      estimated: false,
    });
    expect(updates.every((update, index) =>
      index === 0 || update.percent >= updates[index - 1].percent,
    )).toBe(true);
  });
});

describe('tryLoadPreferredScope', () => {
  it('uses current branch sources when no PR is available', async () => {
    const attempts: string[] = [];
    const branchSet: ReviewSet = {
      scopeId: 'branch-source-main',
      label: 'main · 2 source files',
      headSha: 'live',
      files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
    };
    const candidates = [
      { kind: 'currentPr' as const, scope: { load: async () => { throw new Error('no PR'); } } },
      { kind: 'branchSource' as const, scope: { load: async () => branchSet } },
    ];

    const result = await tryLoadPreferredScope(
      'C:\\repo',
      (kind) => attempts.push(kind),
      undefined,
      candidates,
    );

    expect(attempts).toEqual(['currentPr', 'branchSource']);
    expect(result?.kind).toBe('branchSource');
    expect(result?.reviewSet).toBe(branchSet);
  });

  it('returns undefined instead of scanning the whole repository', async () => {
    const candidates = [
      { kind: 'currentPr' as const, scope: { load: async () => { throw new Error('no PR'); } } },
      { kind: 'branchSource' as const, scope: { load: async () => ({ ...sampleReviewSet, files: [] }) } },
    ];

    await expect(tryLoadPreferredScope('C:\\repo', undefined, undefined, candidates))
      .resolves.toBeUndefined();
  });

  it('builds a pure-source review for the checked-out branch', async () => {
    const scope = new CurrentBranchSourceScope(
      undefined,
      async () => ['src/a.ts', 'src/b.ts'],
      async () => 'feature/demo',
    );

    await expect(scope.load('C:\\repo')).resolves.toEqual({
      scopeId: 'branch-source-feature/demo',
      label: 'feature/demo · 2 source files',
      headSha: 'live',
      files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
    });
  });
});