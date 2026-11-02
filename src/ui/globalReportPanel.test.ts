import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetVscodeMock, vscodeMockState } from '../test/vscodeMock';
import { GlobalReportPanel } from './globalReportPanel';

describe('GlobalReportPanel locate messages', () => {
  afterEach(() => resetVscodeMock());

  it('forwards stable finding references for verdict locations', () => {
    const onLocate = vi.fn();
    GlobalReportPanel.show({
      conclusion: 'A file-level claim was overturned.',
      recommendation: 'approve',
      evidence: [],
      verdicts: [{
        kind: 'flip',
        title: 'Key is guaranteed',
        before: 'The key may be absent.',
        after: 'The producer always includes the key.',
        file: 'config_cmd.py',
        line: 157,
        findingRef: 'finding-stable',
      }],
      fixSpots: [],
    }, false, {
      onLocate,
      onConfirm: () => undefined,
    });

    expect(vscodeMockState.panel?.webview.html).toContain(
      'data-finding-ref="finding-stable"',
    );
    vscodeMockState.panel?.webview.receiveMessage({
      type: 'locate',
      file: 'config_cmd.py',
      line: 157,
      findingRef: 'finding-stable',
    });

    expect(onLocate).toHaveBeenCalledWith(
      'config_cmd.py',
      157,
      undefined,
      'finding-stable',
    );
  });

  it('renders legacy reports without current gates or mutation controls and rejects old action messages', () => {
    const onConfirm = vi.fn(), onGlobalFix = vi.fn(), onGotoFiles = vi.fn();
    GlobalReportPanel.show({
      conclusion: 'Saved legacy conclusion.', recommendation: 'approve', evidence: ['Historical evidence.'], verdicts: [],
      fixSpots: [{ id: 'spot', file: 'a.ts', line: 1, severity: 'bug', title: 'Historical issue', detail: 'Old observation.' }],
    }, false, { readOnly: true, onLocate: vi.fn(), onConfirm, onGlobalFix, onGotoFiles });
    const panel = vscodeMockState.panel!;
    expect(panel.webview.html).toContain('Legacy technical report');
    expect(panel.webview.html).toContain('Saved legacy conclusion.');
    expect(panel.webview.html).not.toContain('id="confirm"');
    expect(panel.webview.html).not.toContain('class="globalfix"');
    panel.webview.receiveMessage({ type: 'confirm' });
    panel.webview.receiveMessage({ type: 'globalFix', id: 'spot', file: 'a.ts', line: 1 });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onGlobalFix).not.toHaveBeenCalled();
    expect(vscodeMockState.warnings).toHaveLength(2);
    panel.webview.receiveMessage({ type: 'gotoFiles' });
    expect(onGotoFiles).toHaveBeenCalledTimes(1);
  });
});
