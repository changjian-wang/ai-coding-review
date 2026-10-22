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