import { describe, expect, it } from 'vitest';
import { mergeCurrentBranchFiles } from './scopes';

describe('mergeCurrentBranchFiles', () => {
  it('keeps branch statuses and adds working-tree-only files', () => {
    const files = mergeCurrentBranchFiles(
      [
        { path: 'src/committed.ts', status: 'modified', additions: 4 },
        { path: 'src/added-on-branch.ts', status: 'added' },
      ],
      [
        { path: 'src/committed.ts', status: 'modified', additions: 1 },
        { path: 'src/untracked.ts', status: 'added' },
      ],
    );

    expect(files).toEqual([
      { path: 'src/committed.ts', status: 'modified', additions: 4 },
      { path: 'src/added-on-branch.ts', status: 'added' },
      { path: 'src/untracked.ts', status: 'added' },
    ]);
  });
});