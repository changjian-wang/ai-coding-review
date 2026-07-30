import { afterEach, describe, expect, it } from 'vitest';
import {
  resetVscodeMock,
  vscodeMockState,
} from '../test/vscodeMock';
import { WorkbenchPanel } from './workbenchPanel';

describe('WorkbenchPanel loading shell', () => {
  afterEach(() => resetVscodeMock());

  it('renders immediately and receives restore progress updates', () => {
    const { panel, progress } = WorkbenchPanel.createLoading('Restoring the saved review…');

    expect(panel).toBe(vscodeMockState.panel);
    expect(vscodeMockState.panel?.webview.html).toContain('Loading AI Coding Review');
    expect(vscodeMockState.panel?.webview.html).toContain('Restoring the saved review…');
    expect(vscodeMockState.panel?.webview.html).toContain('role="progressbar"');
    expect(vscodeMockState.panel?.webview.html).not.toContain('class="steps"');

    const script = vscodeMockState.panel?.webview.html.match(
      /<script nonce="[^"]+">([\s\S]*?)<\/script>/,
    )?.[1];
    expect(script).toBeTruthy();
    const messageElement = { textContent: 'Restoring the saved review…' };
    const percentElement = { textContent: '', hidden: true };
    const etaElement = { textContent: '', hidden: true };
    const elapsedElement = { textContent: '' };
    const phaseElement = { textContent: 'Discover files' };
    const trackClasses = new Set<string>();
    const track = {
      classList: {
        toggle: (name: string, active: boolean) => active ? trackClasses.add(name) : trackClasses.delete(name),
      },
    };
    const bar = { style: { width: '' } };
    let messageListener: ((event: { data: unknown }) => void) | undefined;
    Function('window', 'document', script ?? '')(
      {
        addEventListener: (
          type: string,
          listener: (event: { data: unknown }) => void,
        ) => {
          if (type === 'message') messageListener = listener;
        },
        setInterval: () => 0,
      },
      {
        getElementById: (id: string) => ({
          loadingMessage: messageElement,
          loadingPercent: percentElement,
          loadingEta: etaElement,
          loadingElapsed: elapsedElement,
          loadingPhase: phaseElement,
        })[id as 'loadingMessage'] ?? undefined,
        querySelector: (selector: string) => selector === '.track' ? track : selector === '.bar' ? bar : undefined,
      },
    );

    progress.report(
      'Scanned 120 folders · found 300 reviewable files',
      'restore',
      { percent: 42, etaSeconds: 75, estimated: true },
    );

    messageListener?.({ data: vscodeMockState.panel?.webview.messages.at(-1) });

    expect(vscodeMockState.panel?.webview.messages.at(-1)).toEqual({
      type: 'loadingProgress',
      message: 'Scanned 120 folders · found 300 reviewable files',
      stage: 'restore',
      metrics: { percent: 42, etaSeconds: 75, estimated: true },
    });
    expect(messageElement.textContent).toBe('Scanned 120 folders · found 300 reviewable files');
    expect(phaseElement.textContent).toBe('Restore progress');
    expect(trackClasses.has('determinate')).toBe(true);
    expect(bar.style.width).toBe('42%');
    expect(percentElement.textContent).toBe('≈42%');
    expect(etaElement.textContent).toBe('About 1:15 remaining');
  });

  it('follows the configured Chinese UI language', () => {
    vscodeMockState.language = 'zh-CN';

    WorkbenchPanel.createLoading('正在查找当前分支关联的 PR…');

    expect(vscodeMockState.panel?.webview.html).toContain('正在加载 AI Coding Review');
    expect(vscodeMockState.panel?.webview.html).toContain('发现文件');
    expect(vscodeMockState.panel?.webview.html).toContain('预计剩余 {0}');
  });
});