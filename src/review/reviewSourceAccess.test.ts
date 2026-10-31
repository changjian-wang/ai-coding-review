import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeRequirementSource, readRequirementLink, requirementSourceUrl } from './requirementSources';
import { repositoryEvidenceStamp, safeRepositoryUri } from './reviewSourceAccess';
import { decodeReviewText } from '../scope/gitClient';
import { CancellationTokenSource, resetVscodeMock, workspace } from '../test/vscodeMock';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  workspace.textDocuments.length = 0;
  resetVscodeMock();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const directory = await mkdtemp(path.join(tmpdir(), 'acr-source-'));
  roots.push(directory);
  return directory;
}

describe('bounded requirement source reads', () => {
  it('preserves original UTF-8 bytes while rejecting unsupported source formats', () => {
    expect(decodeRequirementSource('rules.md', Buffer.from('\ufeff# Rule\r\nKeep spacing.  \r\n'))).toBe('\ufeff# Rule\r\nKeep spacing.  \r\n');
    expect(() => decodeRequirementSource('rules.pdf', Buffer.from('text'))).toThrow();
    expect(() => decodeRequirementSource('rules.txt', Uint8Array.from([0xff, 0xff]))).toThrow();
    expect(() => decodeRequirementSource('rules.md', Buffer.from('text\0binary'))).toThrow();
  });
  it('rejects credentials, local endpoints and signed-token URLs', () => {
    for (const url of ['http://example.test/a', 'https://localhost/a', 'https://127.0.0.1/a', 'https://u:p@example.test/a', 'https://example.test/a?X-Amz-Signature=secret']) {
      expect(() => requirementSourceUrl(url)).toThrow();
    }
    expect(requirementSourceUrl('https://example.test/rules.md#section').href).toBe('https://example.test/rules.md');
  });
  it('does not send credentials or follow redirects when reading text links', async () => {
    const fetcher = vi.fn(async () => new Response('Keep one effect.\r\n', { headers: { 'content-type': 'text/markdown; charset=utf-8' } }));
    const cts = new CancellationTokenSource();
    const result = await readRequirementLink('https://example.test/rules.md', '/repo', cts.token, fetcher);
    expect(result.text).toBe('Keep one effect.\r\n');
    expect(fetcher).toHaveBeenCalledWith('https://example.test/rules.md', expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
    cts.dispose();
  });
  it('rejects HTML and oversized responses rather than treating partial content as requirements', async () => {
    const cts = new CancellationTokenSource();
    await expect(readRequirementLink('https://example.test/a', '/repo', cts.token, async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } }))).rejects.toThrow();
    await expect(readRequirementLink('https://example.test/a', '/repo', cts.token, async () => new Response('a'.repeat(256001), { headers: { 'content-type': 'text/plain' } }))).rejects.toThrow('materialTooLarge');
    cts.dispose();
  });
});

describe('actual source snapshot boundaries', () => {
  it('supports UTF-8 BOM and BOM-marked UTF-16 code without accepting binary controls', () => {
    expect(decodeReviewText(Buffer.from('\ufeffreturn value;\r\n'))).toBe('return value;\r\n');
    expect(decodeReviewText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('return value;', 'utf16le')]))).toBe('return value;');
    expect(() => decodeReviewText(Buffer.from('a\0b'))).toThrow();
  });
  it('rejects traversal and symlinks to files outside the selected folder', async () => {
    const directory = await root();
    const outside = await root();
    await writeFile(path.join(outside, 'private.ts'), 'private');
    await symlink(path.join(outside, 'private.ts'), path.join(directory, 'alias.ts'));
    await expect(safeRepositoryUri(directory, '../outside.ts')).rejects.toThrow();
    await expect(safeRepositoryUri(directory, 'alias.ts')).rejects.toThrow();
  });
  it('does not invalidate a live snapshot when an unchanged dirty buffer is merely saved', async () => {
    const directory = await root();
    await execute('git', ['init', '--initial-branch=main'], { cwd: directory });
    await writeFile(path.join(directory, 'source.ts'), 'before\n');
    await execute('git', ['add', 'source.ts'], { cwd: directory });
    await execute('git', ['-c', 'user.name=Review fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>'], { cwd: directory });
    const document = { uri: { fsPath: path.join(directory, 'source.ts'), scheme: 'file' }, isDirty: true, getText: () => 'after\n' };
    workspace.textDocuments.push(document);
    const before = await repositoryEvidenceStamp(directory, 'live');
    await writeFile(document.uri.fsPath, document.getText());
    document.isDirty = false;
    expect(await repositoryEvidenceStamp(directory, 'live')).toBe(before);
  });
  it('can fingerprint non-Git local source and detects actual changes', async () => {
    const directory = await root();
    await mkdir(path.join(directory, 'src'));
    await writeFile(path.join(directory, 'src/source.ts'), 'first\n');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const before = await repositoryEvidenceStamp(directory, 'live');
      await writeFile(path.join(directory, 'src/source.ts'), 'second\n');
      expect(await repositoryEvidenceStamp(directory, 'live')).not.toBe(before);
    } finally { warning.mockRestore(); }
  });
});
