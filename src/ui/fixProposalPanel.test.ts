import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { resetVscodeMock, vscodeMockState } from '../test/vscodeMock';
import { FixProposalPanel } from './fixProposalPanel';

describe('FixProposalPanel', () => {
  afterEach(() => {
    resetVscodeMock();
    FixProposalPanel.init({
      get: () => ({}),
      update: async () => undefined,
    } as unknown as vscode.Memento);
  });

  it('re-resolves the panel title and finding text in the current language', () => {
    const display = {
      en: { title: 'title-en', detail: 'detail-en', suggestion: 'suggestion-en' },
      'zh-CN': { title: 'title-zh', detail: 'detail-zh', suggestion: 'suggestion-zh' },
    };

    FixProposalPanel.show({
      rel: 'src/example.ts',
      localizationScope: { kind: 'file', rel: 'src/example.ts' },
      cacheKey: 'example',
      fileUri: {} as vscode.Uri,
      finding: { id: 'f1', line: 7, ...display.en },
      getDisplayFinding: () => display[vscodeMockState.language as keyof typeof display],
      generate: () => new Promise(() => {}),
      onApplied: () => {},
    });

    const panel = vscodeMockState.panel;
    expect(panel?.title).toContain('title-en');
    expect(panel?.webview.html).toContain('detail-en');

    const instance = (FixProposalPanel as unknown as {
      instance?: { displayLine: number };
    }).instance;
    if (!instance) {
      throw new Error('Expected an open fix-proposal panel');
    }
    instance.displayLine = 11;
    panel?.webview.receiveMessage({
      type: 'supplementChanged',
      supplement: 'keep this draft',
    });

    vscodeMockState.language = 'zh-CN';
    FixProposalPanel.refreshIfOpen({ kind: 'global' });

    expect(panel?.title).toContain('title-en');
    expect(panel?.webview.html).toContain('detail-en');

    FixProposalPanel.refreshIfOpen({ kind: 'file', rel: 'src/example.ts' });

    expect(panel?.title).toContain('title-zh');
    expect(panel?.webview.html).toContain('detail-zh');
    expect(panel?.webview.html).toContain('suggestion-zh');
    expect(panel?.webview.html).toContain('第 11 行');
    expect(panel?.webview.html).toContain('keep this draft');
    expect(panel?.webview.html).not.toContain('detail-en');
  });

  it('ignores an older cached restore that finishes after a finding switch', async () => {
    const content = 'const first = 1;\nconst second = 2;\n';
    const cache = {
      first: {
        proposals: [{
          title: 'proposal-first',
          rationale: 'first',
          edits: [{ oldText: 'const first = 1;', newText: 'const first = 10;' }],
          applied: false,
        }],
        generatedAt: 1,
      },
      second: {
        proposals: [{
          title: 'proposal-second',
          rationale: 'second',
          edits: [{ oldText: 'const second = 2;', newText: 'const second = 20;' }],
          applied: false,
        }],
        generatedAt: 2,
      },
    };
    FixProposalPanel.init({
      get: () => cache,
      update: async () => undefined,
    } as unknown as vscode.Memento);

    const pendingReads: Array<(doc: { getText(): string }) => void> = [];
    vscodeMockState.openTextDocument = () =>
      new Promise((resolve) => pendingReads.push(resolve));
    const generate = vi.fn(async () => {
      throw new Error('cache restore should not regenerate');
    });
    const request = (cacheKey: string, title: string, line: number): Parameters<typeof FixProposalPanel.show>[0] => ({
      rel: 'src/example.ts',
      localizationScope: { kind: 'file', rel: 'src/example.ts' },
      cacheKey,
      fileUri: { fsPath: 'src/example.ts' } as vscode.Uri,
      finding: { id: cacheKey, line, title, detail: `${title}-detail` },
      getDisplayFinding: () => ({ title, detail: `${title}-detail` }),
      generate,
      onApplied: () => undefined,
    });

    FixProposalPanel.show(request('first', 'first', 1));
    expect(FixProposalPanel.canSwitchToCached('second')).toBe(true);
    FixProposalPanel.show(request('second', 'second', 2));
    expect(pendingReads).toHaveLength(2);
    expect(vscodeMockState.panel?.webview.messages.at(-1)).toMatchObject({
      type: 'supplement',
      value: '',
    });
    expect(vscodeMockState.panel?.webview.messages).toContainEqual({
      type: 'state',
      state: { kind: 'loading', message: expect.any(String) },
    });

    pendingReads[1]({ getText: () => content });
    await vi.waitFor(() => {
      const ready = vscodeMockState.panel?.webview.messages
        .filter((message): message is { type: 'state'; state: { kind: string; proposals: Array<{ title: string }> } } =>
          typeof message === 'object'
          && message !== null
          && (message as { type?: string }).type === 'state'
          && (message as { state?: { kind?: string } }).state?.kind === 'ready')
        .at(-1);
      expect(ready?.state.proposals[0]?.title).toBe('proposal-second');
    });

    pendingReads[0]({ getText: () => content });
    await Promise.resolve();
    await Promise.resolve();

    const ready = vscodeMockState.panel?.webview.messages
      .filter((message): message is { type: 'state'; state: { kind: string; proposals: Array<{ title: string }> } } =>
        typeof message === 'object'
        && message !== null
        && (message as { type?: string }).type === 'state'
        && (message as { state?: { kind?: string } }).state?.kind === 'ready')
      .at(-1);
    expect(ready?.state.proposals[0]?.title).toBe('proposal-second');
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not regenerate when a selection-only cached proposal is stale', async () => {
    FixProposalPanel.init({
      get: () => ({
        stale: {
          proposals: [{
            title: 'stale proposal',
            rationale: 'stale',
            edits: [{ oldText: 'old', newText: 'new' }],
            applied: false,
          }],
          generatedAt: 1,
          fileHash: 'stale-hash',
        },
      }),
      update: async () => undefined,
    } as unknown as vscode.Memento);
    vscodeMockState.openTextDocument = async () => ({ getText: () => 'current content' });
    const currentGenerate = () => new Promise<never>(() => {});
    const staleGenerate = vi.fn(async () => []);
    const request = (
      cacheKey: string,
      generate: Parameters<typeof FixProposalPanel.show>[0]['generate'],
    ): Parameters<typeof FixProposalPanel.show>[0] => ({
      rel: 'src/example.ts',
      localizationScope: { kind: 'file', rel: 'src/example.ts' },
      cacheKey,
      fileUri: { fsPath: 'src/example.ts' } as vscode.Uri,
      finding: { id: cacheKey, line: 1, title: cacheKey, detail: cacheKey },
      getDisplayFinding: () => ({ title: cacheKey, detail: cacheKey }),
      generate,
      onApplied: () => undefined,
    });

    FixProposalPanel.show(request('current', currentGenerate));
    FixProposalPanel.show(request('stale', staleGenerate), { cacheOnly: true });

    await vi.waitFor(() => {
      expect(vscodeMockState.panel?.webview.messages).toContainEqual({
        type: 'state',
        state: {
          kind: 'error',
          message: expect.any(String),
          canRetry: true,
        },
      });
    });
    expect(staleGenerate).not.toHaveBeenCalled();
  });
});