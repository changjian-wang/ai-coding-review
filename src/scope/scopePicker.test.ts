import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewSet } from './types';
import {
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
  it('uses the current branch when no PR is available', async () => {
    const attempts: string[] = [];
    const branchSet: ReviewSet = {
      scopeId: 'branch-vs-main',
      label: 'Current branch vs main',
      headSha: 'abc',
      files: [{ path: 'src/changed.ts' }],
    };
    const candidates = [
      { kind: 'currentPr' as const, scope: { load: async () => { throw new Error('no PR'); } } },
      { kind: 'branch' as const, scope: { load: async () => branchSet } },
    ];

    const result = await tryLoadPreferredScope(
      'C:\\repo',
      (kind) => attempts.push(kind),
      candidates,
    );

    expect(attempts).toEqual(['currentPr', 'branch']);
    expect(result?.kind).toBe('branch');
    expect(result?.reviewSet).toBe(branchSet);
  });

  it('returns undefined instead of scanning the whole repository', async () => {
    const candidates = [
      { kind: 'currentPr' as const, scope: { load: async () => { throw new Error('no PR'); } } },
      { kind: 'branch' as const, scope: { load: async () => ({ ...sampleReviewSet, files: [] }) } },
    ];

    await expect(tryLoadPreferredScope('C:\\repo', undefined, candidates))
      .resolves.toBeUndefined();
  });
});