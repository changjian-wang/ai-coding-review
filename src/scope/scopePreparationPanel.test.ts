import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScopePreparation, validatePreparedScope } from './scopePreparationPanel';
import { resetVscodeMock, vscodeMockState } from '../test/vscodeMock';
import { repositoryRoot, listReviewRefs, currentBranch, repositoryRemoteIdentity } from './gitClient';
import { listPrs, ensureAuth } from '../gh/ghClient';

vi.mock('./gitClient', () => ({ repositoryRoot: vi.fn(), listReviewRefs: vi.fn(), currentBranch: vi.fn(), repositoryRemoteIdentity: vi.fn() }));
vi.mock('../gh/ghClient', () => ({ ensureGhAvailable: vi.fn(), ensureAuth: vi.fn(), listPrs: vi.fn() }));

afterEach(() => { resetVscodeMock(); vi.clearAllMocks(); });
beforeEach(() => vi.mocked(repositoryRemoteIdentity).mockResolvedValue(undefined));

describe('preparation scope validation', () => {
  const data = {
    cwd: 'C:\\repo', refs: ['main', 'feature'], current: 'main',
    prs: [{ number: 42, title: 'PR', url: '', author: '', isDraft: false, state: 'OPEN', headRefName: 'feature',
      baseRefName: 'main', updatedAt: '', additions: 1, deletions: 0, changedFiles: 1 }],
  };
  it('requires a target actually loaded for the selected repository', () => {
    expect(validatePreparedScope(data, { cwd: data.cwd, kind: 'pr', prNumber: 42 })).toMatchObject({ kind: 'pr', prNumber: 42 });
    expect(() => validatePreparedScope(data, { cwd: 'C:\\other', kind: 'pr', prNumber: 42 })).toThrow(/selection/);
    expect(() => validatePreparedScope(data, { cwd: data.cwd, kind: 'pr', prNumber: 99 })).toThrow();
    expect(() => validatePreparedScope(undefined, { cwd: data.cwd, kind: 'branchFull' })).toThrow();
  });

  it('requires valid branch/base for changes and omits an irrelevant base for full snapshots', () => {
    expect(validatePreparedScope(data, { cwd: data.cwd, kind: 'branchChanges', headRef: 'feature', baseRef: 'main' }))
      .toEqual({ cwd: data.cwd, kind: 'branchChanges', headRef: 'feature', baseRef: 'main' });
    expect(validatePreparedScope(data, { cwd: data.cwd, kind: 'branchFull', headRef: 'feature', baseRef: 'old' }))
      .toEqual({ cwd: data.cwd, kind: 'branchFull', headRef: 'feature' });
    expect(() => validatePreparedScope(data, { cwd: data.cwd, kind: 'branchChanges', headRef: 'main', baseRef: 'main' })).toThrow(/same commit/);
    expect(() => validatePreparedScope(data, { cwd: data.cwd, kind: 'branchFull', headRef: '--help' })).toThrow();
    expect(() => validatePreparedScope(data, { cwd: data.cwd, kind: 'unknown' })).toThrow();
  });
});

describe('preparation host messaging', () => {
  it('loads real repository choices asynchronously and validates messages before finishing', async () => {
    const root = process.cwd();
    vi.mocked(repositoryRoot).mockResolvedValue(root);
    vi.mocked(listReviewRefs).mockResolvedValue(['main', 'feature']);
    vi.mocked(currentBranch).mockResolvedValue('main');
    const handle = createScopePreparation(root, undefined, 'branchChanges', {
      loadScope: async () => ({ scopeId: 'test', label: 'Feature', headSha: 'a'.repeat(40), files: [{ path: 'a.ts' }] }),
    });
    const panel = vscodeMockState.panel!;
    expect(panel.webview.html).toContain('nonce-');
    expect(panel.webview.html).toContain('acquireVsCodeApi()');
    panel.webview.receiveMessage({ type: 'ready' });
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual(expect.objectContaining({ type: 'repository' })));
    panel.webview.receiveMessage({ type: 'select', cwd: root, kind: 'branchChanges', headRef: 'feature', baseRef: 'main' });
    await expect(handle.result).resolves.toMatchObject({ cwd: root, kind: 'branchChanges', headRef: 'feature', baseRef: 'main' });
  });

  it('shows permission errors rather than converting failed PR loading into an empty success', async () => {
    const root = process.cwd();
    vi.mocked(repositoryRoot).mockResolvedValue(root);
    vi.mocked(listReviewRefs).mockResolvedValue(['main', 'feature']);
    vi.mocked(currentBranch).mockResolvedValue('main');
    vi.mocked(ensureAuth).mockRejectedValueOnce(new Error('Authentication unavailable'));
    const handle = createScopePreparation(root);
    const panel = vscodeMockState.panel!;
    panel.webview.receiveMessage({ type: 'ready' });
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual(expect.objectContaining({ type: 'repository' })));
    panel.webview.receiveMessage({ type: 'prs', cwd: root });
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual({ type: 'error', message: 'Authentication unavailable' }));
    expect(listPrs).not.toHaveBeenCalled();
    handle.dispose();
    await expect(handle.result).resolves.toBeUndefined();
    await expect(handle.ready).resolves.toBe(false);
  });

  it('preserves explicit local-file review when Git metadata cannot be loaded', async () => {
    const root = process.cwd();
    vi.mocked(repositoryRoot).mockRejectedValueOnce(new Error('Not a Git repository'));
    const handle = createScopePreparation(root);
    const panel = vscodeMockState.panel!;
    panel.webview.receiveMessage({ type: 'ready' });
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual({ type: 'error', message: 'Not a Git repository' }));
    panel.webview.receiveMessage({ type: 'select', cwd: root, kind: 'files' });
    await expect(handle.result).resolves.toMatchObject({ kind: 'files' });
  });

  it('discards a late PR error when a newer repository load is already active', async () => {
    const root = process.cwd();
    vi.mocked(repositoryRoot).mockResolvedValue(root);
    vi.mocked(listReviewRefs).mockResolvedValue(['main', 'feature']);
    vi.mocked(currentBranch).mockResolvedValue('main');
    vi.mocked(ensureAuth).mockResolvedValue(undefined);
    let fail!: (error: Error) => void;
    vi.mocked(listPrs).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const handle = createScopePreparation(root);
    const panel = vscodeMockState.panel!;
    panel.webview.receiveMessage({ type: 'ready' });
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual(expect.objectContaining({ type: 'repository' })));
    panel.webview.receiveMessage({ type: 'prs', cwd: root });
    await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
    panel.webview.receiveMessage({ type: 'repository', cwd: root });
    await vi.waitFor(() => expect(panel.webview.messages.filter((message) => (message as { type: string }).type === 'repository')).toHaveLength(2));
    fail(new Error('Late authentication failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(panel.webview.messages).not.toContainEqual({ type: 'error', message: 'Late authentication failure' });
    handle.dispose();
    await handle.result;
  });
});
