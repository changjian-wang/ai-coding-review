import { afterEach, describe, expect, it, vi } from 'vitest';
import { readGitHubRequirement } from './ghClient';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => execute }));
afterEach(() => execute.mockReset());

describe('authorized GitHub requirement sources', () => {
  it.each(['issues', 'pull'])('reads an explicitly supplied %s body through gh instead of browser cookies', async (kind) => {
    execute.mockResolvedValue({ stdout: JSON.stringify({ title: 'Acceptance criteria', body: '# Rule\n\nCharge once.' }) });
    const result = await readGitHubRequirement(process.cwd(), new URL(`https://github.com/owner/repo/${kind}/42`));
    expect(result).toEqual({ name: 'Acceptance criteria', text: '# Rule\n\nCharge once.' });
    expect(execute.mock.calls[0][1]).toContain(`repos/owner/repo/${kind === 'pull' ? 'pulls' : 'issues'}/42`);
    expect(execute.mock.calls[0][1]).toEqual(expect.arrayContaining(['--hostname', 'github.com']));
  });

  it('reads a Markdown blob with explicit GET and ref, preserving raw text', async () => {
    execute.mockResolvedValue({ stdout: '\n# Original\n\n**Keep whitespace**\n' });
    expect(await readGitHubRequirement(process.cwd(), new URL('https://github.com/owner/repo/blob/main/docs/requirements.md')))
      .toMatchObject({ name: 'requirements.md', text: '\n# Original\n\n**Keep whitespace**\n' });
    expect(execute.mock.calls[0][1]).toEqual(expect.arrayContaining(['-X', 'GET', '-f', 'ref=main']));
  });

  it('does not treat authorization failure, unsupported paths or non-text output as empty success', async () => {
    execute.mockRejectedValueOnce(new Error('HTTP 403'));
    await expect(readGitHubRequirement(process.cwd(), new URL('https://github.com/owner/repo/issues/42'))).rejects.toThrow(/403/);
    execute.mockClear();
    await expect(readGitHubRequirement(process.cwd(), new URL('https://github.com/owner/repo/wiki/Requirements'))).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    execute.mockResolvedValueOnce({ stdout: JSON.stringify({ title: 'No body' }) });
    await expect(readGitHubRequirement(process.cwd(), new URL('https://github.com/owner/repo/issues/42'))).rejects.toThrow(/supported/);
  });
});
