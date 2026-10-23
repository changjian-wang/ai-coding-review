import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createScopePreparation, validatePreparedScope } from './scopePreparationPanel';
import { resetVscodeMock, vscodeMockState } from '../test/vscodeMock';
import { repositoryRoot, listReviewRefs, currentBranch, repositoryRemoteIdentity } from './gitClient';
import { listPrs, ensureAuth } from '../gh/ghClient';
import { m } from '../i18n';
import type { PrSummary } from '../gh/types';

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
  it('uses the supplied workbench panel directly and retains it for handoff only after confirmation', async () => {
    const root = process.cwd();
    vi.mocked(repositoryRoot).mockResolvedValue(root);
    vi.mocked(listReviewRefs).mockResolvedValue(['main', 'feature']);
    vi.mocked(currentBranch).mockResolvedValue('main');
    const hostPanel = vscode.window.createWebviewPanel('codereview.workbench', 'Preparation', vscode.ViewColumn.One, { enableScripts: true });
    const panel = vscodeMockState.panel!;
    const disposed = vi.fn();
    panel.onDidDispose(disposed);
    const handle = createScopePreparation(root, undefined, 'branchChanges', {
      hostPanel, retainOnSelect: true,
      loadScope: async () => ({ scopeId: 'test', label: 'Feature', headSha: 'a'.repeat(40), files: [{ path: 'a.ts' }] }),
    });
    expect(vscodeMockState.panel).toBe(panel);
    expect(panel.title).toBe(m().scope.prepareTitle);
    expect(panel.webview.options).toMatchObject({ enableScripts: true });
    expect(panel.webview.html).toContain(m().scope.prepareTitle);
    expect(panel.webview.html).not.toContain('Loading AI Coding Review');
    panel.webview.receiveMessage({ type: 'ready' });
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual(expect.objectContaining({ type: 'repository' })));
    panel.webview.receiveMessage({ type: 'select', cwd: root, kind: 'branchChanges', headRef: 'feature', baseRef: 'main', confirmed: true });
    await expect(handle.result).resolves.toMatchObject({ kind: 'branchChanges', reviewSet: { headSha: 'a'.repeat(40) } });
    expect(disposed).not.toHaveBeenCalled();
    const count = panel.webview.messages.length;
    const loads = vi.mocked(repositoryRoot).mock.calls.length;
    panel.webview.receiveMessage({ type: 'ready' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repositoryRoot).toHaveBeenCalledTimes(loads);
    expect(panel.webview.messages).toHaveLength(count);
    handle.dispose();
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it('still closes a retained preparation panel on cancellation without resolving a scope', async () => {
    const hostPanel = vscode.window.createWebviewPanel('codereview.workbench', 'Preparation', vscode.ViewColumn.One, { enableScripts: true });
    const panel = vscodeMockState.panel!;
    const disposed = vi.fn();
    panel.onDidDispose(disposed);
    const handle = createScopePreparation(process.cwd(), undefined, 'pr', { hostPanel, retainOnSelect: true });
    panel.webview.receiveMessage({ type: 'cancel' });
    await expect(handle.result).resolves.toBeUndefined();
    expect(disposed).toHaveBeenCalledTimes(1);
  });

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
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual(expect.objectContaining({ type: 'error', target: 'prs', message: 'Authentication unavailable' })));
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
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual({ type: 'error', target: 'repository', message: 'Not a Git repository' }));
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
    expect(panel.webview.messages).not.toContainEqual(expect.objectContaining({ type: 'error', message: 'Late authentication failure' }));
    handle.dispose();
    await handle.result;
  });

  it('selects a browsed existing repository without opening a workspace or changing branches', async () => {
    const root = process.cwd();
    vi.mocked(repositoryRoot).mockResolvedValue(root);
    vi.mocked(listReviewRefs).mockResolvedValue(['main', 'feature']);
    vi.mocked(currentBranch).mockResolvedValue('main');
    const handle = createScopePreparation(root);
    const panel = vscodeMockState.panel!;
    panel.webview.receiveMessage({ type: 'ready' });
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual(expect.objectContaining({ type: 'repository' })));
    const chosen = `${root}\\src`;
    vscodeMockState.openDialog = async () => [{ fsPath: chosen }];
    panel.webview.receiveMessage({ type: 'browse' });
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual(expect.objectContaining({ type: 'repository', selected: chosen })));
    expect(repositoryRoot).toHaveBeenLastCalledWith(chosen);
    handle.dispose();
  });

  it('does not reload or replace the current preparation when browsing is cancelled', async () => {
    const root = process.cwd();
    vi.mocked(repositoryRoot).mockResolvedValue(root);
    vi.mocked(listReviewRefs).mockResolvedValue(['main', 'feature']);
    vi.mocked(currentBranch).mockResolvedValue('main');
    const handle = createScopePreparation(root);
    const panel = vscodeMockState.panel!;
    panel.webview.receiveMessage({ type: 'ready' });
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual(expect.objectContaining({ type: 'repository' })));
    const count = vi.mocked(repositoryRoot).mock.calls.length;
    vscodeMockState.openDialog = async () => undefined;
    panel.webview.receiveMessage({ type: 'browse' });
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual({ type: 'repositoryBrowse', pending: false }));
    expect(repositoryRoot).toHaveBeenCalledTimes(count);
    expect(panel.webview.messages.filter((message) => (message as { type: string }).type === 'repository')).toHaveLength(1);
    handle.dispose();
  });
});

describe('PR list request ownership', () => {
  const root = process.cwd();
  const pr: PrSummary = {
    number: 42, title: 'Review target', url: '', author: '', isDraft: false, state: 'OPEN',
    headRefName: 'feature', baseRefName: 'main', updatedAt: '', additions: 1, deletions: 0, changedFiles: 1,
  };
  beforeEach(() => {
    vi.mocked(repositoryRoot).mockResolvedValue(root);
    vi.mocked(listReviewRefs).mockResolvedValue(['main', 'feature']);
    vi.mocked(currentBranch).mockResolvedValue('main');
  });
  async function open(loadPrs: (cwd: string) => Promise<PrSummary[]>, loadScope = vi.fn(async () => ({
    scopeId: 'pr-42', label: 'PR', headSha: 'a'.repeat(40), files: [{ path: 'a.ts' }],
  }))) {
    const handle = createScopePreparation(root, undefined, 'pr', { loadPrs, loadScope });
    const panel = vscodeMockState.panel!;
    panel.webview.receiveMessage({ type: 'ready' });
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual(expect.objectContaining({ type: 'repository' })));
    return { handle, panel, loadScope };
  }

  it('accepts only the latest same-repository list request instead of overwriting it with a slow earlier response', async () => {
    const finish: Array<(items: PrSummary[]) => void> = [];
    const { handle, panel } = await open(() => new Promise((resolve) => finish.push(resolve)));
    panel.webview.receiveMessage({ type: 'prs', cwd: root, requestId: 1 });
    panel.webview.receiveMessage({ type: 'prs', cwd: root, requestId: 2 });
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    finish[1]([pr]);
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual(expect.objectContaining({ type: 'prs', requestId: 2 })));
    finish[0]([{ ...pr, number: 99 }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(panel.webview.messages).not.toContainEqual(expect.objectContaining({ type: 'prs', requestId: 1 }));
    handle.dispose();
  });

  it('does not use retained PR choices for confirmation while refreshing or after refresh failure', async () => {
    let reject!: (reason: Error) => void;
    let calls = 0;
    const { handle, panel, loadScope } = await open(async () => ++calls === 1 ? [pr] : new Promise((_resolve, fail) => { reject = fail; }));
    panel.webview.receiveMessage({ type: 'prs', cwd: root, requestId: 1 });
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual(expect.objectContaining({ type: 'prs', requestId: 1 })));
    panel.webview.receiveMessage({ type: 'selection', cwd: root, kind: 'pr', prNumber: 42 });
    await vi.waitFor(() => expect(loadScope).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual(expect.objectContaining({ type: 'requirements', state: expect.objectContaining({ scopeReady: true }) })));
    panel.webview.receiveMessage({ type: 'prs', cwd: root, requestId: 2 });
    panel.webview.receiveMessage({ type: 'select', cwd: root, kind: 'pr', prNumber: 42, confirmed: true });
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual(expect.objectContaining({ type: 'error', target: 'scope' })));
    expect(loadScope).toHaveBeenCalledTimes(1);
    reject(new Error('Network unavailable'));
    await vi.waitFor(() => expect(panel.webview.messages).toContainEqual(expect.objectContaining({ type: 'error', target: 'prs', requestId: 2 })));
    panel.webview.receiveMessage({ type: 'select', cwd: root, kind: 'pr', prNumber: 42, confirmed: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loadScope).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('ignores the late PR list when the user changes to a branch while the list is loading', async () => {
    let finish!: (items: PrSummary[]) => void;
    const { handle, panel } = await open(() => new Promise((resolve) => { finish = resolve; }));
    panel.webview.receiveMessage({ type: 'prs', cwd: root, requestId: 1 });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    panel.webview.receiveMessage({ type: 'selection', cwd: root, kind: 'branchFull', headRef: 'feature' });
    finish([pr]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(panel.webview.messages).not.toContainEqual(expect.objectContaining({ type: 'prs', requestId: 1 }));
    handle.dispose();
  });
});
