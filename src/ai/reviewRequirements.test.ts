import { describe, expect, it } from 'vitest';
import { findingContentSignature, type Finding, type GlobalFixSpot } from './types';
import {
  applyRequirementUnderstanding, beginWorkflowRun, confirmReviewRequirements, createReviewWorkflow,
  materialText, putRequirementMaterial, reviseReviewRequirement,
} from '../review/reviewWorkflow';
import {
  businessReviewInstructions, parseBusinessReview, parseRequirementUnderstanding, parseReviewEvidence,
  requirementContext, understandingRequest, validateGlobalReviewEvidence,
} from './reviewRequirements';

function fixture() {
  const state = createReviewWorkflow('scope', 'repo');
  const material = putRequirementMaterial(state, {
    kind: 'text', label: 'Rules', location: 'input:rules', text: 'Do not charge twice.\r\nBackground only.\r\n',
  });
  const raw = {
    summary: 'Safe retries',
    requirements: [{
      id: 'temporary-1', title: 'Single charge', text: 'Retries must preserve one charge.',
      origins: [{ sourceId: material.id, version: 1, line: 1, quote: 'Do not charge twice.' }],
    }],
    checks: [{ id: 'C1', requirementIds: ['temporary-1'], text: 'Inspect retry callers.' }],
    questions: [],
  };
  const understanding = parseRequirementUnderstanding(raw, state);
  applyRequirementUnderstanding(state, understanding, state.scopeKey);
  return { state, material, raw };
}

const finding: Finding = {
  id: 'f0', line: 1, severity: 'bug', title: 'Duplicate side effect', detail: 'The retry repeats the charge.',
  anchor: 'charge(order);',
};
const files = [{ path: 'src/payment.ts', findings: [finding] }];
const visible = new Map([['src/payment.ts', 'charge(order);\nreturn result;']]);
const proof = { kind: 'root', file: 'src/payment.ts', line: 1, quote: 'charge(order);' };
const spot: GlobalFixSpot = { ...finding, id: 'global-id', file: 'src/payment.ts' };

function business(requirementId: string) {
  return {
    chains: [{
      id: 'B1', title: 'Payment retry', description: 'Request identity across retries.',
      files: ['src/payment.ts'], findingRefs: [`file:src/payment.ts#${findingContentSignature(finding)}`],
    }],
    requirements: [{
      requirementId, status: 'violated', critical: false, rationale: 'A reachable retry charges again.',
      findingRefs: ['global:0'], evidence: [proof],
    }],
    concerns: [], limitations: [],
  };
}

describe('real model requirement protocol', () => {
  it('uses stable source-derived identities instead of model numbering', () => {
    const { state, material, raw } = fixture();
    const first = state.understanding.requirements[0].id;
    const renumbered = structuredClone(raw);
    renumbered.requirements[0].id = 'another-id';
    renumbered.checks[0].requirementIds = ['another-id'];
    const parsed = parseRequirementUnderstanding(renumbered, state);
    expect(parsed.requirements[0].id).toBe(first);
    expect(parsed.checks[0].requirementIds).toEqual([first]);
    expect(materialText(material)).toBe('Do not charge twice.\r\nBackground only.\r\n');
  });

  it('rejects fabricated source quotes, missing fields and duplicate provenance', () => {
    const { state, raw } = fixture();
    const invalid = structuredClone(raw);
    invalid.requirements[0].origins[0].quote = 'Guaranteed safe.';
    expect(() => parseRequirementUnderstanding(invalid, state)).toThrow('invalidReference');
    expect(() => parseRequirementUnderstanding({ requirements: [] }, state)).toThrow('invalidUnderstanding');
    const duplicated = structuredClone(raw);
    duplicated.requirements.push({ ...duplicated.requirements[0], id: 'different-id' });
    expect(() => parseRequirementUnderstanding(duplicated, state)).toThrow('invalidUnderstanding');
  });

  it('preserves explicit human revisions when unrelated sources are added', () => {
    const { state, raw } = fixture();
    const id = state.understanding.requirements[0].id;
    reviseReviewRequirement(state, id, 'Human constraint', 'The same order must have one debit.');
    putRequirementMaterial(state, { kind: 'text', label: 'More context', text: 'The cache serves display only.' });
    applyRequirementUnderstanding(state, parseRequirementUnderstanding(raw, state), state.scopeKey);
    expect(state.understanding.requirements[0].text).toBe('The same order must have one debit.');
    expect(state.understanding.requirements[0].basis).toBe('human');
    expect(state.understanding.requirements[0].origins[0].quote).toBe('Do not charge twice.');
  });

  it('does not send unselected snapshots or claim an unconfirmed baseline', () => {
    const { state } = fixture();
    state.materials.push({
      id: 'not-selected', kind: 'text', label: 'Not selected', location: 'input:other', selected: false,
      version: 1, snapshots: [{ version: 1, text: 'MUST NOT BE SENT', createdAt: 1 }],
    });
    const request = understandingRequest(state, 'zh-CN');
    expect(request.system).toContain('不编造量化阈值');
    expect(request.user).not.toContain('MUST NOT BE SENT');
    expect(() => requirementContext(state)).toThrow('confirmationRequired');
    confirmReviewRequirements(state);
    expect(requirementContext(state)).toContain('confirmed-requirements');
    expect(requirementContext(state)).not.toContain('MUST NOT BE SENT');
    expect(businessReviewInstructions('en')).toContain('priorCriticalConcerns');
  });
});

describe('business judgment and counter-evidence protocol', () => {
  it('ties requirement violations to actual finding references', () => {
    const { state } = fixture();
    const raw = business(state.understanding.requirements[0].id);
    const parsed = parseBusinessReview(raw, state, files, visible, [spot]);
    expect(parsed.requirements[0].findingRefs).toEqual(['global:global-id']);
    expect(parsed.requirements[0].evidence).toEqual([{ kind: 'root', file: 'src/payment.ts', line: 1 }]);
    raw.requirements[0].findingRefs = ['global:100'];
    expect(() => parseBusinessReview(raw, state, files, visible, [spot])).toThrow('invalidBusinessReview');
  });

  it('requires explicit results for every requirement and explicit criticality', () => {
    const { state } = fixture();
    const raw = business(state.understanding.requirements[0].id);
    expect(() => parseBusinessReview({ ...raw, requirements: [] }, state, files, visible, [spot])).toThrow('invalidBusinessReview');
    const missing = { ...raw.requirements[0], critical: undefined };
    expect(() => parseBusinessReview({ ...raw, requirements: [missing] }, state, files, visible, [spot])).toThrow('invalidBusinessReview');
    expect(() => parseBusinessReview({ ...raw, requirements: [raw.requirements[0], raw.requirements[0]] }, state, files, visible, [spot])).toThrow('invalidBusinessReview');
  });

  it('rejects evidence outside the actual supplied source, including truncated lines', () => {
    expect(() => parseReviewEvidence([{ ...proof, line: 9 }], visible)).toThrow('invalidReference');
    expect(() => parseReviewEvidence([{ ...proof, file: '../outside.ts' }], visible)).toThrow('invalidReference');
    expect(() => parseReviewEvidence([{ ...proof, quote: 'protectedCharge(order);' }], visible)).toThrow('invalidReference');
    expect(() => parseReviewEvidence([{ ...proof, line: 2, quote: 'return result;' }], new Map([['src/payment.ts', 'charge(order);']]))).toThrow('invalidReference');
  });

  it('distinguishes an actually empty file from an unreadable or absent file', () => {
    const emptyProof = { kind: 'root', file: 'src/empty.ts', line: 1, quote: '' };
    expect(parseReviewEvidence([emptyProof], new Map([['src/empty.ts', '']]))).toHaveLength(1);
    expect(() => parseReviewEvidence([emptyProof], new Map())).toThrow('invalidReference');
    expect(() => parseReviewEvidence([emptyProof], new Map([['src/empty.ts', 'nonempty']]))).toThrow('invalidReference');
  });

  it('requires real counter-evidence before overturning a file-level finding', () => {
    const raw = {
      conclusion: 'A guard exists.', recommendation: 'comment', evidence: ['src/payment.ts:1'], fixSpots: [],
      verdicts: [{
        kind: 'flip', title: 'Guarded elsewhere', before: 'Unprotected retry', after: 'The call uses a guard.',
        file: 'src/payment.ts', findingRef: findingContentSignature(finding), evidenceRefs: [proof],
      }],
    };
    expect(validateGlobalReviewEvidence(raw, files, visible)[0]).toHaveLength(1);
    raw.verdicts[0].evidenceRefs = [];
    expect(() => validateGlobalReviewEvidence(raw, files, visible)).toThrow('invalidReference');
    raw.verdicts[0].evidenceRefs = [{ ...proof, quote: 'inventedGuard();' }];
    expect(() => validateGlobalReviewEvidence(raw, files, visible)).toThrow('invalidReference');
  });

  it('locates a unique verbatim global anchor rather than trusting a drifting model line', () => {
    const raw = {
      conclusion: 'A reachable retry duplicates the effect.', recommendation: 'request_changes',
      evidence: [], verdicts: [],
      fixSpots: [{ file: 'src/payment.ts', line: 99, severity: 'bug', title: 'Duplicate effect', detail: 'Retries debit twice.', anchor: 'charge(order);' }],
    };
    validateGlobalReviewEvidence(raw, files, visible);
    expect(raw.fixSpots[0].line).toBe(1);
    raw.fixSpots[0].anchor = 'notPresent(order);';
    expect(() => validateGlobalReviewEvidence(raw, files, visible)).toThrow('invalidReference');
  });

  it('does not resolve a critical premise without cited current evidence', () => {
    const { state } = fixture();
    confirmReviewRequirements(state);
    beginWorkflowRun(state, false, 'model');
    const raw = business(state.understanding.requirements[0].id);
    const concern = {
      id: 'Q-1', kind: 'question', title: 'External identity', detail: 'Event identity is unknown.',
      impact: 'The retry may duplicate the effect.', requirementIds: [], critical: true, status: 'resolved', evidence: [],
    };
    expect(() => parseBusinessReview({ ...raw, concerns: [concern] }, state, files, visible, [spot])).toThrow('invalidBusinessReview');
  });
});
