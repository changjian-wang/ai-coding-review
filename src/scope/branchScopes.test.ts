import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BranchSnapshotScope } from './scopes';
import { headSha, readSnapshotFile, reviewCommentRanges } from './gitClient';

const execute = promisify(execFile);
let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });
async function fixture() {
  directory = await mkdtemp(path.join(tmpdir(), 'acr-branch-'));
  const git = async (...args: string[]) => (await execute('git', args, { cwd: directory })).stdout.trim();
  await git('init', '--initial-branch=main');
  await mkdir(path.join(directory, 'src'));
  await writeFile(path.join(directory, 'src/用户.ts'), 'export const original = 1;\n');
  await writeFile(path.join(directory, 'src/untouched.ts'), 'export const untouched = 1;\n');
  const commit = async () => {
    await git('add', '-A');
    await git('-c', 'user.name=Review fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>');
  };
  await commit();
  await git('switch', '-c', 'feature');
  return { directory, git, commit };
}
describe('real immutable branch scopes', () => {
  it('preserves Unicode and tab-containing paths and rename metadata without checking out or stashing', async () => {
    const { directory, git, commit } = await fixture();
    await rename(path.join(directory, 'src/用户.ts'), path.join(directory, 'src/renamed.ts'));
    await writeFile(path.join(directory, 'src/a\tb.ts'), 'export const added = 1;\n');
    await commit();
    await writeFile(path.join(directory, 'local.txt'), 'Keep this local change.');
    const scope = await new BranchSnapshotScope('feature', 'main').load(directory);
    expect(scope.files).toContainEqual(expect.objectContaining({ path: 'src/renamed.ts', previousPath: 'src/用户.ts', status: 'renamed' }));
    expect(scope.files).toContainEqual(expect.objectContaining({ path: 'src/a\tb.ts', status: 'added' }));
    expect(await git('branch', '--show-current')).toBe('feature');
    expect(await git('stash', 'list')).toBe('');
    expect(await readSnapshotFile(directory, scope.comparison!.baseSha, 'src/用户.ts')).toContain('original');
    expect((await new BranchSnapshotScope('feature').load(directory)).files.map((file) => file.path)).toContain('src/untouched.ts');
    expect((await new BranchSnapshotScope('feature').load(directory)).files.map((file) => file.path)).not.toContain('local.txt');
  });
  it('locates real GitHub-compatible diff ranges rather than commenting on arbitrary full-file lines', async () => {
    const { directory, commit } = await fixture();
    await writeFile(path.join(directory, 'src/untouched.ts'), Array.from({ length: 30 }, (_, index) => `const value${index} = ${index};`).join('\n') + '\n');
    await commit();
    const base = await headSha(directory);
    const file = path.join(directory, 'src/untouched.ts');
    const content = Array.from({ length: 30 }, (_, index) => `const value${index} = ${index === 15 ? 99 : index};`).join('\n') + '\n';
    await writeFile(file, content);
    await commit();
    const ranges = await reviewCommentRanges(directory, base, await headSha(directory), { path: 'src/untouched.ts' });
    expect(ranges.some((range) => range.start <= 16 && range.end >= 16)).toBe(true);
    expect(ranges.some((range) => range.start <= 1 && range.end >= 1)).toBe(false);
  });
});
