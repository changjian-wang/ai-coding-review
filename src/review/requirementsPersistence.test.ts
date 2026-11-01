import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ReviewSession } from './reviewSession';
import { WorkspaceStateReviewStore } from './reviewStore';
import {
  acceptRequirementUnderstanding, addRequirementMaterial, clearRequirementConfirmation, confirmRequirements,
  createRequirementsDraft, parseRequirementUnderstanding, requirementScopeKey, updateRequirementMaterial,
} from './requirements';
import type { ReviewSet } from '../scope/types';
import { reviewCenterFixture } from '../test/reviewCenterFixture';

function storeFixture() {
  const entries = new Map<string, unknown>();
  const state: vscode.Memento = {
    keys: () => [...entries.keys()],
    get: <T>(key: string, fallback?: T) => entries.has(key) ? entries.get(key) as T : fallback,
    update: async (key, value) => { entries.set(key, structuredClone(value)); },
  };
  return { store: new WorkspaceStateReviewStore(state), entries };
}

const cwd = 'C:\\requirements-repo';
const set: ReviewSet = { scopeId: 'pr-1', label: 'PR', headSha: 'a'.repeat(40), files: [{ path: 'a.ts' }], source: { kind: 'commit', headRef: 'feature' } };

function confirmedDraft() {
  const draft = createRequirementsDraft();
  const id = addRequirementMaterial(draft, { kind: 'paste', name: 'Rule', location: 'User', text: 'Charge once.', format: 'markdown' });
  const scopeKey = requirementScopeKey(cwd, set);
  const parsed = parseRequirementUnderstanding({
    summary: 'Review charge consistency.',
    requirements: [{ id: 'RQ-1', title: 'Charge once', text: 'Charge once.', origins: [{ sourceId: id, version: 1, line: 1, endLine: 1, quote: 'Charge once.' }] }],
    checks: [], questions: [],
  }, draft, scopeKey, 'model');
  acceptRequirementUnderstanding(draft, parsed);
  confirmRequirements(draft, scopeKey, true);
  return draft;
}

describe('requirement baseline persistence and technical conclusions', () => {
  it('rolls back active requirements and the business report if the awaited metadata save fails', async () => {
    const { session, store } = await reviewCenterFixture({ defect: false });
    const previous = structuredClone(session.requirements);
    const next = structuredClone(session.requirements!);
    updateRequirementMaterial(next, next.materials[0].id, 'A replacement requirement.');
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(session.setRequirements(next)).rejects.toThrow('Disk unavailable');
    expect(session.requirements).toEqual(previous);
    expect(session.businessReview?.status).toBe('completed');
    expect(session.canSubmitConclusion('approve')).toBe(true);
    session.dispose();
  });

  it('does not resurrect a completed report when code changes during a failed requirement write', async () => {
    const { session, store } = await reviewCenterFixture({ defect: false });
    const next = structuredClone(session.requirements!);
    updateRequirementMaterial(next, next.materials[0].id, 'A replacement requirement.');
    let reject!: (error: Error) => void;
    vi.spyOn(store, 'save').mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const write = session.setRequirements(next);
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
    session.invalidateBusinessReview();
    reject(new Error('Disk unavailable'));
    await expect(write).rejects.toThrow('Disk unavailable');
    expect(session.businessReview?.status).toBe('stale');
    expect(session.canSubmitConclusion('approve')).toBe(false);
    session.dispose();
  });
  it('restores original source, understanding and explicit confirmation for the same immutable scope', async () => {
    const { store } = storeFixture();
    const session = new ReviewSession(store, 'repo');
    await session.start(set, cwd);
    const draft = confirmedDraft();
    await session.setRequirements(draft);
    const reloaded = new ReviewSession(store, 'repo');
    await reloaded.start(set, cwd);
    expect(reloaded.requirements).toEqual(session.requirements);
    expect(reloaded.requirementStatus).toMatch(/Understanding v1 confirmed/);
    expect(reloaded.requirementStatus).toMatch(/not assessed/);
    session.dispose(); reloaded.dispose();
  });

  it('does not approve requirement satisfaction using the old technical analyzer, while allowing bounded feedback', async () => {
    const { store } = storeFixture();
    const session = new ReviewSession(store, 'repo');
    await session.start(set, cwd);
    await session.setRequirements(confirmedDraft());
    session.setFindings('a.ts', []);
    session.setGlobalReport({ conclusion: 'Technical scope checked', recommendation: 'approve', evidence: [], verdicts: [], fixSpots: [] });
    session.confirmGlobal();
    expect(session.technicalGatePassed()).toBe(true);
    expect(session.gatePassed()).toBe(false);
    expect(session.canSubmitConclusion('approve')).toBe(false);
    expect(session.canSubmitConclusion('comment')).toBe(true);
    expect(session.canSubmitConclusion('request-changes')).toBe(true);
    session.dispose();
  });

  it('requires an explicit technical-only choice to omit unprocessed material from a technical approval', async () => {
    const { store } = storeFixture();
    const session = new ReviewSession(store, 'repo');
    await session.start(set, cwd);
    const draft = confirmedDraft();
    clearRequirementConfirmation(draft);
    draft.technicalOnly = true;
    await session.setRequirements(draft);
    session.setFindings('a.ts', []);
    session.setGlobalReport({ conclusion: 'Technical scope checked', recommendation: 'approve', evidence: [], verdicts: [], fixSpots: [] });
    session.confirmGlobal();
    expect(session.canSubmitConclusion('approve')).toBe(true);
    expect(session.requirementStatus).toMatch(/Requirement consistency not assessed/);
    session.setConclusion({ verdict: 'approve', label: 'Technical only', target: 'local', submittedAt: 1 });
    draft.technicalOnly = false;
    await session.setRequirements(draft);
    expect(session.conclusion).toBeUndefined();
    expect(session.globalConfirmed).toBe(false);
    updateRequirementMaterial(draft, draft.materials[0].id, 'A new requirement.');
    expect(draft.technicalOnly).toBe(false);
    await session.setRequirements(draft);
    expect(session.globalConfirmed).toBe(false);
    expect(session.canSubmitConclusion('approve')).toBe(false);
    session.dispose();
  });

  it('invalidates an old conclusion when the material changes, without overwriting original snapshots', async () => {
    const { store } = storeFixture();
    const session = new ReviewSession(store, 'repo');
    await session.start(set, cwd);
    const draft = confirmedDraft();
    await session.setRequirements(draft);
    session.setConclusion({ verdict: 'comment', label: 'Old feedback', target: 'local', submittedAt: 1 });
    updateRequirementMaterial(draft, draft.materials[0].id, 'Revised source.');
    await session.setRequirements(draft);
    expect(session.conclusion).toBeUndefined();
    expect(session.requirements?.confirmation).toBeUndefined();
    expect(session.requirements?.materials[0].versions[0].text).toBe('Charge once.');
    expect(session.requirements?.understandingHistory).toEqual(draft.understandingHistory);
    session.dispose();
  });

  it('keeps preparation drafts independent from PR analysis snapshots and reports invalid stored records', async () => {
    const { store, entries } = storeFixture();
    const draft = confirmedDraft();
    await store.saveRequirementPreparation('repo-1', { draft, selection: { cwd, kind: 'pr', prNumber: 1 } });
    expect((await store.loadRequirementPreparation('repo-1'))?.draft.materials[0].versions[0].text).toBe('Charge once.');
    expect(await store.loadRequirementPreparation('repo-2')).toBeUndefined();
    entries.set('codereview.requirementPreparation.v1:invalid', { draft: { version: 999 } });
    await expect(store.loadRequirementPreparation('invalid')).rejects.toThrow();
    expect(entries.get('codereview.requirementPreparation.v1:invalid')).toEqual({ draft: { version: 999 } });
  });
});
