import { describe, expect, it, vi } from 'vitest';
import { ReviewSession } from './reviewSession';
import { ReviewCenterController, type ReviewCenterServices } from './reviewCenterController';
import { captureReviewFileAction, createWorkspaceView, restoreWorkspaceView } from './reviewWorkspace';
import { buildReviewCenterState, centerReferenceId, centerReferences, reviewCenterContextKey } from '../ui/reviewCenterState';
import { businessConclusionSummary } from '../ui/businessReviewPanel';
import { businessHash } from './businessReview';
import { m } from '../i18n';
import { reviewCenterFixture } from '../test/reviewCenterFixture';
import { reviewCenterView } from '../ui/reviewCenterView';

function services(): ReviewCenterServices {
  return {
    preparing: () => false, restoreSource: vi.fn(async () => {}), openFile: vi.fn(async () => {}), openReference: vi.fn(async () => {}),
    prepare: vi.fn(async () => {}), run: vi.fn(async () => {}), cancel: vi.fn(), model: vi.fn(async () => {}),
    language: vi.fn(async () => {}), export: vi.fn(async () => {}), confirmReport: vi.fn(async () => {}), note: vi.fn(async () => {}),
    fix: vi.fn(async () => {}), defaultBody: () => 'Controlled draft.', findingBody: () => 'Controlled finding.',
    confirmReplace: async () => true, confirmRemoteCheck: async () => true, publish: vi.fn(async () => {}),
    legacyAnalyze: vi.fn(async () => {}), legacyGlobal: vi.fn(async () => {}),
  };
}

describe('review center selection and versioning', () => {
  it('clears the preparation-only restore marker on handoff while keeping saved review editor state', async () => {
    const { session } = await reviewCenterFixture();
    const state = buildReviewCenterState(session, { running: false, publishBusy: false, model: 'Controlled', language: 'en' });
    const html = reviewCenterView(state, [], 'test-nonce');
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error('Review center bootstrap script is missing');
    let saved: Record<string, unknown> = { preparationCwd: 'C:\\repo', center: { filter: 'inventory', buffers: {} } };
    const api = { getState: () => saved, setState: (value: Record<string, unknown>) => { saved = value; }, postMessage() {} };
    const source = { attachShadow: () => ({ append() {} }) };
    const template = { content: { cloneNode: () => ({}) } };
    Function('window', 'document', 'acquireVsCodeApi', script)(
      {}, { getElementById: (id: string) => id === 'review-source' ? source : template }, () => api,
    );
    expect(saved).toEqual({ center: { filter: 'inventory', buffers: {} } });
    session.dispose();
  });

  it('projects real open and dismissed findings into the conclusion without treating a handling note as a fix', async () => {
    const { session, run } = await reviewCenterFixture();
    const input = { running: false, publishBusy: false, model: 'Controlled', language: 'en' };
    session.recordBusinessNote(run.findings[0].id, 'A comment is not verification.');
    const open = buildReviewCenterState(session, input);
    expect(open.conclusion.openItems.map((row) => row.id)).toEqual([run.findings[0].id]);
    expect(open.conclusion.openItems[0].summary).toBe(run.findings[0].impact);
    expect(open.conclusion.dismissedItems).toEqual([]);
    run.findings[0].status = 'dismissed';
    run.findings[0].kind = 'reasonable';
    await session.setBusinessReview(run);
    const dismissed = buildReviewCenterState(session, input);
    expect(dismissed.conclusion.openItems).toEqual([]);
    expect(dismissed.conclusion.dismissedItems.map((row) => row.id)).toEqual([run.findings[0].id]);
    session.dispose();
  });

  it('keeps the selected business finding while reading associated files and original materials', async () => {
    const { session } = await reviewCenterFixture();
    const deps = services();
    const controller = new ReviewCenterController(session, deps);
    const contextKey = reviewCenterContextKey(session);
    const id = session.businessReview!.findings[0].id;
    await controller.handle({ type: 'center', action: 'select', contextKey, kind: 'finding', id });
    expect(deps.openFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/restore.ts', line: 2, reference: expect.objectContaining({ side: 'head' }) }));
    await controller.handle({ type: 'center', action: 'file', contextKey, path: 'src/api.ts' });
    expect(session.workspaceView.selection).toEqual({ kind: 'finding', id });
    const material = [...centerReferences(session).values()].find((ref) => ref.kind === 'business' && ref.citation.kind === 'material')!;
    await controller.handle({ type: 'center', action: 'reference', contextKey, id: centerReferenceId(material) });
    expect(session.workspaceView.selection).toEqual({ kind: 'finding', id });
    expect(session.workspaceView.source).toEqual({ kind: 'reference', id: centerReferenceId(material) });
    expect(deps.openReference).toHaveBeenCalledWith(centerReferenceId(material), material);
    session.dispose();
  });

  it('rejects stale context, unknown paths and fabricated reference identities without opening a source', async () => {
    const { session } = await reviewCenterFixture();
    const deps = services();
    const controller = new ReviewCenterController(session, deps);
    const key = reviewCenterContextKey(session);
    await expect(controller.handle({ type: 'center', action: 'file', contextKey: 'old', path: 'src/restore.ts' })).rejects.toThrow(/context changed/);
    await expect(controller.handle({ type: 'center', action: 'file', contextKey: key, path: '../private.ts' })).rejects.toThrow();
    await expect(controller.handle({ type: 'center', action: 'reference', contextKey: key, id: '0' })).rejects.toThrow(/quotation/);
    expect(deps.openFile).not.toHaveBeenCalled();
    expect(deps.openReference).not.toHaveBeenCalled();
    session.dispose();
  });

  it('does not invalidate navigation merely because source reading coverage or report acknowledgement changes', async () => {
    const { session } = await reviewCenterFixture();
    const key = reviewCenterContextKey(session);
    session.markSeen('src/restore.ts', [1, 2]);
    session.confirmBusinessReview();
    expect(reviewCenterContextKey(session)).toBe(key);
    session.dispose();
  });

  it('persists stage, issue, inspector and source independently, then resets old issue identity for a new run', async () => {
    const { session, store, set, cwd, run } = await reviewCenterFixture();
    const id = run.findings[0].id;
    session.setWorkspaceView({ stage: 'conclusion', navigator: 'findings', selection: { kind: 'finding', id }, inspector: 'evidence', source: { kind: 'file', path: 'src/api.ts' }, focus: true });
    await session.persist();
    const reloaded = new ReviewSession(store, 'fixture');
    await reloaded.start(set, cwd);
    expect(reloaded.workspaceView).toEqual(session.workspaceView);
    await reloaded.setBusinessReview({ ...run, id: 'new-run' });
    expect(reloaded.workspaceView.selection).toEqual({ kind: 'overview' });
    expect(reloaded.workspaceView.source).toEqual({ kind: 'file', path: 'src/api.ts' });
    session.dispose(); reloaded.dispose();
  });

  it('preserves invalid saved view data instead of replacing review results with an empty success', async () => {
    const { session, store, set, cwd } = await reviewCenterFixture();
    session.snapshot!.workspaceView = { version: 99, original: 'retained' };
    await session.persist();
    const reloaded = new ReviewSession(store, 'fixture');
    await reloaded.start(set, cwd);
    expect(reloaded.workspaceViewError).toMatch(/invalid/);
    expect(reloaded.businessReview?.findings).toHaveLength(1);
    expect(reloaded.snapshot?.workspaceView).toEqual({ version: 99, original: 'retained' });
    reloaded.setWorkspaceView({ navigator: 'findings' });
    expect(reloaded.workspaceViewError).toBeUndefined();
    session.dispose(); reloaded.dispose();
  });

  it('separates a generated draft from acknowledgement of its exact rendered preview', async () => {
    const { session } = await reviewCenterFixture();
    const deps = services();
    deps.defaultBody = () => businessConclusionSummary(session.businessReview!);
    const controller = new ReviewCenterController(session, deps);
    const key = reviewCenterContextKey(session);
    await controller.handle({ type: 'center', action: 'stage', contextKey: key, value: 'conclusion' });
    const draft = session.conclusionDraft!;
    expect(session.conclusionPreviewCurrent).toBe(false);
    await controller.handle({ type: 'center', action: 'savePreview', contextKey: key, draft: { id: draft.id, revision: draft.revision, body: '# Exact body\n\n- Reviewed scope only.', verdict: 'request-changes' } });
    expect(session.conclusionPreviewCurrent).toBe(false);
    const saved = session.conclusionDraft!;
    await controller.handle({ type: 'center', action: 'previewRendered', contextKey: key, id: saved.id, revision: saved.revision, previewKey: saved.previewKey });
    expect(session.conclusionPreviewCurrent).toBe(true);
    session.dispose();
  });

  it('rejects invalid and cross-scope view shapes', () => {
    expect(restoreWorkspaceView(createWorkspaceView('scope'), 'scope').stage).toBe('review');
    expect(() => restoreWorkspaceView({ ...createWorkspaceView('scope'), selection: { kind: 'finding' } }, 'scope')).toThrow();
    expect(() => restoreWorkspaceView(createWorkspaceView('other'), 'scope')).toThrow();
  });

  it('keeps an async file action attached to its source while reading a different associated file', async () => {
    const { session, text } = await reviewCenterFixture();
    let source = text;
    const commit = captureReviewFileAction(session, 'src/restore.ts', businessHash(text), async () => source);
    session.setWorkspaceView({ source: { kind: 'file', path: 'src/api.ts' } });
    const write = vi.fn();
    await commit(write);
    expect(write).toHaveBeenCalledTimes(1);
    source += '\n// external edit';
    await expect(commit(write)).rejects.toThrow(/source context/);
    expect(write).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it('rejects an async file action when the scope switches during its final source read', async () => {
    const { session, text, set, cwd } = await reviewCenterFixture();
    let finish!: (text: string) => void;
    const commit = captureReviewFileAction(session, 'src/restore.ts', businessHash(text), () => new Promise((resolve) => { finish = resolve; }));
    const write = vi.fn();
    const pending = commit(write);
    await session.start({ ...set, scopeId: 'pr-43' }, cwd);
    finish(text);
    await expect(pending).rejects.toThrow(/source context/);
    expect(write).not.toHaveBeenCalled();
    session.dispose();
  });

  it('projects legacy file/global busy state into the same conclusion gate as the publisher', async () => {
    const { session } = await reviewCenterFixture();
    const input = { running: false, publishBusy: false, model: 'Controlled', language: 'en' };
    expect(buildReviewCenterState(session, input).conclusion.canComment).toBe(true);
    const busy = buildReviewCenterState(session, { ...input, analysisBusy: true, globalRunning: true });
    expect(busy.globalRunning).toBe(true);
    expect(busy.conclusion.canComment).toBe(false);
    expect(busy.conclusion.canRequestChanges).toBe(false);
    expect(busy.conclusion.canApprove).toBe(false);
    session.dispose();
  });

  it('returns to the global overview without discarding the currently read source', async () => {
    const { session } = await reviewCenterFixture();
    session.setWorkspaceView({ selection: { kind: 'finding', id: session.businessReview!.findings[0].id }, source: { kind: 'file', path: 'src/api.ts' } });
    const controller = new ReviewCenterController(session, services());
    await controller.handle({ type: 'center', action: 'select', kind: 'overview', contextKey: reviewCenterContextKey(session) });
    expect(session.workspaceView.selection).toEqual({ kind: 'overview' });
    expect(session.workspaceView.source).toEqual({ kind: 'file', path: 'src/api.ts' });
    session.dispose();
  });

  it('preserves the shared estimated-token HUD and per-operation disclosure in the center', async () => {
    const { session } = await reviewCenterFixture();
    session.recordTokenUsage({ op: 'business', input: 12_345, output: 123 });
    const state = buildReviewCenterState(session, { running: false, publishBusy: false, model: 'Controlled', language: 'en' });
    expect(state.tokens?.label).toContain('Tokens (est.)');
    expect(state.tokens?.label).toContain('12.3k');
    expect(state.tokens?.tooltip).toContain('12,345');
    expect(state.tokens?.tooltip).toContain(m().workbench.tokenEstimateNote);
    session.dispose();
  });
});
