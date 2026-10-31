import { describe, expect, it, vi } from 'vitest';
import type { GlobalReport } from '../ai/types';
import type { ReviewSet } from '../scope/types';
import { ReviewSession } from './reviewSession';
import type { PerFileState, ReviewKey, ReviewSnapshot, ReviewStore } from './reviewStore';
import {
  beginWorkflowRun, contentSignature, finishWorkflowRun, putRequirementMaterial, recordWorkflowFile,
} from './reviewWorkflow';

const reviewSet: ReviewSet = {
  scopeId: 'files-selected', label: 'Selected sources', headSha: 'live',
  files: [{ path: 'src/example.ts' }],
};

const report: GlobalReport = {
  conclusion: 'The available evidence is consistent.', recommendation: 'comment',
  evidence: [], verdicts: [], fixSpots: [],
};

function memoryStore() {
  const scopes = new Map<string, ReviewSnapshot>();
  const files = new Map<string, PerFileState>();
  const keyOf = (key: ReviewKey) => JSON.stringify([key.repo, key.scopeId, key.headSha]);
  const store: ReviewStore = {
    load: async (key) => {
      const value = scopes.get(keyOf(key));
      return value ? structuredClone(value) : undefined;
    },
    findLatestForScope: async (repo, scopeId) => {
      const value = [...scopes.values()].filter((item) => item.repo === repo && item.scopeId === scopeId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      return value ? structuredClone(value) : undefined;
    },
    save: async (snapshot) => { scopes.set(keyOf(snapshot), structuredClone(snapshot)); },
    clear: async (key) => { scopes.delete(keyOf(key)); },
    loadFiles: async (repo, paths) => {
      const result = new Map<string, PerFileState>();
      for (const path of paths) {
        const value = files.get(`${repo}\0${path}`);
        if (value) result.set(path, structuredClone(value));
      }
      return result;
    },
    saveFile: async (repo, path, state) => { files.set(`${repo}\0${path}`, structuredClone(state)); },
    clearFile: async (repo, path) => { files.delete(`${repo}\0${path}`); },
  };
  return { store, scopes, files };
}

async function reviewed(session: ReviewSession, partial = false) {
  await session.updateWorkflow((state) => beginWorkflowRun(state, false, 'test-model'));
  session.setFindings('src/example.ts', []);
  session.setGlobalReport(report);
  await session.updateWorkflow((state) => {
    recordWorkflowFile(state, state.run.id, 'src/example.ts', { 'src/example.ts': contentSignature('actual source') });
    finishWorkflowRun(state, state.run.id, partial ? ['src/example.ts', 'src/not-reviewed.ts'] : ['src/example.ts'], {
      chains: [], requirements: [], concerns: [], limitations: [],
    });
  });
}

describe('persisted vNext review workflow', () => {
  it('reopens a finding when its draft comment is removed', async () => {
    const { store } = memoryStore();
    const session = new ReviewSession(store, 'project');
    await session.start(reviewSet, '/workspace/project');
    await session.enableWorkflow();
    session.setFindings('src/example.ts', [{ id: 'f0', line: 1, title: 'Issue', detail: 'Details', severity: 'bug' }]);
    session.addPendingComment({ id: 'draft', path: 'src/example.ts', startLine: 1, endLine: 1, body: 'Feedback', source: 'finding', createdAt: 1 });
    session.setFindingDisposition('src/example.ts', 'f0', { kind: 'commented', ref: 'draft', at: 1 });
    session.removePendingComment('draft');
    expect(session.findingDisposition('src/example.ts', 'f0')).toBeUndefined();
    session.dispose();
  });
  it('does not let an older asynchronous scope load overwrite a newer repository', async () => {
    const { store } = memoryStore();
    const session = new ReviewSession(store, 'project');
    let release!: (value: ReviewSnapshot | undefined) => void;
    const load = vi.spyOn(store, 'load');
    load.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = session.start(reviewSet, '/first/project');
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    await session.start({ ...reviewSet, scopeId: 'new-scope' }, '/second/project');
    release(undefined);
    await expect(first).rejects.toThrow('staleResult');
    expect(session.getCwd()).toBe('/second/project');
    expect(session.snapshot?.scopeId).toBe('new-scope');
    session.dispose();
  });

  it('retains original materials across commit changes without carrying forward approval or draft inline anchors', async () => {
    const { store } = memoryStore();
    const first = new ReviewSession(store, 'project');
    await first.start({ ...reviewSet, headSha: 'first-commit' }, '/workspace/project');
    await first.enableWorkflow();
    await first.updateWorkflow((state) => {
      putRequirementMaterial(state, { kind: 'human', label: 'Contract', text: 'Keep one effect.' });
    });
    first.addPendingComment({ id: 'draft', path: 'src/example.ts', startLine: 1, endLine: 1, body: 'Old anchor', source: 'manual', createdAt: 1 });
    await first.persist();
    const restored = new ReviewSession(store, 'project');
    await restored.start({ ...reviewSet, headSha: 'second-commit' }, '/workspace/project');
    await restored.enableWorkflow();
    expect(restored.workflow?.materials[0].snapshots[0].text).toBe('Keep one effect.');
    expect(restored.conclusion).toBeUndefined();
    expect(restored.pendingComments).toEqual([]);
    first.dispose(); restored.dispose();
  });

  it('archives prior exemptions when their context changes, while preserving reading progress and annotations', async () => {
    const { store } = memoryStore();
    const session = new ReviewSession(store, 'project');
    await session.start(reviewSet, '/workspace/project');
    await session.enableWorkflow();
    await session.prepareWorkflowDispositions('old-context');
    session.setFindings('src/example.ts', [{ id: 'f0', line: 1, anchor: 'effect();', severity: 'bug', title: 'Effect', detail: 'Old failure.' }]);
    session.setFindingDisposition('src/example.ts', 'f0', { kind: 'ignored', reason: 'Previously accepted boundary.', at: 1 });
    session.setTotalLines('src/example.ts', 2);
    session.markSeen('src/example.ts', [1]);
    session.addAnnotation('src/example.ts', { id: 'note', kind: 'note', startLine: 1, endLine: 1, sourceText: 'effect();', content: 'Keep this note.', createdAt: 1 });
    await session.prepareWorkflowDispositions('new-context');
    expect(session.findingDisposition('src/example.ts', 'f0')).toBeUndefined();
    expect(session.snapshot?.dispositionHistory?.[0].files['src/example.ts'].dispositions.f0.reason).toBe('Previously accepted boundary.');
    expect(session.fileState('src/example.ts')?.seenLines).toEqual([1]);
    expect(session.annotations('src/example.ts')[0].content).toBe('Keep this note.');
    session.dispose();
  });

  it('does not reuse a disposition for a differently explained failure at the same statement', async () => {
    const { store } = memoryStore();
    const session = new ReviewSession(store, 'project');
    await session.start(reviewSet, '/workspace/project');
    await session.enableWorkflow();
    const issue = { id: 'f0', line: 1, anchor: 'effect();', severity: 'bug' as const, title: 'Effect', detail: 'First failure mechanism.' };
    session.setFindings('src/example.ts', [issue]);
    session.setFindingDisposition('src/example.ts', 'f0', { kind: 'ignored', reason: 'Only the first case was accepted.', at: 1 });
    session.setFindings('src/example.ts', [{ ...issue, detail: 'A different failure mechanism.' }]);
    expect(session.findingDisposition('src/example.ts', 'f0')).toBeUndefined();
    expect(session.snapshot?.dispositionHistory?.at(-1)?.files['src/example.ts'].dispositions.f0.reason).toBe('Only the first case was accepted.');
    session.dispose();
  });
  it('does not promote a legacy approval into a new requirement-aware approval', async () => {
    const { store, scopes } = memoryStore();
    const conclusion = { verdict: 'approve' as const, label: 'Approved', target: 'local' as const, submittedAt: 1 };
    const legacy: ReviewSnapshot = {
      repo: 'project', scopeId: reviewSet.scopeId, headSha: 'live',
      perFile: {}, globalDone: true, globalReport: report, conclusion, updatedAt: 1,
    };
    scopes.set(JSON.stringify(['project', reviewSet.scopeId, 'live']), legacy);
    const session = new ReviewSession(store, 'project');
    await session.start(reviewSet, '/workspace/project');
    await session.enableWorkflow();
    expect(session.gatePassed()).toBe(false);
    expect(session.conclusion).toBeUndefined();
    expect(session.snapshot?.legacyConclusion).toEqual(conclusion);
    expect(session.globalReport).toEqual(report);
    session.dispose();
  });

  it('separates local requirement material for repositories with identical directory names', async () => {
    const { store } = memoryStore();
    const first = new ReviewSession(store, 'project');
    await first.start(reviewSet, '/first/project');
    await first.enableWorkflow();
    await first.updateWorkflow((state) => {
      putRequirementMaterial(state, { kind: 'text', label: 'First project', text: 'Private project requirement.' });
    });
    const second = new ReviewSession(store, 'project');
    await second.start(reviewSet, '/second/project');
    await second.enableWorkflow();
    expect(second.workflow?.materials).toEqual([]);
    const restored = new ReviewSession(store, 'project');
    await restored.start(reviewSet, '/first/project');
    await restored.enableWorkflow();
    expect(restored.workflow?.materials[0].label).toBe('First project');
    first.dispose();
    second.dispose();
    restored.dispose();
  });

  it('rolls back a failed metadata write instead of claiming a persisted change', async () => {
    const { store } = memoryStore();
    const session = new ReviewSession(store, 'project');
    await session.start(reviewSet, '/workspace/project');
    await session.enableWorkflow();
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(session.updateWorkflow((state) => { state.notes = 'Unsaved statement'; })).rejects.toThrow('Disk unavailable');
    expect(session.workflow?.notes).toBe('');
    session.dispose();
  });

  it('does not require a separate global confirmation or manual line scrolling', async () => {
    const { store } = memoryStore();
    const session = new ReviewSession(store, 'project');
    await session.start(reviewSet, '/workspace/project');
    await session.enableWorkflow();
    await reviewed(session);
    expect(session.globalConfirmed).toBe(false);
    expect(session.totalCoverage().seen).toBe(0);
    expect(session.gatePassed()).toBe(true);
    session.setConclusion({ verdict: 'approve', label: 'Approved', target: 'local', submittedAt: 1 });
    expect(session.conclusion?.verdict).toBe('approve');
    session.dispose();
  });

  it('enforces different approval and feedback conditions below the UI', async () => {
    const { store } = memoryStore();
    const session = new ReviewSession(store, 'project');
    await session.start(reviewSet, '/workspace/project');
    await session.enableWorkflow();
    await reviewed(session, true);
    expect(session.gatePassed()).toBe(false);
    expect(session.workflowBlockers('comment')).toEqual([]);
    session.setConclusion({ verdict: 'comment', label: 'Comment', target: 'local', submittedAt: 1 });
    expect(session.conclusion?.verdict).toBe('comment');
    expect(() => session.setConclusion({ verdict: 'approve', label: 'Approved', target: 'local', submittedAt: 2 })).toThrow('incomplete');
    session.dispose();
  });

  it('invalidates an approved run when its source changes', async () => {
    const { store } = memoryStore();
    const session = new ReviewSession(store, 'project');
    await session.start(reviewSet, '/workspace/project');
    await session.enableWorkflow();
    await reviewed(session);
    session.setConclusion({ verdict: 'approve', label: 'Approved', target: 'local', submittedAt: 1 });
    session.invalidateAfterFileChange('src/example.ts');
    expect(session.workflow?.run.status).toBe('stale');
    expect(session.conclusion).toBeUndefined();
    expect(session.workflowBlockers('comment').some((item) => item.code === 'staleResults')).toBe(true);
    session.dispose();
  });

  it('does not send large requirement-state updates for ordinary seen-line progress', async () => {
    vi.useFakeTimers();
    const { store } = memoryStore();
    const session = new ReviewSession(store, 'project');
    try {
      await session.start(reviewSet, '/workspace/project');
      await session.enableWorkflow();
      session.setTotalLines('src/example.ts', 3);
      const version = session.reviewContentVersion;
      session.markSeen('src/example.ts', [1, 2]);
      expect(session.reviewContentVersion).toBe(version);
      await session.updateWorkflow((state) => { state.stage = 'review'; }, false);
      expect(session.reviewContentVersion).toBeGreaterThan(version);
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });

  it('does not restore completion if the corresponding file analysis was not persisted', async () => {
    const { store, files } = memoryStore();
    const session = new ReviewSession(store, 'project');
    await session.start(reviewSet, '/workspace/project');
    await session.enableWorkflow();
    await reviewed(session);
    await session.persist();
    files.clear();
    const restored = new ReviewSession(store, 'project');
    await restored.start(reviewSet, '/workspace/project');
    await restored.enableWorkflow();
    expect(restored.workflow?.run.status).toBe('stale');
    expect(restored.gatePassed()).toBe(false);
    session.dispose();
    restored.dispose();
  });
});
