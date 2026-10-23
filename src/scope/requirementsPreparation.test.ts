import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScopePreparation, type ScopePreparationOptions } from './scopePreparationPanel';
import { currentBranch, listReviewRefs, repositoryRemoteIdentity, repositoryRoot } from './gitClient';
import { resetVscodeMock, vscodeMockState } from '../test/vscodeMock';
import { currentMaterial, parseRequirementUnderstanding, requirementReadiness, requirementScopeKey, type RequirementPreparationRecord, type RequirementsDraft } from '../review/requirements';
import type { ReviewSet } from './types';

vi.mock('./gitClient', () => ({ currentBranch: vi.fn(), listReviewRefs: vi.fn(), repositoryRemoteIdentity: vi.fn(), repositoryRoot: vi.fn() }));
vi.mock('../gh/ghClient', () => ({ ensureAuth: vi.fn(), ensureGhAvailable: vi.fn(), listPrs: vi.fn() }));

const root = process.cwd();
const selection = { cwd: root, kind: 'branchChanges', headRef: 'feature', baseRef: 'main' };
const set: ReviewSet = { scopeId: 'branch-feature', label: 'Feature vs main', headSha: 'a'.repeat(40), files: [{ path: 'a.ts' }], source: { kind: 'commit', headRef: 'feature', baseRef: 'main' } };

function understood(draft: RequirementsDraft, key: string) {
  const source = draft.materials.find((source) => source.selected)!;
  const original = currentMaterial(source);
  return parseRequirementUnderstanding({
    summary: '**Preserve charge consistency.**',
    requirements: [{ id: 'RQ-1', title: 'Charge once', text: 'Charge once.', origins: [{
      sourceId: source.id, version: original.version, line: 1, endLine: 1, quote: original.text.split(/\r?\n/)[0],
    }] }],
    checks: [{ id: 'CK-1', text: 'Check retry interactions.', requirementIds: ['RQ-1'] }], questions: [],
  }, draft, key, 'controlled-test-model');
}

interface ClientState {
  revision: number; ready: boolean; busy: boolean; reading: boolean; error: string; html: string;
  scopeLoading: boolean; scopeReady: boolean; scopeError: string;
  materials: { id: string; name: string; selected: boolean; version: number }[];
}

function state(): ClientState | undefined {
  const messages = vscodeMockState.panel!.webview.messages as { type: string; state?: ClientState }[];
  return [...messages].reverse().find((message) => message.type === 'requirements')?.state;
}

async function open(extra: ScopePreparationOptions = {}) {
  const saved: RequirementPreparationRecord[] = [];
  const handle = createScopePreparation(root, undefined, 'branchChanges', {
    loadScope: async () => structuredClone(set),
    save: async (_cwd, _identity, record) => { saved.push(structuredClone(record)); },
    analyze: async (draft, scope) => understood(draft, scope.key),
    ...extra,
  });
  const panel = vscodeMockState.panel!;
  panel.webview.receiveMessage({ type: 'ready' });
  await vi.waitFor(() => expect(panel.webview.messages).toContainEqual(expect.objectContaining({ type: 'repository' })));
  return { handle, panel, saved };
}

beforeEach(() => {
  vi.mocked(repositoryRoot).mockResolvedValue(root);
  vi.mocked(listReviewRefs).mockResolvedValue(['main', 'feature']);
  vi.mocked(currentBranch).mockResolvedValue('main');
  vi.mocked(repositoryRemoteIdentity).mockResolvedValue(undefined);
});
afterEach(() => { resetVscodeMock(); vi.clearAllMocks(); });

describe('three-block preparation with real host state transitions', () => {
  it('retains materials while the PR choice is missing without calling the model or reporting a fake scope error', async () => {
    const analyze = vi.fn(async (draft: RequirementsDraft, scope: { key: string }) => understood(draft, scope.key));
    const { handle, panel, saved } = await open({ analyze });
    panel.webview.receiveMessage({ type: 'material', cwd: root, kind: 'pr', prNumber: 0, name: 'While waiting', text: 'Charge once.' });
    await vi.waitFor(() => expect(state()?.materials).toHaveLength(1));
    expect(saved.at(-1)?.draft.materials[0].versions[0].text).toBe('Charge once.');
    expect(state()?.error).toBe('');
    expect(state()?.scopeError).toBe('');
    expect(analyze).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('reports source reading separately from actual AI work and keeps newly added material during the pending read', async () => {
    let read!: (scope: ReviewSet) => void;
    const pendingScope = new Promise<ReviewSet>((resolve) => { read = resolve; });
    let finishModel!: () => void;
    const { handle, panel, saved } = await open({
      loadScope: async () => pendingScope,
      analyze: (draft, scope) => new Promise((resolve) => { finishModel = () => resolve(understood(draft, scope.key)); }),
    });
    panel.webview.receiveMessage({ type: 'selection', ...selection });
    await vi.waitFor(() => expect(state()).toMatchObject({ scopeLoading: true, busy: false }));
    panel.webview.receiveMessage({ type: 'material', ...selection, name: 'While source loads', text: 'Charge once.' });
    await vi.waitFor(() => expect(saved.at(-1)?.draft.materials).toHaveLength(1));
    expect(state()?.busy).toBe(false);
    read(structuredClone(set));
    await vi.waitFor(() => expect(state()).toMatchObject({ scopeLoading: false, busy: true }));
    finishModel();
    await vi.waitFor(() => expect(state()).toMatchObject({ ready: true, scopeReady: true, busy: false }));
    expect(state()?.materials[0].name).toBe('While source loads');
    handle.dispose();
  });

  it('surfaces scope I/O failures in the target card without claiming an AI-understanding failure', async () => {
    const analyze = vi.fn();
    const { handle, panel } = await open({ loadScope: async () => { throw new Error('Missing source object'); }, analyze });
    panel.webview.receiveMessage({ type: 'selection', ...selection });
    await vi.waitFor(() => expect(state()?.scopeError).toBe('Missing source object'));
    expect(state()).toMatchObject({ scopeLoading: false, scopeReady: false, busy: false, error: '' });
    expect(analyze).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('reports an invalid identical branch/base explicitly when clearing the old selected scope', async () => {
    const { handle, panel } = await open();
    panel.webview.receiveMessage({ type: 'clearSelection', ...selection, headRef: 'main', baseRef: 'main' });
    await vi.waitFor(() => expect(state()?.scopeError).toContain('same commit'));
    expect(state()).toMatchObject({ scopeReady: false, scopeLoading: false, busy: false, error: '' });
    handle.dispose();
  });

  it('switches the preparation language without reloading the repository or losing selected material and understanding', async () => {
    const { handle, panel } = await open({
      pickLanguage: async () => { vscodeMockState.language = 'zh-CN'; },
    });
    panel.webview.receiveMessage({ type: 'material', ...selection, name: 'Original contract', text: 'Charge once.' });
    await vi.waitFor(() => expect(state()?.ready).toBe(true));
    const previous = state()!;
    const loads = vi.mocked(repositoryRoot).mock.calls.length;
    panel.webview.receiveMessage({ type: 'language' });
    await vi.waitFor(() => expect(panel.webview.html).toContain('<html lang="zh-CN">'));
    panel.webview.receiveMessage({ type: 'ready' });
    await vi.waitFor(() => expect(state()?.materials).toEqual(previous.materials));
    expect(state()?.ready).toBe(true);
    expect(state()?.html).toContain('Charge once.');
    expect(repositoryRoot).toHaveBeenCalledTimes(loads);
    expect(panel.webview.messages).toContainEqual(expect.objectContaining({
      type: 'repository', selection: expect.objectContaining({ headRef: 'feature', baseRef: 'main' }),
    }));
    handle.dispose();
  });

  it('saves material, organizes through the model adapter, and needs one explicit confirmation for the pinned scope', async () => {
    const { handle, panel, saved } = await open();
    const script = panel.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    expect(() => new Function('acquireVsCodeApi', script ?? '')).not.toThrow();
    expect(panel.webview.html.match(/<section class="review-card">/g)).toHaveLength(3);
    panel.webview.receiveMessage({ type: 'material', ...selection, name: 'Goal', text: 'Charge once.' });
    await vi.waitFor(() => expect(state()).toMatchObject({ ready: true, busy: false }));
    expect(state()?.html).toContain('<strong>Preserve charge consistency.</strong>');
    expect(saved.at(-1)?.draft.confirmation).toBeUndefined();
    panel.webview.receiveMessage({ type: 'select', ...selection, confirmed: false });
    await vi.waitFor(() => expect(state()?.scopeError).toMatch(/Explicitly confirm/));
    panel.webview.receiveMessage({ type: 'select', ...selection, confirmed: true });
    const result = await handle.result;
    expect(result?.reviewSet?.headSha).toBe(set.headSha);
    expect(result?.requirements?.confirmation?.scopeKey).toBe(requirementScopeKey(root, set));
    expect(result?.requirements?.materials).toHaveLength(1);
  });

  it('keeps original text and human revisions distinct, then invalidates confirmation on version changes', async () => {
    const { handle, panel, saved } = await open();
    panel.webview.receiveMessage({ type: 'material', ...selection, name: 'Original', text: 'Charge once.' });
    await vi.waitFor(() => expect(state()?.ready).toBe(true));
    panel.webview.receiveMessage({ type: 'revise', id: 'RQ-1', revision: state()!.revision, name: 'Refined title', text: '**Only once across retries**', included: true, reason: '' });
    await vi.waitFor(() => expect(state()?.html).toContain('<strong>Only once across retries</strong>'));
    expect(saved.at(-1)?.draft.materials[0].versions[0].text).toBe('Charge once.');
    expect(saved.at(-1)?.draft.understanding?.requirements[0].basis).toBe('human');
    const id = state()!.materials[0].id;
    panel.webview.receiveMessage({ type: 'material', ...selection, id, text: 'New source rule.' });
    await vi.waitFor(() => expect(state()?.materials[0].version).toBe(2));
    expect(saved.at(-1)?.draft.materials[0].versions[0].text).toBe('Charge once.');
    handle.dispose();
  });

  it('preserves material on model failure, and only an explicit technical-only action bypasses missing understanding', async () => {
    const { handle, panel, saved } = await open({ analyze: async () => { throw new Error('Model permission denied'); } });
    panel.webview.receiveMessage({ type: 'material', ...selection, name: 'Rule', text: 'Charge once.' });
    await vi.waitFor(() => expect(state()?.error).toContain('Model permission denied'));
    expect(state()?.ready).toBe(false);
    expect(saved.at(-1)?.draft.materials[0].versions[0].text).toBe('Charge once.');
    panel.webview.receiveMessage({ type: 'select', ...selection, confirmed: true });
    await vi.waitFor(() => expect(state()?.scopeError).toContain('changed'));
    panel.webview.receiveMessage({ type: 'select', ...selection, technicalOnly: true });
    const result = await handle.result;
    expect(result?.requirements?.confirmation).toBeUndefined();
    expect(result?.requirements?.technicalOnly).toBe(true);
    expect(result?.requirements?.history.at(-1)?.action).toContain('Technical-only');
  });

  it('does not confirm understanding against a newer commit which arrived after analysis', async () => {
    let currentSet = structuredClone(set);
    const { handle, panel } = await open({ loadScope: async () => structuredClone(currentSet) });
    panel.webview.receiveMessage({ type: 'material', ...selection, name: 'Rule', text: 'Charge once.' });
    await vi.waitFor(() => expect(state()?.ready).toBe(true));
    currentSet = { ...set, headSha: 'b'.repeat(40) };
    panel.webview.receiveMessage({ type: 'select', ...selection, confirmed: true });
    await vi.waitFor(() => expect(state()?.scopeError).toContain('code version changed'));
    expect(state()?.ready).toBe(false);
    handle.dispose();
  });

  it('discards a late model result after a material selection change', async () => {
    let finish!: () => void;
    const { handle, panel, saved } = await open({
      analyze: (draft, scope) => new Promise((resolve) => { finish = () => resolve(understood(draft, scope.key)); }),
    });
    panel.webview.receiveMessage({ type: 'material', ...selection, name: 'Rule', text: 'Charge once.' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const id = state()!.materials[0].id;
    panel.webview.receiveMessage({ type: 'include', ...selection, id, selected: false });
    await vi.waitFor(() => expect(state()?.materials[0].selected).toBe(false));
    finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(saved.at(-1)?.draft.understanding).toBeUndefined();
    expect(state()?.html).not.toContain('RQ-1');
    handle.dispose();
  });

  it('reads a user-selected local file without upload, preserves its original, and shares the understanding workflow', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'codereview-m2-'));
    const file = join(folder, 'requirements.md');
    try {
      await writeFile(file, 'Charge once.\r\n\r\n**Markdown**\r\n');
      const { handle, panel, saved } = await open();
      vscodeMockState.openDialog = async () => [{ fsPath: file }];
      panel.webview.receiveMessage({ type: 'file', ...selection });
      await vi.waitFor(() => expect(state()?.ready).toBe(true));
      expect(saved.at(-1)?.draft.materials[0]).toMatchObject({ kind: 'file', location: file });
      expect(saved.at(-1)?.draft.materials[0].versions[0].text).toBe('Charge once.\r\n\r\n**Markdown**\r\n');
      handle.dispose();
    } finally { await rm(folder, { recursive: true, force: true }); }
  });

  it('rechecks selected local files before confirmation and refuses a baseline for an externally changed original', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'codereview-m2-change-'));
    const file = join(folder, 'requirements.md');
    try {
      await writeFile(file, 'Charge once.');
      const { handle, panel, saved } = await open();
      vscodeMockState.openDialog = async () => [{ fsPath: file }];
      panel.webview.receiveMessage({ type: 'file', ...selection });
      await vi.waitFor(() => expect(state()?.ready).toBe(true));
      const id = state()!.materials[0].id;
      panel.webview.receiveMessage({ type: 'source', id });
      await vi.waitFor(() => expect(panel.webview.messages).toContainEqual(expect.objectContaining({ type: 'source', readOnly: true })));
      await writeFile(file, 'A changed original requirement.');
      panel.webview.receiveMessage({ type: 'select', ...selection, confirmed: true });
      await vi.waitFor(() => expect(state()?.materials[0].version).toBe(2));
      expect(state()?.ready).toBe(false);
      expect(saved.at(-1)?.draft.confirmation).toBeUndefined();
      expect(saved.at(-1)?.draft.materials[0].versions[0].text).toBe('Charge once.');
      handle.dispose();
    } finally { await rm(folder, { recursive: true, force: true }); }
  });

  it('does not overwrite an invalid saved record with empty successful state', async () => {
    const save = vi.fn();
    const { handle, panel } = await open({ load: async () => { throw new Error('Invalid stored state'); }, save });
    expect(state()?.error).toContain('not overwritten');
    panel.webview.receiveMessage({ type: 'material', ...selection, name: 'New', text: 'New text' });
    await vi.waitFor(() => expect(state()?.error).toContain('not overwritten'));
    expect(save).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('ignores a canceled file-dialog error after a newer material has already been organized', async () => {
    const { handle, panel } = await open();
    let rejectDialog!: (error: Error) => void;
    vscodeMockState.openDialog = () => new Promise((_resolve, reject) => { rejectDialog = reject; });
    panel.webview.receiveMessage({ type: 'file', ...selection });
    await vi.waitFor(() => expect(rejectDialog).toBeTypeOf('function'));
    panel.webview.receiveMessage({ type: 'cancelAnalysis' });
    panel.webview.receiveMessage({ type: 'material', ...selection, name: 'New material', text: 'Charge once.' });
    await vi.waitFor(() => expect(state()).toMatchObject({ ready: true, error: '' }));
    rejectDialog(new Error('Late file dialog error'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state()).toMatchObject({ ready: true, error: '' });
    handle.dispose();
  });

  it('restores a valid draft and reuses its understanding only for the same source and pinned scope', async () => {
    const initial = await open();
    initial.panel.webview.receiveMessage({ type: 'material', ...selection, name: 'Rule', text: 'Charge once.' });
    await vi.waitFor(() => expect(state()?.ready).toBe(true));
    const saved = initial.saved.at(-1)!;
    initial.handle.dispose();
    const analyze = vi.fn(async (draft: RequirementsDraft, scope: { key: string }) => understood(draft, scope.key));
    const restored = await open({ load: async () => structuredClone(saved), analyze });
    restored.panel.webview.receiveMessage({ type: 'selection', ...selection });
    await vi.waitFor(() => expect(state()?.ready).toBe(true));
    expect(analyze).not.toHaveBeenCalled();
    const key = requirementScopeKey(root, set);
    expect(requirementReadiness(saved.draft, key).canConfirm).toBe(true);
    restored.handle.dispose();
  });
});
