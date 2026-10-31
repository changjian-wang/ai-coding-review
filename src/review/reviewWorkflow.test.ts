import { describe, expect, it } from 'vitest';
import {
  applyRequirementUnderstanding, beginWorkflowRun, confirmReviewRequirements, contentSignature,
  createReviewWorkflow, currentRequirements, finishWorkflowRun, includeReviewRequirement,
  invalidateWorkflow, materialText, putRequirementMaterial, recordWorkflowFile,
  requirementsConfirmed, restoreReviewWorkflow, reviseReviewRequirement, selectRequirementMaterial,
  workflowGate, workflowResultKey, workflowScopeKey,
  type BusinessReview, type RequirementUnderstanding, type ReviewConcern, type ReviewWorkflowState,
} from './reviewWorkflow';

function prepared() {
  const state = createReviewWorkflow('scope-1', 'repository-1');
  const material = putRequirementMaterial(state, {
    kind: 'text', label: 'Rules', location: 'input:rules',
    text: '# Rules\r\nDo not charge twice.\r\n',
  });
  const understanding: RequirementUnderstanding = {
    revision: state.revision, status: 'ready', summary: 'Protect payment retries.',
    requirements: [{
      id: 'RQ-01', title: 'Single charge', text: 'Retries must not charge twice.',
      basis: 'source', included: true,
      origins: [{ sourceId: material.id, version: 1, line: 2, quote: 'Do not charge twice.' }],
    }],
    checks: [], questions: [],
  };
  applyRequirementUnderstanding(state, understanding, state.scopeKey);
  return { state, material, understanding };
}

function business(state: ReviewWorkflowState, concerns: ReviewConcern[] = []): BusinessReview {
  return {
    chains: [],
    requirements: currentRequirements(state).map((item) => ({
      requirementId: item.id, status: 'satisfied', critical: false,
      rationale: 'Reachable retry path uses a stable request key.', evidence: [],
    })),
    concerns, limitations: [],
  };
}

function complete(state: ReviewWorkflowState, review = business(state)) {
  beginWorkflowRun(state, true, 'model-1');
  const id = state.run.id;
  recordWorkflowFile(state, id, 'src/payment.ts', { 'src/payment.ts': contentSignature('source') });
  finishWorkflowRun(state, id, ['src/payment.ts'], review);
}

describe('human applicability authority', () => {
  it('does not let the model silently exclude a requirement the reviewer included', () => {
    const { state } = prepared();
    const review = business(state);
    review.requirements[0].status = 'not-applicable';
    complete(state, review);
    expect(workflowGate(state, 0).approve.some((item) => item.code === 'applicabilityUnconfirmed')).toBe(true);
    expect(workflowGate(state, 0).feedback).toEqual([]);
  });
});

describe('versioned requirement sources', () => {
  it('preserves raw whitespace, CRLF and historical snapshots', () => {
    const { state, material } = prepared();
    const original = materialText(material);
    putRequirementMaterial(state, {
      kind: 'text', label: 'Rules', location: 'input:rules', text: original + '\r\nNew context.\r\n',
    });
    expect(material.version).toBe(2);
    expect(materialText(material, 1)).toBe('# Rules\r\nDo not charge twice.\r\n');
    expect(materialText(material)).toBe(original + '\r\nNew context.\r\n');
    expect(state.understanding.status).toBe('pending');
    expect(() => confirmReviewRequirements(state)).toThrow('understandingPending');
  });

  it('does not invalidate identical sources and purposes', () => {
    const { state, material } = prepared();
    confirmReviewRequirements(state);
    const revision = state.revision;
    putRequirementMaterial(state, {
      kind: 'text', label: 'Rules', location: 'input:rules', text: materialText(material),
    });
    selectRequirementMaterial(state, material.id, true);
    expect(state.revision).toBe(revision);
    expect(requirementsConfirmed(state)).toBe(true);
  });

  it('checks actual source versions, lines and verbatim quotes', () => {
    const { state, understanding } = prepared();
    for (const change of [
      { version: 2 }, { line: 1 }, { quote: 'Retries are always safe.' }, { quote: 'Do not\ncharge twice.' },
    ]) {
      const invalid = structuredClone(understanding);
      Object.assign(invalid.requirements[0].origins[0], change);
      expect(() => applyRequirementUnderstanding(state, invalid, state.scopeKey)).toThrow('invalidReference');
    }
    expect(state.understanding.requirements[0].origins[0].quote).toBe('Do not charge twice.');
  });

  it('rejects removed and unreferenced materials', () => {
    const { state, material, understanding } = prepared();
    const invalid = structuredClone(understanding);
    invalid.requirements[0].origins = [];
    expect(() => applyRequirementUnderstanding(state, invalid, state.scopeKey)).toThrow('invalidReference');
    selectRequirementMaterial(state, material.id, false);
    invalid.revision = state.revision;
    invalid.requirements[0].origins = understanding.requirements[0].origins;
    expect(() => applyRequirementUnderstanding(state, invalid, state.scopeKey)).toThrow('invalidReference');
    expect(materialText(material)).toContain('Do not charge twice.');
  });

  it('enforces explicit size boundaries without truncating accepted content', () => {
    const state = createReviewWorkflow('scope', 'repo');
    expect(() => putRequirementMaterial(state, { kind: 'text', label: 'Empty', text: ' \r\n' })).toThrow('emptyMaterial');
    expect(() => putRequirementMaterial(state, { kind: 'text', label: 'Oversized', text: 'x'.repeat(64_001) })).toThrow('materialTooLarge');
    const first = putRequirementMaterial(state, { kind: 'text', label: 'First', text: 'x'.repeat(64_000) });
    putRequirementMaterial(state, { kind: 'text', label: 'Second', text: 'y'.repeat(64_000) });
    expect(materialText(first).length).toBe(64_000);
    expect(() => putRequirementMaterial(state, { kind: 'text', label: 'Third', text: 'z' })).toThrow('materialTooLarge');
    expect(state.materials).toHaveLength(2);
  });

  it('refuses late responses and invented checkpoint references', () => {
    const { state, understanding } = prepared();
    expect(() => applyRequirementUnderstanding(state, understanding, 'another-scope')).toThrow('staleResult');
    const invalid = structuredClone(understanding);
    invalid.checks = [{ id: 'C-1', text: 'Invented rule', requirementIds: ['RQ-missing'] }];
    expect(() => applyRequirementUnderstanding(state, invalid, state.scopeKey)).toThrow('invalidUnderstanding');
    putRequirementMaterial(state, { kind: 'text', label: 'Additional', text: 'Background only.' });
    expect(() => applyRequirementUnderstanding(state, understanding, state.scopeKey)).toThrow('staleResult');
  });
});

describe('human confirmation and scope changes', () => {
  it('requires one explicit baseline confirmation and reuses an unchanged baseline', () => {
    const { state } = prepared();
    expect(() => beginWorkflowRun(state, false, 'model')).toThrow('confirmationRequired');
    beginWorkflowRun(state, true, 'model');
    expect(state.baseline?.version).toBe(1);
    state.run.status = 'cancelled';
    beginWorkflowRun(state, false, 'model');
    expect(state.baseline?.version).toBe(1);
  });

  it('keeps human revisions separate from immutable original material', () => {
    const { state, material } = prepared();
    confirmReviewRequirements(state);
    reviseReviewRequirement(state, 'RQ-01', 'Clarified charge rule', '**Must** preserve one charge.');
    expect(materialText(material)).toBe('# Rules\r\nDo not charge twice.\r\n');
    expect(state.understanding.requirements[0].basis).toBe('human');
    expect(state.baseline?.requirements[0].text).toBe('Retries must not charge twice.');
    expect(requirementsConfirmed(state)).toBe(false);
    expect(confirmReviewRequirements(state)?.version).toBe(2);
  });

  it('does not reuse confirmation for changed interpretation at the same source revision', () => {
    const { state, understanding } = prepared();
    confirmReviewRequirements(state);
    const changed = structuredClone(understanding);
    changed.requirements[0].text = 'Repeated callbacks must not charge twice.';
    applyRequirementUnderstanding(state, changed, state.scopeKey);
    expect(requirementsConfirmed(state)).toBe(false);
    expect(() => beginWorkflowRun(state, false, 'model')).toThrow('confirmationRequired');
  });

  it('does not turn derived checks into additional normative requirements', () => {
    const { state, understanding } = prepared();
    confirmReviewRequirements(state);
    const changed = structuredClone(understanding);
    changed.checks = [{ id: 'C-1', text: 'Inspect retry callers.', requirementIds: ['RQ-01'] }];
    applyRequirementUnderstanding(state, changed, state.scopeKey);
    expect(currentRequirements(state)).toHaveLength(1);
    expect(requirementsConfirmed(state)).toBe(true);
    expect(confirmReviewRequirements(state)?.version).toBe(1);
  });

  it('preserves exclusion reasons but reintroduces requirements for a new scope', () => {
    const { state } = prepared();
    expect(() => includeReviewRequirement(state, 'RQ-01', false)).toThrow('exclusionReasonRequired');
    includeReviewRequirement(state, 'RQ-01', false, 'Outside the previous release.');
    const restored = restoreReviewWorkflow(state, 'scope-2', state.repositoryKey);
    expect(restored.understanding.requirements[0].included).toBe(true);
    expect(restored.priorExclusions?.[0].reason).toBe('Outside the previous release.');
    expect(restored.priorExclusions?.[0].origins[0].quote).toBe('Do not charge twice.');
    expect(restored.understanding.status).toBe('pending');
  });

  it('does not copy requirement material across repository identities', () => {
    const { state } = prepared();
    const restored = restoreReviewWorkflow(state, 'scope-2', 'different-repository');
    expect(restored.materials).toHaveLength(0);
    expect(state.materials).toHaveLength(1);
  });
});

describe('bounded real review orchestration', () => {
  it('allows technical review with no fabricated requirements or reading gate', () => {
    const state = createReviewWorkflow('scope', 'repo');
    complete(state);
    expect(state.baseline).toBeUndefined();
    expect(state.run.status).toBe('completed');
    expect(workflowGate(state, 0)).toEqual({ approve: [], feedback: [] });
    expect(workflowGate(state, 1).approve).toContainEqual({ code: 'unhandled', detail: '1' });
  });

  it('does not treat an empty scope or unstarted review as proof of correctness', () => {
    const state = createReviewWorkflow('scope', 'repo');
    expect(workflowGate(state, 0).feedback).toContainEqual({ code: 'noResults' });
    beginWorkflowRun(state, false, 'model');
    finishWorkflowRun(state, state.run.id, [], business(state));
    expect(workflowGate(state, 0).approve).toContainEqual({ code: 'noResults' });
  });

  it('keeps incomplete or budget-limited reviews available for feedback but not approval', () => {
    const { state } = prepared();
    beginWorkflowRun(state, true, 'model');
    recordWorkflowFile(state, state.run.id, 'src/payment.ts', { 'src/payment.ts': 'hash' }, ['Repository context limit reached.']);
    finishWorkflowRun(state, state.run.id, ['src/payment.ts', 'src/callback.ts'], business(state));
    expect(state.run.status).toBe('partial');
    expect(workflowGate(state, 0).feedback).toEqual([]);
    expect(workflowGate(state, 0).approve).toContainEqual({ code: 'incomplete' });
  });

  it('requires a result for every confirmed requirement instead of accepting omissions', () => {
    const { state } = prepared();
    beginWorkflowRun(state, true, 'model');
    recordWorkflowFile(state, state.run.id, 'src/payment.ts', { 'src/payment.ts': 'hash' });
    expect(() => finishWorkflowRun(state, state.run.id, ['src/payment.ts'], {
      chains: [], requirements: [], concerns: [], limitations: [],
    })).toThrow('invalidBusinessReview');
    expect(state.run.status).toBe('running');
  });

  it('blocks critical unknowns independently of ordinary finding dispositions', () => {
    const { state } = prepared();
    const concern: ReviewConcern = {
      id: 'Q-1', kind: 'question', title: 'Unverified event identity', detail: 'The retry key is not established.',
      impact: 'Duplicate side effects are possible.', critical: true, status: 'open',
      requirementIds: ['RQ-01'], evidence: [],
    };
    complete(state, business(state, [concern]));
    expect(workflowGate(state, 0).feedback).toEqual([]);
    expect(workflowGate(state, 0).approve).toContainEqual({ code: 'criticalConcern', detail: concern.title });
    expect(state.run.business?.concerns[0].status).toBe('open');
  });

  it('does not block solely on noncritical unknowns', () => {
    const { state } = prepared();
    const review = business(state);
    review.requirements[0].status = 'unknown';
    review.requirements[0].critical = false;
    complete(state, review);
    expect(workflowGate(state, 0).approve).toEqual([]);
  });

  it('does not erase prior critical concerns by switching to no-requirement mode', () => {
    const { state, material } = prepared();
    complete(state, business(state, [{
      id: 'Q-1', kind: 'question', title: 'Critical contract premise', detail: 'Missing contract.',
      impact: 'Payment safety depends on it.', requirementIds: ['RQ-01'], critical: true, status: 'open', evidence: [],
    }]));
    selectRequirementMaterial(state, material.id, false);
    beginWorkflowRun(state, false, 'model');
    recordWorkflowFile(state, state.run.id, 'src/payment.ts', { 'src/payment.ts': 'hash' });
    finishWorkflowRun(state, state.run.id, ['src/payment.ts'], business(state));
    expect(state.run.business?.concerns).toHaveLength(1);
    expect(state.run.unreviewedConcerns).toEqual(['Q-1']);
    expect(state.run.status).toBe('partial');
    expect(workflowGate(state, 0).approve.some((item) => item.code === 'criticalConcern')).toBe(true);
  });

  it('rejects late results even when a new run uses identical scope and requirements', () => {
    const { state } = prepared();
    beginWorkflowRun(state, true, 'model-1');
    const oldRun = state.run.id;
    const key = state.run.key;
    state.run.status = 'cancelled';
    beginWorkflowRun(state, false, 'model-2');
    expect(state.run.key).toBe(key);
    expect(state.run.id).not.toBe(oldRun);
    expect(() => recordWorkflowFile(state, oldRun, 'src/payment.ts', {})).toThrow('staleResult');
    expect(() => finishWorkflowRun(state, oldRun, ['src/payment.ts'], business(state))).toThrow('staleResult');
    expect(state.run.completed).toEqual([]);
  });

  it('invalidates results after source or requirement changes', () => {
    const { state } = prepared();
    complete(state);
    const key = workflowResultKey(state);
    reviseReviewRequirement(state, 'RQ-01', 'Changed constraint', 'Charge only after reservation.');
    expect(workflowResultKey(state)).not.toBe(key);
    expect(state.run.status).toBe('stale');
    expect(workflowGate(state, 0).feedback).toContainEqual({ code: 'staleResults' });
    expect(state.run.hashes['src/payment.ts']).toBe(contentSignature('source'));
  });

  it('restores interrupted work as cancelled, not completed or silently restarted', () => {
    const { state } = prepared();
    beginWorkflowRun(state, true, 'model');
    recordWorkflowFile(state, state.run.id, 'src/payment.ts', { 'src/payment.ts': 'hash' });
    const restored = restoreReviewWorkflow(state, state.scopeKey, state.repositoryKey);
    expect(restored.run.status).toBe('cancelled');
    expect(restored.interrupted).toBe(true);
    expect(workflowGate(restored, 0).approve).toContainEqual({ code: 'incomplete' });
    expect(workflowGate(restored, 0).feedback).toEqual([]);
    invalidateWorkflow(restored);
    expect(workflowGate(restored, 0).feedback).toContainEqual({ code: 'staleResults' });
  });

  it('binds scope identity to code endpoints, selected files and repository', () => {
    const set = { scopeId: 'branch:feature', label: 'Feature', headSha: 'head', files: [{ path: 'a.ts' }] };
    const key = workflowScopeKey(set, '/workspace/one');
    expect(workflowScopeKey({ ...set, files: [...set.files, { path: 'context.ts', context: true }] }, '/workspace/one')).toBe(key);
    expect(workflowScopeKey({ ...set, headSha: 'new-head' }, '/workspace/one')).not.toBe(key);
    expect(workflowScopeKey(set, '/workspace/two')).not.toBe(key);
    expect(workflowScopeKey({ ...set, files: [{ path: 'b.ts' }] }, '/workspace/one')).not.toBe(key);
  });
});
