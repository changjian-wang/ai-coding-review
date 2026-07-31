import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetVscodeMock, vscodeMockState } from '../test/vscodeMock';
import {
  DocumentPanel,
  diffChangeStarts,
  nextDiffChangeIndex,
  shouldCacheSourceDom,
  sourceRenderPlan,
  type DocActions,
  type DocDiffLine,
  type DocModel,
} from './documentPanel';

describe('DocumentPanel diff updates', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetVscodeMock();
  });

  it('sends only the computed diff after the lightweight file model', () => {
    const model = documentModel();
    DocumentPanel.show(model, actions());
    const script = vscodeMockState.panel?.webview.html.match(
      /<script nonce="[^"]+">([\s\S]*?)<\/script>/,
    )?.[1];
    expect(() => new Function('acquireVsCodeApi', script ?? '')).not.toThrow();
    expect(script).not.toContain('replaceChildren');
    expect(script).toContain('ctx.renderChunk(plan.initial)');
    expect(script).toContain('const sourceDomCache = new Map()');
    expect(script).toContain('cacheCompletedSource(srcCtx)');
    expect(script).toContain('const cached = cacheable ? takeSourceDom(cacheKey) : null');
    expect(script).toContain('queueDocumentLoad(msg)');
    expect(script).toContain("type:'loaded'");
    expect(vscodeMockState.panel?.webview.html).toContain('id="act-next-diff"');
    expect(script).toContain("$('act-next-diff').addEventListener('click', jumpToNextDiffChange)");
    vscodeMockState.panel?.webview.receiveMessage({ type: 'ready' });
    const load = vscodeMockState.panel?.webview.messages.at(-1) as {
      type: string;
      requestId: number;
      model: DocModel;
    };
    expect(load).toMatchObject({ type: 'load', model: { path: model.path } });
    expect(load.requestId).toBeTypeOf('number');
    vscodeMockState.panel?.webview.receiveMessage({
      type: 'loaded',
      requestId: load.requestId,
      path: model.path,
    });
    expect(vscodeMockState.panel?.title).toBe(`📄 ${model.name}`);

    const diffLines: DocDiffLine[] = [
      { kind: 'context', oldLine: 1, newLine: 1 },
      { kind: 'deleted', oldLine: 2, html: 'old' },
      { kind: 'added', newLine: 2 },
    ];
    DocumentPanel.setDiff(model.path, diffLines, true);

    expect(vscodeMockState.panel?.webview.messages.at(-1)).toEqual({
      type: 'diffReady',
      path: model.path,
      diffLines,
      activate: true,
    });
    expect(vscodeMockState.panel?.webview.messages.at(-1)).not.toHaveProperty('model');
  });

  it('keeps diff as the default when computation finishes before webview ready', () => {
    const model = documentModel();
    const diffLines: DocDiffLine[] = [{ kind: 'added', newLine: 1 }];
    DocumentPanel.show(model, actions());

    DocumentPanel.setDiff(model.path, diffLines, true);
    vscodeMockState.panel?.webview.receiveMessage({ type: 'ready' });

    expect(vscodeMockState.panel?.webview.messages.at(-1)).toMatchObject({
      type: 'load',
      model: { path: model.path, diffLines, defaultToDiff: true },
    });
  });

  it('rebuilds the shell once when a load receives no acknowledgement', async () => {
    vi.useFakeTimers();
    const model = documentModel();
    DocumentPanel.show(model, actions());
    vscodeMockState.panel?.webview.receiveMessage({ type: 'ready' });
    const firstLoad = vscodeMockState.panel?.webview.messages.at(-1) as { requestId: number };
    const firstHtml = vscodeMockState.panel?.webview.html;

    await vi.advanceTimersByTimeAsync(4000);

    expect(vscodeMockState.panel?.webview.html).not.toBe(firstHtml);
    vscodeMockState.panel?.webview.receiveMessage({ type: 'ready' });
    const retryLoad = vscodeMockState.panel?.webview.messages.at(-1) as { requestId: number };
    expect(retryLoad.requestId).toBeGreaterThan(firstLoad.requestId);
    vscodeMockState.panel?.webview.receiveMessage({
      type: 'loaded',
      requestId: retryLoad.requestId,
      path: model.path,
    });
    expect(vscodeMockState.panel?.title).toBe(`📄 ${model.name}`);
  });
});

describe('sourceRenderPlan', () => {
  it('uses source size instead of expanded diff rows for normal files', () => {
    expect(sourceRenderPlan(469)).toEqual({ initial: 469, perFrame: 0, eager: true });
    expect(sourceRenderPlan(5000)).toEqual({ initial: 5000, perFrame: 0, eager: true });
    expect(sourceRenderPlan(5600, 2800)).toEqual({ initial: 5600, perFrame: 0, eager: true });
    expect(sourceRenderPlan(10_000, 5000)).toEqual({ initial: 10_000, perFrame: 0, eager: true });
    expect(sourceRenderPlan(5001, 5001)).toEqual({ initial: 600, perFrame: 600, eager: false });
    expect(sourceRenderPlan(12_001, 2800)).toEqual({ initial: 600, perFrame: 600, eager: false });
  });
});

describe('shouldCacheSourceDom', () => {
  it('caches completed plain views within the bounded row budget', () => {
    expect(shouldCacheSourceDom(12_000, 0, 0)).toBe(true);
    expect(shouldCacheSourceDom(30_001, 0, 0)).toBe(false);
    expect(shouldCacheSourceDom(1000, 1, 0)).toBe(false);
    expect(shouldCacheSourceDom(1000, 0, 1)).toBe(false);
  });
});

describe('Diff change navigation', () => {
  const lines: DocDiffLine[] = [
    { kind: 'context', oldLine: 1, newLine: 1 },
    { kind: 'deleted', oldLine: 2 },
    { kind: 'added', newLine: 2 },
    { kind: 'added', newLine: 3 },
    { kind: 'context', oldLine: 3, newLine: 4 },
    { kind: 'deleted', oldLine: 4 },
    { kind: 'context', oldLine: 5, newLine: 5 },
  ];

  it('treats adjacent deleted and added rows as one change block', () => {
    expect(diffChangeStarts(lines)).toEqual([1, 5]);
  });

  it('jumps forward and wraps to the first change block', () => {
    expect(nextDiffChangeIndex(lines, -1)).toBe(1);
    expect(nextDiffChangeIndex(lines, 1)).toBe(5);
    expect(nextDiffChangeIndex(lines, 6)).toBe(1);
    expect(nextDiffChangeIndex([], 0)).toBeUndefined();
  });
});

function documentModel(): DocModel {
  return {
    path: 'src/example.ts',
    revision: '1:test',
    name: 'example.ts',
    isMarkdown: false,
    sourceLines: ['const value = 1;'],
    raw: [],
    defaultToDiff: false,
    seen: [],
    findings: [],
    annotations: [],
    analyzing: false,
  };
}

function actions(): DocActions {
  const noop = () => undefined;
  return {
    seen: noop,
    translate: noop,
    translateWhole: noop,
    explain: noop,
    note: noop,
    comment: noop,
    removeAnnotation: noop,
    regenerateAnnotation: noop,
    convertAnnotationToNote: noop,
    editAnnotation: noop,
    disposeFinding: noop,
    viewFix: noop,
    locate: noop,
    analyze: noop,
    jumpNext: noop,
    focusTree: noop,
  };
}