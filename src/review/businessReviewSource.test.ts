import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BusinessReviewSource } from './businessReviewSource';
import { businessBaseline, businessHash, createBusinessRun } from './businessReview';
import { addRequirementMaterial, createRequirementsDraft } from './requirements';
import { readRequirementFile } from './requirementSources';
import { readSnapshotFile, resolveCommit } from '../scope/gitClient';
import type { ReviewSet } from '../scope/types';
import { resetVscodeMock, Uri, workspace as mockWorkspace } from '../test/vscodeMock';

vi.mock('../scope/gitClient', async (original) => ({
  ...await original<typeof import('../scope/gitClient')>(), readSnapshotFile: vi.fn(), resolveCommit: vi.fn(),
}));

const temporaryRoots: string[] = [];
async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codereview-business-source-'));
  temporaryRoots.push(root);
  return root;
}

beforeEach(() => {
  vi.mocked(resolveCommit).mockImplementation(async (_cwd, ref) => ref === 'feature' ? 'a'.repeat(40) : 'b'.repeat(40));
  vi.mocked(readSnapshotFile).mockImplementation(async (_cwd, sha, file) => `// ${sha}: ${file}\n`);
});
afterEach(async () => {
  resetVscodeMock();
  vi.clearAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function set(): ReviewSet {
  return {
    scopeId: 'branch-feature', label: 'Feature', headSha: 'a'.repeat(40), files: [{ path: 'code.ts' }],
    source: { kind: 'commit', headRef: 'feature', baseRef: 'main', baseTipSha: 'b'.repeat(40) },
    comparison: { baseSha: 'c'.repeat(40), headSha: 'a'.repeat(40) },
  };
}

describe('business review exact-source and freshness adapter', () => {
  it('uses selected Git objects for head/base but still rejects a moved branch with perfectly readable old objects', async () => {
    const scope = set();
    const source = new BusinessReviewSource(path.resolve('fixture'), scope);
    expect(await source.read('code.ts', 'head')).toContain(scope.headSha);
    expect(await source.read('old.ts', 'base')).toContain(scope.comparison!.baseSha);
    await source.assertCurrent();
    vi.mocked(resolveCommit).mockResolvedValue('d'.repeat(40));
    await expect(source.assertCurrent()).rejects.toThrow(/changed/);
    expect(await source.read('code.ts', 'head')).toContain(scope.headSha);
    expect(readSnapshotFile).toHaveBeenCalledTimes(2);
  });

  it('captures working-tree inputs once, then compares fresh contents instead of mistaking its cache for proof', async () => {
    const root = await directory();
    await writeFile(path.join(root, 'code.ts'), 'export const value = 1;\n');
    const scope: ReviewSet = { scopeId: 'local', label: 'Local', headSha: 'live', files: [{ path: 'code.ts' }] };
    const source = new BusinessReviewSource(root, scope);
    const first = await source.read('code.ts', 'head');
    const run = createBusinessRun(businessBaseline(root, scope), 'model');
    run.dependencies['head:code.ts'] = businessHash(first);
    await source.assertCurrent(undefined, run);
    await writeFile(path.join(root, 'code.ts'), 'export const value = 2;\n');
    expect(await source.read('code.ts', 'head')).toBe(first);
    expect(await source.readFresh('code.ts', 'head')).not.toBe(first);
    await expect(source.assertCurrent(undefined, run)).rejects.toThrow(/changed/);
  });

  it('includes unsaved source text, and refuses changed or unsaved requirement files until they are re-read and confirmed', async () => {
    const root = await directory();
    const code = path.join(root, 'code.ts');
    const material = path.join(root, 'rule.md');
    await writeFile(code, 'saved\n');
    await writeFile(material, 'Original requirement.\n');
    mockWorkspace.textDocuments.push({ uri: Uri.file(code), isDirty: true, getText: () => 'unsaved source\n' });
    const scope: ReviewSet = { scopeId: 'local', label: 'Local', headSha: 'live', files: [{ path: 'code.ts' }] };
    const source = new BusinessReviewSource(root, scope);
    expect(await source.read('code.ts', 'head')).toBe('unsaved source\n');
    const draft = createRequirementsDraft();
    addRequirementMaterial(draft, await readRequirementFile(material));
    await source.assertCurrent(draft);
    mockWorkspace.textDocuments.push({ uri: Uri.file(material), isDirty: true, getText: () => 'Unsaved requirement change.\n' });
    await expect(source.assertCurrent(draft)).rejects.toThrow(/Material changed/);
    mockWorkspace.textDocuments.pop();
    await writeFile(material, 'Saved new requirement.\n');
    await expect(source.assertCurrent(draft)).rejects.toThrow(/Material changed/);
    expect(draft.materials[0].versions[0].text).toBe('Original requirement.\n');
  });

  it('rejects invalid UTF-8, binary contents and paths escaping the selected repository', async () => {
    const root = await directory();
    const external = await directory();
    await writeFile(path.join(root, 'bad.ts'), Buffer.from([0xc3, 0x28]));
    await writeFile(path.join(root, 'binary.ts'), 'hello\0world');
    await writeFile(path.join(external, 'private.ts'), 'outside fixture\n');
    await symlink(external, path.join(root, 'linked'), 'junction');
    const scope: ReviewSet = { scopeId: 'local', label: 'Local', headSha: 'live', files: [{ path: 'bad.ts' }] };
    const source = new BusinessReviewSource(root, scope);
    await expect(source.readFresh('bad.ts', 'head')).rejects.toThrow();
    await expect(source.readFresh('binary.ts', 'head')).rejects.toThrow(/could not be read/);
    await expect(source.readFresh('linked/private.ts', 'head')).rejects.toThrow(/could not be read/);
    await expect(source.readFresh('../outside.ts', 'head')).rejects.toThrow();
    expect(await readFile(path.join(external, 'private.ts'), 'utf8')).toBe('outside fixture\n');
  });
});
