import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetVscodeMock, vscodeMockState } from '../test/vscodeMock';
import {
  WorkbenchPanel,
  type WorkbenchActions,
  type WorkbenchState,
} from './workbenchPanel';

describe('WorkbenchPanel incremental patching', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetVscodeMock();
  });

  it('patches only a changed file and its ancestor folders', async () => {
    vi.useFakeTimers();
    const state = workbenchState();
    const provider = vi.fn((_paths?: ReadonlySet<string>) => state);
    WorkbenchPanel.show(provider, {} as WorkbenchActions);

    state.files[0].seen = 5;
    state.coverage.seen = 5;
    WorkbenchPanel.refreshIfOpen('src/a.ts');
    await vi.advanceTimersByTimeAsync(80);

    const changedPaths = provider.mock.calls.at(-1)?.[0];
    expect(changedPaths).toEqual(new Set(['src/a.ts']));
    expect(vscodeMockState.panel?.webview.messages.at(-1)).toMatchObject({
      type: 'patch',
      files: [{ path: 'src/a.ts', seen: 5 }],
      folders: [{ path: 'src', dotClass: 'partial' }],
      coverage: { seen: 5 },
    });
  });

  it('lends its existing panel to preparation without background refreshes or old actions replacing it', async () => {
    vi.useFakeTimers();
    const state = workbenchState();
    const open = vi.fn();
    const noop = () => {};
    const actions: WorkbenchActions = {
      open, openFocus: noop, focusDoc: noop, disposeFinding: noop, locate: noop,
      globalAnalysis: noop, cancelGlobalAnalysis: noop, showGlobal: noop,
      businessReview: noop, cancelBusinessReview: noop, showBusinessReview: noop,
      exportReport: noop, submit: noop, pickModel: noop, pickLanguage: noop, pickBranch: noop,
      pickProject: noop, pickScope: noop, pickScopeKind: noop, pickProjectCwd: noop, pickLanguageId: noop,
      openDynMenu: noop, applyDynMenu: noop,
    };
    WorkbenchPanel.show(() => state, actions);
    const panel = vscodeMockState.panel!;
    const close = vi.fn();
    panel.onDidDispose(close);
    WorkbenchPanel.refreshIfOpen('src/a.ts');
    const handoff = WorkbenchPanel.suspendForPreparation()!;
    expect(handoff.panel).toBe(panel);
    panel.webview.html = '<main>Complete preparation form</main>';
    const previous = panel.webview.messages.length;
    state.files[0].seen = 5;
    WorkbenchPanel.refreshIfOpen('src/a.ts');
    WorkbenchPanel.rerenderIfOpen();
    WorkbenchPanel.show(() => state, actions);
    panel.webview.receiveMessage({ type: 'select', path: 'src/a.ts' });
    await vi.advanceTimersByTimeAsync(100);
    expect(panel.webview.html).toBe('<main>Complete preparation form</main>');
    expect(panel.webview.messages).toHaveLength(previous);
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    handoff.resume();
    expect(vscodeMockState.panel).toBe(panel);
    expect(panel.webview.html).not.toContain('Complete preparation form');
    panel.webview.receiveMessage({ type: 'select', path: 'src/a.ts' });
    expect(open).toHaveBeenCalledWith('src/a.ts');
    expect(close).not.toHaveBeenCalled();
  });

  it('does not revive an old panel when preparation was closed and another workbench was created', () => {
    const state = workbenchState();
    WorkbenchPanel.show(() => state, {} as WorkbenchActions);
    const handoff = WorkbenchPanel.suspendForPreparation()!;
    vscodeMockState.panel!.dispose();
    WorkbenchPanel.show(() => state, {} as WorkbenchActions);
    const replacement = vscodeMockState.panel!;
    const html = replacement.webview.html;
    handoff.resume();
    expect(vscodeMockState.panel).toBe(replacement);
    expect(replacement.webview.html).toBe(html);
    expect(handoff.panel).not.toBe(replacement);
  });

  it('patches requirement boundaries and separate feedback permission without showing approval', async () => {
    vi.useFakeTimers();
    const state = workbenchState();
    WorkbenchPanel.show(() => state, {} as WorkbenchActions);
    state.requirementStatus = 'Understanding confirmed; requirement consistency not assessed.';
    state.feedbackAllowed = true;
    WorkbenchPanel.refreshIfOpen();
    await vi.advanceTimersByTimeAsync(80);
    expect(vscodeMockState.panel?.webview.messages.at(-1)).toMatchObject({
      type: 'patch', gatePassed: false, feedbackAllowed: true, requirementStatus: state.requirementStatus,
    });
    expect(vscodeMockState.panel?.webview.html).toContain('id="requirementPreparation"');
  });

  it('patches business-run controls and actual blockers without substituting the old scroll/global gate', async () => {
    vi.useFakeTimers();
    const state = workbenchState();
    const start = vi.fn();
    const cancel = vi.fn();
    const show = vi.fn();
    const noop = () => {};
    const actions: WorkbenchActions = {
      open: noop, openFocus: noop, focusDoc: noop, disposeFinding: noop, locate: noop,
      globalAnalysis: noop, cancelGlobalAnalysis: noop, showGlobal: noop,
      businessReview: start, cancelBusinessReview: cancel, showBusinessReview: show,
      exportReport: noop, submit: noop, pickModel: noop, pickLanguage: noop, pickBranch: noop,
      pickProject: noop, pickScope: noop, pickScopeKind: noop, pickProjectCwd: noop, pickLanguageId: noop,
      openDynMenu: noop, applyDynMenu: noop,
    };
    WorkbenchPanel.show(() => state, actions);
    state.businessReview = { running: true, hasReport: true, progress: 'Independent global discovery', blockers: ['Critical provider semantics unknown'] };
    WorkbenchPanel.refreshIfOpen();
    await vi.advanceTimersByTimeAsync(80);
    const webview = vscodeMockState.panel!.webview;
    expect(webview.messages.at(-1)).toMatchObject({ type: 'patch', businessReview: state.businessReview });
    webview.receiveMessage({ type: 'businessReview' });
    webview.receiveMessage({ type: 'cancelBusinessReview' });
    webview.receiveMessage({ type: 'showBusinessReview' });
    expect(start).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
    expect(webview.html).toContain('id="businessProgress"');
  });
});

function workbenchState(): WorkbenchState {
  return {
    structureVersion: 1,
    label: 'PR #1',
    files: [
      reviewFile('src/a.ts'),
      reviewFile('src/b.ts'),
    ],
    selected: 'src/a.ts',
    findings: [],
    coverage: { seen: 0, total: 20, filesReady: 0, filesTotal: 2 },
    gatePassed: false,
    globalDone: false,
    hasGlobalReport: false,
    modelLabel: 'Auto',
    repoName: 'repo',
    projects: [],
    languages: [],
  };
}

function reviewFile(path: string) {
  return {
    path,
    name: path.split('/').pop() ?? path,
    dir: 'src',
    seen: 0,
    total: 10,
    analyzed: false,
    ready: false,
    fullySeen: false,
    unconfirmed: 0,
    findings: 0,
    active: path.endsWith('a.ts'),
    analyzing: false,
  };
}