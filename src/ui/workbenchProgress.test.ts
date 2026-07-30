import { afterEach, describe, expect, it } from 'vitest';
import { resetVscodeMock, vscodeMockState } from '../test/vscodeMock';
import { withWorkbenchProgress } from './workbenchPanel';

describe('withWorkbenchProgress', () => {
  afterEach(() => resetVscodeMock());

  it('forwards live messages to a native notification before the workbench opens', async () => {
    const result = await withWorkbenchProgress('Loading project', async (progress) => {
      progress.report(
        'Scanned 42 folders · found 120 reviewable files',
        'scan',
        { percent: 42, etaSeconds: 75, estimated: true },
      );
      return 'done';
    });

    expect(result).toBe('done');
    expect(vscodeMockState.progress?.options).toEqual({
      location: 15,
      title: 'Loading project',
      cancellable: false,
    });
    expect(vscodeMockState.progress?.reports).toEqual([
      { message: 'Scanned 42 folders · found 120 reviewable files', increment: 42 },
    ]);
  });
});