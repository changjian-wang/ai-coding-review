import type * as vscode from 'vscode';
import { ReviewSession } from '../review/reviewSession';
import { WorkspaceStateReviewStore } from '../review/reviewStore';
import {
  businessBaseline, businessHash, businessCitations, createBusinessRun, parseBusinessDiscovery,
  parseBusinessVerification, segmentBusinessEvidence,
} from '../review/businessReview';
import {
  acceptRequirementUnderstanding, addRequirementMaterial, confirmRequirements, createRequirementsDraft,
  parseRequirementUnderstanding, requirementScopeKey,
} from '../review/requirements';
import type { ReviewSet } from '../scope/types';

export async function reviewCenterFixture(options: { pr?: boolean; defect?: boolean } = {}) {
  const entries = new Map<string, unknown>();
  const memento: vscode.Memento = {
    keys: () => [...entries.keys()],
    get: <T>(key: string, fallback?: T) => entries.has(key) ? entries.get(key) as T : fallback,
    update: async (key, value) => { entries.set(key, structuredClone(value)); },
  };
  const store = new WorkspaceStateReviewStore(memento);
  const session = new ReviewSession(store, 'fixture');
  const cwd = 'C:\\review-center-fixture';
  const set: ReviewSet = {
    scopeId: options.pr === false ? 'branch-fixture' : 'pr-42', label: 'Controlled review fixture', headSha: 'a'.repeat(40),
    repositoryIdentity: 'github.com/example/review-center-fixture',
    source: { kind: 'commit', headRef: 'feature', baseRef: 'main', baseTipSha: 'b'.repeat(40) },
    comparison: { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
    files: [{ path: 'src/restore.ts', status: 'modified' }, { path: 'src/api.ts', status: 'modified' }],
  };
  await session.start(set, cwd);
  const draft = createRequirementsDraft();
  const rule = 'Reserve inventory before restoring an order.';
  const sourceId = addRequirementMaterial(draft, { kind: 'paste', name: 'Order contract', location: 'User input', format: 'markdown', text: rule });
  const scope = requirementScopeKey(cwd, set);
  acceptRequirementUnderstanding(draft, parseRequirementUnderstanding({
    summary: 'Order and inventory lifecycle.', requirements: [{
      id: 'RQ-1', title: 'Reserve before restore', text: rule, origins: [{ sourceId, version: 1, line: 1, endLine: 1, quote: rule }],
    }], checks: [], questions: [],
  }, draft, scope, 'controlled-model'));
  confirmRequirements(draft, scope, true);
  await session.setRequirements(draft);
  const text = options.defect === false
    ? 'export async function restore(order) {\n  await inventory.reserve(order.id);\n  await order.restore();\n}\n'
    : 'export async function restore(order) {\n  await order.restore();\n}\n';
  const source = segmentBusinessEvidence({ kind: 'code', side: 'head', path: 'src/restore.ts', sourceHash: businessHash(text), text });
  const citation = { evidenceId: source[0].id, quote: 'await order.restore();' };
  const refs = businessCitations([citation], source);
  const baseline = businessBaseline(cwd, set, draft);
  const run = createBusinessRun(baseline, 'controlled-model');
  run.status = 'completed'; run.globalCompleted = true; run.calls = 5; run.finishedAt = Date.now();
  run.units = [{ id: 'U-1', goal: 'Order restoration', files: set.files.map((file) => file.path), requirementIds: ['RQ-1'] }];
  run.unitSummaries = [{ id: 'U-1-0', text: 'Controlled fixture summary.', evidenceIds: [source[0].id] }];
  run.coverage = set.files.flatMap((file) => (['head', 'base'] as const).map((side) => ({
    path: file.path, side, characters: text.length, hash: businessHash(text),
    reviewed: [{ start: 0, end: text.length }], status: 'reviewed' as const,
  })));
  run.dependencies = Object.fromEntries(run.coverage.map((file) => [`${file.side}:${file.path}`, file.hash!]));
  if (options.defect !== false) {
    run.candidates = parseBusinessDiscovery({
      summary: 'Reservation gap.', requests: [], candidates: [{
        kind: 'implementation', title: 'Restore omits inventory reservation', cause: 'The order lifecycle does not close the stock lifecycle',
        trigger: 'Restore a cancelled order', impact: 'Stock may be promised twice', requirementIds: ['RQ-1'], evidence: [citation],
      }],
    }, source, baseline, 'global-0').candidates;
    run.findings = parseBusinessVerification({ decisions: [{
      candidateIds: run.candidates.map((candidate) => candidate.id), kind: 'implementation', status: 'confirmed', severity: 'high', attribution: 'unknown',
      title: 'Restore omits inventory reservation', cause: 'The order lifecycle does not close the stock lifecycle',
      trigger: 'Restore a cancelled order', impact: 'Stock may be promised twice', requirementIds: ['RQ-1'],
      evidence: [citation], counterEvidence: [], counterRationale: 'Controlled fixture contract requires reservation here.', critical: null,
    }] }, run.candidates, source, baseline);
  }
  run.requirements = [{ id: 'RQ-1', status: options.defect === false ? 'supported' : 'violated', rationale: 'Controlled source assessment.', evidence: refs, critical: null }];
  await session.setBusinessReview(run);
  return { session, store, memento, entries, cwd, set, run, draft, refs, text };
}
