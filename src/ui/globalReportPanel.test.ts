import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetVscodeMock, vscodeMockState } from '../test/vscodeMock';
import { GlobalReportPanel } from './globalReportPanel';

describe('read-only legacy report', () => {
  afterEach(() => resetVscodeMock());

  it('preserves historical source locations as text without opening current source', () => {
    const onGotoFiles = vi.fn();
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
    }, { onGotoFiles });

    expect(vscodeMockState.panel?.webview.html).toContain(
      'config_cmd.py:157',
    );
    vscodeMockState.panel?.webview.receiveMessage({
      type: 'locate',
      file: 'config_cmd.py',
      line: 157,
      findingRef: 'finding-stable',
    });

    expect(onGotoFiles).not.toHaveBeenCalled();
    expect(vscodeMockState.warnings).toHaveLength(1);
  });

  it('renders legacy reports without current gates or mutation controls and rejects old action messages', () => {
    const onGotoFiles = vi.fn();
    GlobalReportPanel.show({
      conclusion: 'Saved legacy conclusion.', recommendation: 'approve', evidence: ['Historical evidence.'], verdicts: [],
      fixSpots: [{ id: 'spot', file: 'a.ts', line: 1, severity: 'bug', title: 'Historical issue', detail: 'Old observation.' }],
    }, { onGotoFiles });
    const panel = vscodeMockState.panel!;
    expect(panel.webview.html).toContain('Legacy technical report');
    expect(panel.webview.html).toContain('Saved legacy conclusion.');
    expect(panel.webview.html).not.toContain('id="confirm"');
    expect(panel.webview.html).not.toContain('class="globalfix"');
    for (const type of ['confirm', 'globalFix', 'globalIgnore', 'globalComment', 'globalRevert', 'locate']) {
      panel.webview.receiveMessage({ type, id: 'spot', file: 'a.ts', line: 1 });
    }
    expect(onGotoFiles).not.toHaveBeenCalled();
    expect(vscodeMockState.warnings).toHaveLength(6);
    panel.webview.receiveMessage({ type: 'gotoFiles' });
    expect(onGotoFiles).toHaveBeenCalledTimes(1);
  });
});
