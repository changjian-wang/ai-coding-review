import { describe, expect, it, vi } from 'vitest';
import { ReviewSession } from './reviewSession';
import { ReviewCenterController, type ReviewCenterServices } from './reviewCenterController';
import { captureReviewFileAction, createWorkspaceView, openReviewProblems, restoreWorkspaceView } from './reviewWorkspace';
import { buildReviewCenterState, centerReferenceId, centerReferences, reviewCenterContextKey } from '../ui/reviewCenterState';
import { businessConclusionSummary } from '../ui/businessReviewReport';
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
  };
}

describe('review center selection and versioning', () => {
  it('removes placeholder and planning navigation, obsolete analysis actions and redundant model cards from the live center', async () => {
    const { session } = await reviewCenterFixture();
    const state = buildReviewCenterState(session, { running: false, publishBusy: false, model: 'Controlled', language: 'en' });
    const html = reviewCenterView(state, [], 'strict-pruning');
    const body = html.slice(html.indexOf('<body>'), html.indexOf('<template id="source-template">'));
    for (const removed of ['data-value="feedback"', 'data-value="business"', 'center-tokens', 'overview-issue', 'auxiliary-navigation']) {
      expect(body).not.toContain(removed);
    }
    expect(state).not.toHaveProperty('units');
    expect(state).not.toHaveProperty('legacy');
    const deps = services();
    const controller = new ReviewCenterController(session, deps);
    for (const value of ['business', 'feedback']) {
      await expect(controller.handle({ type: 'center', action: 'navigator', value, contextKey: reviewCenterContextKey(session) })).rejects.toThrow();
    }
    await expect(controller.handle({ type: 'center', action: 'select', kind: 'unit', id: 'U-1', contextKey: reviewCenterContextKey(session) })).rejects.toThrow();
    for (const action of ['legacyAnalyze', 'legacyGlobal']) {
      await expect(Reflect.apply(controller.handle, controller, [{ type: 'center', action, contextKey: reviewCenterContextKey(session) }])).rejects.toThrow();
    }
    expect(deps.run).not.toHaveBeenCalled();
    session.dispose();
  });

  it('escapes model and source HTML in the actual issue view after removing the separate report renderer', async () => {
    const { session } = await reviewCenterFixture();
    const finding = session.businessReview!.findings[0];
    finding.title = '<script>unexpected()</script>';
    finding.evidence[0].quote = '<script>untrustedSource()</script>';
    session.setWorkspaceView({ selection: { kind: 'finding', id: finding.id }, inspector: 'judgment' });
    const state = buildReviewCenterState(session, { running: false, publishBusy: false, model: 'Controlled', language: 'en' });
    const html = reviewCenterView(state, [], 'actual-issue-escaping');
    expect(html).not.toContain('<script>unexpected()</script>');
    expect(html).not.toContain('<script>untrustedSource()</script>');
    expect(state.inspector.html).toContain('&lt;script&gt;untrustedSource()&lt;/script&gt;');
    session.dispose();
  });

  it('lands on review issues and migrates the old business-first layout without losing an explicitly selected finding or source', () => {
    const view = createWorkspaceView('scope');
    expect(view.navigator).toBe('findings');
    const { layout, ...old } = view;
    expect(layout).toBe('issues-first');
    expect(restoreWorkspaceView({ ...old, navigator: 'business', selection: { kind: 'unit', id: 'U-1' }, focus: true }, 'scope'))
      .toMatchObject({ layout: 'issues-first', navigator: 'findings', selection: { kind: 'overview' }, focus: false });
    expect(restoreWorkspaceView({ ...old, selection: { kind: 'finding', id: 'F-1' }, source: { kind: 'reference', id: 'source' } }, 'scope'))
      .toMatchObject({ selection: { kind: 'finding', id: 'F-1' }, source: { kind: 'reference', id: 'source' } });
    expect(restoreWorkspaceView({ ...view, navigator: 'business', selection: { kind: 'unit', id: 'U-1' } }, 'scope'))
      .toMatchObject({ navigator: 'findings', selection: { kind: 'overview' }, source: undefined });
    expect(restoreWorkspaceView({ ...view, navigator: 'feedback' }, 'scope').navigator).toBe('findings');
  });

  it('shows a bounded no-issue result only for complete current coverage, never for partial, stale or missing coverage', async () => {
    const { session } = await reviewCenterFixture({ defect: false });
    const run = session.businessReview!;
    const input = { running: false, publishBusy: false, model: 'Controlled', language: 'en' };
    expect(buildReviewCenterState(session, input).outcome.title).toBe(m().reviewCenter.outcomeClear);
    run.status = 'partial';
    const partial = buildReviewCenterState(session, input);
    expect(partial.outcome.title).toBe(m().reviewCenter.outcomeIncomplete);
    expect(partial.outcome.tone).toBe('warning');
    expect(partial.outcome.limitations.length).toBeGreaterThan(0);
    run.status = 'completed';
    run.coverage.pop();
    const missing = buildReviewCenterState(session, input);
    expect(missing.outcome.title).toBe(m().reviewCenter.outcomeIncomplete);
    expect(missing.sourceCoverage).toEqual({ reviewed: 3, total: 4 });
    session.invalidateBusinessReview();
    expect(buildReviewCenterState(session, input).outcome.title).toBe(m().reviewCenter.outcomeStale);
    session.snapshot!.businessReview = undefined;
    expect(buildReviewCenterState(session, input).outcome.title).toBe(m().reviewCenter.outcomeNotStarted);
    expect(buildReviewCenterState(session, { ...input, running: true }).outcome.title).toBe(m().reviewCenter.outcomeRunning);
    session.dispose();
  });

  it('puts impact, trigger, cause and quotable evidence in the default finding judgment instead of a planning goal', async () => {
    const { session, run } = await reviewCenterFixture();
    session.setWorkspaceView({ selection: { kind: 'finding', id: run.findings[0].id }, inspector: 'judgment' });
    const state = buildReviewCenterState(session, { running: false, publishBusy: false, model: 'Controlled', language: 'en' });
    for (const text of [run.findings[0].impact, run.findings[0].trigger, run.findings[0].cause, run.findings[0].counterRationale, 'await order.restore();']) {
      expect(state.inspector.html).toContain(text);
    }
    expect(state.inspector.html.indexOf(run.findings[0].impact)).toBeLessThan(state.inspector.html.indexOf(run.findings[0].cause));
    expect(state.inspector.html).toContain('class="reference-card" open');
    expect(state.inspector.canFix).toBe(false);
    expect(state.outcome.title).toContain('1');
    expect(state.conclusion.canApprove).toBe(false);
    session.dispose();
  });

  it('uses the same pending issue order for the list and next action without revisiting dismissed findings', async () => {
    const { session } = await reviewCenterFixture();
    const run = session.businessReview!;
    run.findings[0].severity = 'medium';
    run.findings.push({ ...structuredClone(run.findings[0]), id: 'dismissed', status: 'dismissed', kind: 'reasonable' });
    run.findings.push({ ...structuredClone(run.findings[0]), id: 'unverified', status: 'unresolved', severity: 'high' });
    const original = run.findings.map((finding) => finding.id);
    expect(openReviewProblems(run).map((item) => item.id)).toEqual([run.findings[0].id, 'unverified']);
    expect(run.findings.map((finding) => finding.id)).toEqual(original);
    const state = buildReviewCenterState(session, { running: false, publishBusy: false, model: 'Controlled', language: 'en' });
    expect(state.conclusion.dismissedItems.map((item) => item.id)).toEqual(['dismissed']);
    session.setWorkspaceView({ selection: { kind: 'finding', id: run.findings[0].id } });
    const controller = new ReviewCenterController(session, services());
    await controller.handle({ type: 'center', action: 'next', contextKey: reviewCenterContextKey(session) });
    expect(session.workspaceView.selection).toEqual({ kind: 'finding', id: 'unverified' });
    session.dispose();
  });

  it('clears the preparation-only restore marker on handoff while keeping saved review editor state', async () => {
    const { session } = await reviewCenterFixture();
    const state = buildReviewCenterState(session, { running: false, publishBusy: false, model: 'Controlled', language: 'en' });
    const html = reviewCenterView(state, [], 'test-nonce');
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error('Review center bootstrap script is missing');
    let saved: Record<string, unknown> = { preparationCwd: 'C:\\repo', preparationHasReview: true, center: { filter: 'inventory', buffers: {} } };
    const api = { getState: () => saved, setState: (value: Record<string, unknown>) => { saved = value; }, postMessage() {} };
    const source = { attachShadow: () => ({ append() {} }) };
    const template = { content: { cloneNode: () => ({}) } };
    Function('window', 'document', 'acquireVsCodeApi', script)(
      {}, { getElementById: (id: string) => id === 'review-source' ? source : template }, () => api,
    );
    expect(saved).toEqual({ center: { filter: 'inventory', buffers: {} } });
    session.dispose();
  });

  it('keeps only one preparation entry, one export and the contextual source recheck in the main review center', async () => {
    const { session } = await reviewCenterFixture();
    const state = buildReviewCenterState(session, { running: false, publishBusy: false, model: 'Controlled', language: 'en' });
    const html = reviewCenterView(state, [], 'unique-entry');
    const body = html.slice(html.indexOf('<body>'), html.indexOf('<template id="source-template">'));
    expect(body.match(/data-center-action="stage" data-value="prepare"/g)).toHaveLength(1);
    expect(body.match(/data-center-action="export"/g)).toHaveLength(1);
    expect(body).not.toContain('center-legacy-analyze');
    expect(body).not.toContain('center-legacy-global');
    expect(body).toContain('id="show-current-scope"');
    expect(body).toContain('id="scope-dialog"');
    expect(html.match(/id="act-analyze"/g)).toHaveLength(1);
    session.dispose();
  });

  it('hands preparation to the owning surface before changing the visible stage and preserves the previous conclusion', async () => {
    const { session } = await reviewCenterFixture();
    session.setWorkspaceView({ stage: 'conclusion' });
    const deps = services();
    deps.prepare = vi.fn(async () => { expect(session.workspaceView.stage).toBe('conclusion'); });
    const controller = new ReviewCenterController(session, deps);
    await controller.handle({ type: 'center', action: 'stage', value: 'prepare', contextKey: reviewCenterContextKey(session) });
    expect(deps.prepare).toHaveBeenCalledTimes(1);
    expect(session.workspaceView.stage).toBe('conclusion');
    expect(deps.run).not.toHaveBeenCalled();
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

  it('keeps estimated usage and per-operation disclosure in model details instead of a permanent HUD', async () => {
    const { session } = await reviewCenterFixture();
    session.recordTokenUsage({ op: 'business', input: 12_345, output: 123 });
    const state = buildReviewCenterState(session, { running: false, publishBusy: false, model: 'Controlled', language: 'en' });
    expect(state.tokens).not.toHaveProperty('label');
    expect(state.tokens?.tooltip).toContain('Tokens (est.)');
    expect(state.tokens?.tooltip).toContain('12,345');
    expect(state.tokens?.tooltip).toContain(m().workbench.tokenEstimateNote);
    expect(reviewCenterView(state, [], 'usage-details')).not.toContain('id="center-tokens"');
    session.dispose();
  });
});
