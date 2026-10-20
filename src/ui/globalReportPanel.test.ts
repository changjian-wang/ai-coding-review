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
});
