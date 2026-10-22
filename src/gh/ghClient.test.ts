import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { getPrByNumber, submitPrReviewWithComments } from './ghClient';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => execute }));

afterEach(() => execute.mockReset());

describe('explicit PR snapshot publication targets', () => {
  const target = { host: 'github.com', nameWithOwner: 'owner/repo' };

  it('refreshes the selected PR using an explicit repository rather than the current origin', async () => {
    execute.mockResolvedValue({ stdout: JSON.stringify({
      number: 42, title: 'Pinned PR', url: 'https://github.com/owner/repo/pull/42',
      headRefName: 'feature', baseRefName: 'main', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40), files: [],
    }) });
    await getPrByNumber(process.cwd(), 42, target);
    expect(execute.mock.calls[0][1]).toEqual(expect.arrayContaining(['--repo', 'github.com/owner/repo']));
  });

  it('posts against the selected repository and commit even with no line comments', async () => {
    let payload: Record<string, unknown> | undefined;
    execute.mockImplementation(async (_command: string, args: string[]) => {
      expect(args).toContain('repos/owner/repo/pulls/42/reviews');
      expect(args).toEqual(expect.arrayContaining(['--hostname', 'github.com']));
      const file = args[args.indexOf('--input') + 1];
      payload = JSON.parse(await readFile(file, 'utf8'));
      return { stdout: '{}' };
    });
    await submitPrReviewWithComments(process.cwd(), 42, 'a'.repeat(40), 'comment', 'Reviewed selected commit', [], target);
    expect(payload).toMatchObject({ commit_id: 'a'.repeat(40), event: 'COMMENT', comments: [] });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid explicit targets instead of falling back to the current repository', async () => {
    await expect(getPrByNumber(process.cwd(), 42, { host: 'github.com', nameWithOwner: '' })).rejects.toThrow();
    await expect(submitPrReviewWithComments(process.cwd(), 42, 'a'.repeat(40), 'comment', '', [], { host: 'example.com', nameWithOwner: 'owner/repo' })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});
