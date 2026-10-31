import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { GlobalReport } from '../ai/types';
import { ReviewCoordinator, type ReviewCoordinatorServices, type WorkflowFileResult } from './reviewCoordinator';
import { ReviewSession } from './reviewSession';
import type { PerFileState, ReviewSnapshot, ReviewStore } from './reviewStore';
import type { ReviewWorkflowState } from './reviewWorkflow';

const summary = { candidates: 0, confirmed: 0, dismissed: 0, unresolved: 0 };
const model = { id: 'controlled-unit-model' } as vscode.LanguageModelChat;

async function fixture(paths = ['src/a.ts']) {
  const saved = new Map<string, PerFileState>();
  const snapshots: ReviewSnapshot[] = [];
  const store: ReviewStore = {
    load: async () => undefined, clear: async () => {},
    save: vi.fn(async (value) => { snapshots.push(structuredClone(value)); }),
    saveFile: vi.fn(async (_repo, path, value) => { saved.set(path, structuredClone(value)); }),
  };
  const session = new ReviewSession(store, 'fixture');
  await session.start({ scopeId: 'controlled', label: 'Controlled fixture', headSha: 'live', files: paths.map((path) => ({ path })) }, '/fixture');
  await session.enableWorkflow();
  const services: ReviewCoordinatorServices = {
    model: vi.fn(async () => model),
    repositoryStamp: vi.fn(async () => 'code-v1'),
    validateHashes: vi.fn(async () => true),
    analyzeFile: vi.fn(async (path): Promise<WorkflowFileResult> => {
      session.setRootedFindings(path, { [path]: [] }, summary, [path]);
      return { kind: 'analyzed', hashes: { [path]: 'source-v1' }, summary, complete: true };
    }),
    analyzeGlobal: vi.fn(async (_model: vscode.LanguageModelChat, state: ReviewWorkflowState): Promise<GlobalReport> => ({
      conclusion: 'Controlled unit response', recommendation: 'comment', evidence: [], verdicts: [], fixSpots: [],
      business: {
        chains: [], concerns: [], limitations: [],
        requirements: state.understanding.requirements.filter((item) => item.included).map((item) => ({
          requirementId: item.id, status: 'unknown', critical: false, rationale: 'Controlled protocol test.', evidence: [],
        })),
      },
    })),
    applyGlobal: async (report) => { session.setGlobalReport(report); },
    showSource: vi.fn(), changed: vi.fn(), notice: vi.fn(), errorText: (error) => String(error),
  };
  const coordinator = new ReviewCoordinator(session, services);
  return { coordinator, session, services, store, saved, snapshots };
}

describe('real review coordination', () => {
  it('uses explicit human requirements verbatim and never fakes line reading', async () => {
    const { coordinator, session, services } = await fixture();
    try {
      await coordinator.putText('Human rule', 'Return the supplied value unchanged.', true);
      await vi.waitFor(() => expect(session.workflow?.understanding.status).toBe('ready'));
      expect(services.model).not.toHaveBeenCalled();
      expect(session.workflow?.understanding.requirements[0].text).toBe('Return the supplied value unchanged.');
      await coordinator.run(true, false, session.workflow!.revision);
      expect(session.workflow?.run.status).toBe('completed');
      expect(session.workflow?.run.globalComplete).toBe(true);
      expect(services.analyzeGlobal).toHaveBeenCalledOnce();
      expect(session.totalCoverage().seen).toBe(0);
    } finally { coordinator.dispose(); session.dispose(); }
  });

  it('preserves valid partial feedback without claiming approval', async () => {
    const { coordinator, session, services } = await fixture(['src/a.ts', 'src/b.ts']);
    vi.mocked(services.analyzeFile).mockRejectedValueOnce(new Error('Cannot read first root'));
    try {
      await coordinator.run(false, false, session.workflow!.revision);
      expect(session.workflow?.run.status).toBe('partial');
      expect(session.workflow?.run.completed).toEqual(['src/b.ts']);
      expect(session.workflow?.run.failed[0].error).toContain('Cannot read first root');
      expect(session.workflowBlockers('comment')).toEqual([]);
      expect(session.workflowBlockers('approve').some((item) => item.code === 'incomplete')).toBe(true);
    } finally { coordinator.dispose(); session.dispose(); }
  });

  it('can retry immediately after cancellation and rejects the old late result', async () => {
    const { coordinator, session, services } = await fixture();
    let release!: (result: WorkflowFileResult) => void;
    vi.mocked(services.analyzeFile).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    try {
      const old = coordinator.run(false, false, session.workflow!.revision);
      await vi.waitFor(() => expect(services.analyzeFile).toHaveBeenCalledOnce());
      const oldId = session.workflow!.run.id;
      await coordinator.cancel();
      await coordinator.run(false, false, session.workflow!.revision);
      const newId = session.workflow!.run.id;
      release({ kind: 'analyzed', hashes: { 'src/a.ts': 'obsolete' }, summary, complete: true });
      await old;
      expect(newId).not.toBe(oldId);
      expect(session.workflow?.run.id).toBe(newId);
      expect(session.workflow?.run.hashes['src/a.ts']).toBe('source-v1');
      expect(session.workflow?.run.status).toBe('completed');
    } finally { coordinator.dispose(); session.dispose(); }
  });

  it('reuses only valid completed roots and genuinely reruns an explicitly selected root', async () => {
    const { coordinator, session, services } = await fixture(['src/a.ts', 'src/b.ts']);
    vi.mocked(services.analyzeGlobal).mockRejectedValueOnce(new Error('Transient global failure'));
    try {
      await coordinator.run(false, false, session.workflow!.revision);
      expect(session.workflow?.run.status).toBe('partial');
      await coordinator.run(false, true, session.workflow!.revision);
      expect(services.analyzeFile).toHaveBeenCalledTimes(2);
      expect(session.workflow?.run.status).toBe('completed');
      await coordinator.run(false, true, session.workflow!.revision, new Set(['src/a.ts']));
      expect(services.analyzeFile).toHaveBeenCalledTimes(3);
      expect(session.workflow?.run.completed.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    } finally { coordinator.dispose(); session.dispose(); }
  });

  it('does not reuse roots after the repository snapshot changes', async () => {
    const { coordinator, session, services } = await fixture();
    try {
      await coordinator.run(false, false, session.workflow!.revision);
      vi.mocked(services.repositoryStamp).mockResolvedValue('code-v2');
      await coordinator.run(false, true, session.workflow!.revision);
      expect(services.analyzeFile).toHaveBeenCalledTimes(2);
    } finally { coordinator.dispose(); session.dispose(); }
  });

  it('does not mark truncated primary source or failed persistence complete', async () => {
    const first = await fixture();
    vi.mocked(first.services.analyzeFile).mockResolvedValue({
      kind: 'analyzed', hashes: { 'src/a.ts': 'prefix' }, summary, complete: false,
    });
    try {
      await first.coordinator.run(false, false, first.session.workflow!.revision);
      expect(first.session.workflow?.run.status).toBe('partial');
    } finally { first.coordinator.dispose(); first.session.dispose(); }
    const second = await fixture();
    vi.mocked(second.store.saveFile!).mockRejectedValue(new Error('Disk unavailable'));
    try {
      await second.coordinator.run(false, false, second.session.workflow!.revision);
      expect(second.session.workflow?.run.status).toBe('partial');
      expect(second.services.notice).toHaveBeenCalledWith(expect.stringContaining('Disk unavailable'), true);
    } finally { second.coordinator.dispose(); second.session.dispose(); }
  });

  it('invalidates results when evidence validation fails before submission', async () => {
    const { coordinator, session, services } = await fixture();
    try {
      await coordinator.run(false, false, session.workflow!.revision);
      vi.mocked(services.validateHashes).mockResolvedValue(false);
      await expect(coordinator.validateCurrentResults()).rejects.toThrow('staleResults');
      expect(session.workflow?.run.status).toBe('stale');
    } finally { coordinator.dispose(); session.dispose(); }
  });
});
