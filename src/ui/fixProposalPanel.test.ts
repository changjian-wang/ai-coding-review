import { afterEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { resetVscodeMock, vscodeMockState } from '../test/vscodeMock';
import { FixProposalPanel } from './fixProposalPanel';

describe('FixProposalPanel language refresh', () => {
  afterEach(() => resetVscodeMock());

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
});