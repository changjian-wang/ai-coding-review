import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { ReviewSession } from './reviewSession';
import { WorkspaceStateReviewStore } from './reviewStore';
import { businessBaseline, businessHash, createBusinessRun, type BusinessFinding } from './businessReview';
import { createRequirementsDraft } from './requirements';
import type { ReviewSet } from '../scope/types';

const cwd = 'C:\\business-review';
const set: ReviewSet = { scopeId: 'sources', label: 'Sources', headSha: 'live', files: [{ path: 'pay.ts' }] };

function fixture() {
  const entries = new Map<string, unknown>();
  const state: vscode.Memento = {
    keys: () => [...entries.keys()],
    get: <T>(key: string, fallback?: T) => entries.has(key) ? entries.get(key) as T : fallback,
    update: async (key, value) => { entries.set(key, structuredClone(value)); },
  };
  const store = new WorkspaceStateReviewStore(state);
  return { store, session: new ReviewSession(store, 'repo') };
}

function completeRun() {
  const run = createBusinessRun(businessBaseline(cwd, set), 'controlled-model');
  run.status = 'completed'; run.finishedAt = Date.now(); run.globalCompleted = true;
  run.coverage = [{ path: 'pay.ts', side: 'head', characters: 10, reviewed: [{ start: 0, end: 10 }], status: 'reviewed' }];
  run.units = [{ id: 'U-1', goal: 'Payment outcomes', files: ['pay.ts'], requirementIds: [] }];
  run.unitSummaries = [{ id: 'U-1-0', text: 'Read the actual source.', evidenceIds: [] }];
  run.dependencies = { 'head:pay.ts': businessHash('0123456789'), 'head:gateway.ts': businessHash('gateway') };
  return run;
}

function finding(): BusinessFinding {
  return {
    id: 'payment-outcome', candidateIds: ['global-0-0'], kind: 'implementation', status: 'confirmed', severity: 'high', attribution: 'unknown',
    title: 'Unknown outcome is treated as definitive failure', cause: 'Timeout does not cancel the original payment',
    trigger: 'A late successful charge follows an immediate retry', impact: 'Duplicate payment',
    requirementIds: [], evidence: [], counterEvidence: [], counterRationale: 'A retry safeguard was not established.', critical: null,
  };
}

describe('business review session gates and persistence', () => {
  it('uses actual M3 coverage rather than human scroll flags and requires a fresh report confirmation', async () => {
    const { session } = fixture();
    await session.start(set, cwd);
    await session.setBusinessReview(completeRun());
    expect(session.totalCoverage().seen).toBe(0);
    expect(session.technicalGatePassed()).toBe(false);
    expect(session.canSubmitConclusion('comment')).toBe(true);
    expect(session.canSubmitConclusion('approve')).toBe(false);
    session.confirmBusinessReview();
    expect(session.canSubmitConclusion('approve')).toBe(true);
    await session.setBusinessReview(completeRun());
    expect(session.canSubmitConclusion('approve')).toBe(false);
    session.dispose();
  });

  it('never treats a handling note as repairing a verified defect or answering a critical question', async () => {
    const { session } = fixture();
    await session.start(set, cwd);
    const run = completeRun();
    run.findings.push(finding());
    await session.setBusinessReview(run);
    session.recordBusinessNote('payment-outcome', 'A response was drafted, not a fix.');
    session.confirmBusinessReview();
    expect(session.businessReview?.findings[0].status).toBe('confirmed');
    expect(session.canSubmitConclusion('approve')).toBe(false);
    expect(session.canSubmitConclusion('request-changes')).toBe(true);
    const critical = completeRun();
    critical.findings = [{
      ...finding(), kind: 'question', status: 'unresolved',
      critical: { dependsOn: 'Retry safety', impact: 'Duplicate payment', missingEvidence: 'Provider timeout contract', question: 'Can a charge settle after timeout?' },
    }];
    await session.setBusinessReview(critical);
    session.recordBusinessNote('payment-outcome', 'Reviewer has read the uncertainty.');
    session.confirmBusinessReview();
    expect(session.canSubmitConclusion('approve')).toBe(false);
    session.dispose();
  });

  it.each(['partial', 'failed', 'cancelled', 'stale', 'running'] as const)('never approves a %s workflow even when a persisted human flag is true', async (status) => {
    const { session } = fixture();
    await session.start(set, cwd);
    const run = completeRun();
    run.status = status; run.confirmed = true;
    await session.setBusinessReview(run);
    expect(session.canSubmitConclusion('approve')).toBe(false);
    expect(session.canSubmitConclusion('comment')).toBe(status !== 'stale' && status !== 'running');
    session.dispose();
  });

  it.each(['file', 'global', 'dependency'] as const)('invalidates an old M3 result after a %s update instead of letting legacy analysis bypass it', async (change) => {
    const { session } = fixture();
    await session.start(set, cwd);
    const run = completeRun();
    run.confirmed = true;
    await session.setBusinessReview(run);
    session.setConclusion({ verdict: 'approve', label: 'Approved', target: 'local', submittedAt: 1 });
    if (change === 'file') session.setFindings('pay.ts', []);
    else if (change === 'global') session.setGlobalReport({ conclusion: 'New evidence', recommendation: 'comment', evidence: [], verdicts: [], fixSpots: [] });
    else session.invalidateAfterFileChange('gateway.ts');
    expect(session.businessReview?.status).toBe('stale');
    expect(session.conclusion).toBeUndefined();
    expect(session.canSubmitConclusion('approve')).toBe(false);
    session.dispose();
  });

  it('preserves old critical information across a baseline change and rejects late writes under its old binding', async () => {
    const { session, store } = fixture();
    await session.start(set, cwd);
    const run = completeRun();
    run.findings = [finding()];
    run.priorCritical = [{ id: 'critical', title: 'Late charge', detail: 'The missing contract must not be forgotten.' }];
    await session.setBusinessReview(run);
    const next = createRequirementsDraft();
    next.technicalOnly = true;
    await session.setRequirements(next);
    expect(session.businessReview?.status).toBe('stale');
    expect(session.businessReview?.priorCritical).toHaveLength(1);
    await expect(session.setBusinessReview(run)).rejects.toThrow(/different baseline/);
    await session.persist();
    const reloaded = new ReviewSession(store, 'repo');
    await reloaded.start(set, cwd);
    expect(reloaded.businessReview?.priorCritical[0].id).toBe('critical');
    expect(reloaded.canSubmitConclusion('approve')).toBe(false);
    session.dispose(); reloaded.dispose();
  });

  it('restores an interrupted workflow as incomplete and retains its reusable exact-input work', async () => {
    const { session, store } = fixture();
    await session.start(set, cwd);
    const run = completeRun();
    run.status = 'running'; run.calls = 1; run.cache = [{ key: 'exact-input', phase: 'plan', value: { units: run.units } }];
    await session.setBusinessReview(run);
    const reloaded = new ReviewSession(store, 'repo');
    await reloaded.start(set, cwd);
    expect(reloaded.businessReview).toMatchObject({ status: 'cancelled', confirmed: false, calls: 1 });
    expect(reloaded.businessReview?.cache).toEqual(run.cache);
    expect(reloaded.businessReview?.errors.join(' ')).toMatch(/interrupted/);
    expect(reloaded.canSubmitConclusion('approve')).toBe(false);
    session.dispose(); reloaded.dispose();
  });

  it('keeps a late GitHub receipt without approving a newer business run or deleting its new draft comments', async () => {
    const { session, store } = fixture();
    await session.start(set, cwd);
    const first = completeRun();
    await session.setBusinessReview(first);
    const snapshot = session.snapshot!;
    const next = completeRun();
    await session.setBusinessReview(next);
    session.addPendingComment({ id: 'new-comment', path: 'pay.ts', startLine: 1, endLine: 1, body: 'New draft', source: 'manual', createdAt: 1 });
    await session.recordPostedConclusion(snapshot, {
      businessRunId: first.id, verdict: 'approve', label: 'Old review submitted', target: 'pr', prNumber: 1, submittedAt: 1,
    }, ['already-submitted-comment']);
    expect(session.businessReview?.id).toBe(next.id);
    expect(session.conclusion).toBeUndefined();
    expect(session.pendingComments.map((comment) => comment.id)).toEqual(['new-comment']);
    expect(session.snapshot?.postedConclusions?.[0].businessRunId).toBe(first.id);
    const reloaded = new ReviewSession(store, 'repo');
    await reloaded.start(set, cwd);
    expect(reloaded.businessReview?.id).toBe(next.id);
    expect(reloaded.snapshot?.postedConclusions).toHaveLength(1);
    expect(reloaded.conclusion).toBeUndefined();
    session.dispose(); reloaded.dispose();
  });

  it('does not apply a legacy receipt to a subsequently started business review', async () => {
    const { session } = fixture();
    await session.start(set, cwd);
    const snapshot = session.snapshot!;
    await session.setBusinessReview(completeRun());
    await session.recordPostedConclusion(snapshot, { verdict: 'approve', label: 'Legacy approval', target: 'pr', prNumber: 1, submittedAt: 1 }, []);
    expect(session.conclusion).toBeUndefined();
    expect(session.snapshot?.postedConclusions).toHaveLength(1);
    session.dispose();
  });
});
