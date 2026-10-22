import { describe, expect, it } from 'vitest';
import {
  acceptRequirementUnderstanding, addRequirementMaterial, confirmRequirements, createRequirementsDraft, currentMaterial,
  parseRequirementUnderstanding, requirementBoundary, requirementReadiness, requirementScopeKey, requirementSourceKey,
  restoreRequirementsDraft, reviseRequirement, selectRequirementMaterial, updateRequirementMaterial, REQUIREMENT_LIMITS,
} from './requirements';
import type { ReviewSet } from '../scope/types';

function fixture() {
  const draft = createRequirementsDraft();
  const id = addRequirementMaterial(draft, {
    kind: 'paste', name: 'Payment', location: 'Human input', format: 'markdown',
    text: '\n# Payment\r\n\r\nAn order must only be charged once.\r\nRespond promptly.\r\n',
  });
  const origin = { sourceId: id, version: 1, line: 4, endLine: 4, quote: 'An order must only be charged once.' };
  const output = {
    summary: 'Check charge consistency and clarify timing.',
    requirements: [{ id: 'RQ-1', title: 'Charge once', text: 'An order must only be charged once.', origins: [origin] }],
    checks: [{ id: 'CK-1', text: 'Check retries and callbacks together.', requirementIds: ['RQ-1'] }],
    questions: [{ id: 'Q-1', text: 'What does prompt mean?', origins: [{ ...origin, line: 5, endLine: 5, quote: 'Respond promptly.' }] }],
  };
  return { draft, id, output };
}

describe('requirement evidence and confirmation', () => {
  it('keeps original whitespace/CRLF and versioned snapshots separate from human understanding', () => {
    const { draft, id, output } = fixture();
    const original = currentMaterial(draft.materials[0]).text;
    acceptRequirementUnderstanding(draft, parseRequirementUnderstanding(output, draft, 'scope-1', 'test-model'));
    reviseRequirement(draft, 'RQ-1', 'Human refinement', '\n**Charge once across retries.**\n', true, '');
    expect(draft.understanding?.requirements[0]).toMatchObject({ basis: 'human', text: '\n**Charge once across retries.**\n' });
    expect(currentMaterial(draft.materials[0]).text).toBe(original);
    expect(draft.understanding?.requirements[0].origins[0].quote).toBe(output.requirements[0].origins[0].quote);
    updateRequirementMaterial(draft, id, `${original}\nA new condition.`);
    expect(draft.materials[0].versions[0].text).toBe(original);
    expect(currentMaterial(draft.materials[0]).version).toBe(2);
    expect(requirementReadiness(draft, 'scope-1').canConfirm).toBe(false);
    expect(restoreRequirementsDraft(draft).understanding?.requirements[0].basis).toBe('human');
  });

  it('only explicit confirmation binds current interpretation and code scope, not requirement correctness', () => {
    const { draft, output } = fixture();
    acceptRequirementUnderstanding(draft, parseRequirementUnderstanding(output, draft, 'scope-1', 'test-model'));
    expect(() => confirmRequirements(draft, 'scope-1', false)).toThrow(/Explicitly confirm/);
    confirmRequirements(draft, 'scope-1', true);
    expect(requirementReadiness(draft, 'scope-1')).toMatchObject({ canConfirm: true, confirmed: true, count: 1 });
    const restored = restoreRequirementsDraft(draft);
    expect(requirementReadiness(restored, 'scope-1').confirmed).toBe(true);
    expect(requirementBoundary(restored, 'scope-1')).toMatch(/consistency not assessed/);
    expect(requirementReadiness(restored, 'scope-2').confirmed).toBe(false);
    confirmRequirements(draft, 'scope-1', true);
    expect(draft.confirmationVersion).toBe(1);
    reviseRequirement(draft, 'RQ-1', 'New title', 'Human new wording', true, '');
    expect(draft.confirmation).toBeUndefined();
  });

  it('requires exclusion reasons, preserves questions and never turns derived checks into normative requirements', () => {
    const { draft, output } = fixture();
    acceptRequirementUnderstanding(draft, parseRequirementUnderstanding(output, draft, 'scope-1', 'test-model'));
    expect(() => reviseRequirement(draft, 'RQ-1', 'Title', 'Rule', false, '')).toThrow(/why/);
    reviseRequirement(draft, 'RQ-1', 'Title', 'Rule', false, 'Not in this scope');
    confirmRequirements(draft, 'scope-1', true);
    expect(draft.understanding?.requirements).toHaveLength(1);
    expect(draft.understanding?.checks).toHaveLength(0);
    expect(draft.understanding?.questions).toHaveLength(1);
    expect(requirementReadiness(draft, 'scope-1').count).toBe(0);
    expect(draft.understanding?.requirements[0].exclusionReason).toBe('Not in this scope');
  });

  it('invalidates old origins after material version or selection changes without deleting history', () => {
    const { draft, id, output } = fixture();
    const parsed = parseRequirementUnderstanding(output, draft, 'scope-1', 'model');
    selectRequirementMaterial(draft, id, false);
    expect(() => acceptRequirementUnderstanding(draft, parsed)).toThrow(/changed/);
    expect(() => parseRequirementUnderstanding(output, draft, 'scope-1', 'model')).toThrow(/citation/);
    selectRequirementMaterial(draft, id, true);
    updateRequirementMaterial(draft, id, 'Different original');
    expect(() => parseRequirementUnderstanding(output, draft, 'scope-1', 'model')).toThrow(/citation/);
    expect(draft.history.length).toBeGreaterThan(2);
  });

  it.each(['partial-quote', 'wrong-line', 'wrong-version', 'duplicate-id', 'unknown-reference', 'missing-array'])(
    'rejects %s rather than guessing a successful output shape', (kind) => {
      const { draft, output } = fixture();
      if (kind === 'partial-quote') output.requirements[0].origins[0].quote = 'must only be charged';
      if (kind === 'wrong-line') output.requirements[0].origins[0].line = 0;
      if (kind === 'wrong-version') output.requirements[0].origins[0].version = 2;
      if (kind === 'duplicate-id') output.checks[0].id = 'RQ-1';
      if (kind === 'unknown-reference') output.checks[0].requirementIds = ['invented'];
      const raw: unknown = kind === 'missing-array' ? { summary: output.summary, requirements: [] } : output;
      expect(() => parseRequirementUnderstanding(raw, draft, 'scope-1', 'model')).toThrow();
      expect(draft.confirmation).toBeUndefined();
    },
  );

  it('does not invent quantitative acceptance for ambiguous material', () => {
    const { draft } = fixture();
    const result = parseRequirementUnderstanding({ summary: 'Timing remains unclear.', requirements: [], checks: [], questions: [] }, draft, 'scope', 'model');
    expect(result.requirements).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('200ms');
    acceptRequirementUnderstanding(draft, result);
    confirmRequirements(draft, 'scope', true);
    expect(requirementReadiness(draft, 'scope').count).toBe(0);
  });

  it('rejects corrupted persisted state without mutating the stored input', () => {
    const { draft, output } = fixture();
    acceptRequirementUnderstanding(draft, parseRequirementUnderstanding(output, draft, 'scope', 'model'));
    const before = JSON.stringify(draft);
    const invalid = structuredClone(draft);
    invalid.materials[0].versions[0].hash = 'tampered';
    expect(() => restoreRequirementsDraft(invalid)).toThrow();
    const invalidUnderstanding = structuredClone(draft);
    invalidUnderstanding.understanding!.requirements[0].origins[0].quote = 'Not original';
    expect(() => restoreRequirementsDraft(invalidUnderstanding)).toThrow();
    expect(JSON.stringify(draft)).toBe(before);
    expect(() => restoreRequirementsDraft({ ...draft, version: 99 })).toThrow();
  });

  it('enforces source limits exactly without silently trimming or truncating', () => {
    const draft = createRequirementsDraft();
    const input = { kind: 'paste' as const, name: 'Text', location: 'Input', format: 'text' as const };
    addRequirementMaterial(draft, { ...input, text: 'x'.repeat(REQUIREMENT_LIMITS.bytes) });
    expect(currentMaterial(draft.materials[0]).text.length).toBe(REQUIREMENT_LIMITS.bytes);
    expect(() => addRequirementMaterial(draft, { ...input, text: 'x'.repeat(REQUIREMENT_LIMITS.bytes + 1) })).toThrow(/512,000/);
    expect(() => addRequirementMaterial(draft, { ...input, text: 'a\0b' })).toThrow(/NUL/);
    for (let index = 1; index < REQUIREMENT_LIMITS.sources; index++) addRequirementMaterial(draft, { ...input, text: 'a' });
    expect(() => addRequirementMaterial(draft, { ...input, text: 'a' })).toThrow(/12/);
  });

  it('binds head/base/remote identity but not evidence-only context expansion', () => {
    const set: ReviewSet = {
      scopeId: 'pr-1', label: 'PR', headSha: 'a'.repeat(40), files: [{ path: 'a.ts' }],
      source: { kind: 'commit', headRef: 'feature', baseRef: 'main', baseTipSha: 'b'.repeat(40) },
    };
    const key = requirementScopeKey('C:\\repo', set);
    expect(requirementScopeKey('C:\\repo', { ...set, files: [...set.files, { path: 'context.ts', context: true }] })).toBe(key);
    expect(requirementScopeKey('C:\\repo', { ...set, headSha: 'c'.repeat(40) })).not.toBe(key);
    expect(requirementScopeKey('C:\\other', set)).not.toBe(key);
    expect(requirementScopeKey('C:\\repo', { ...set, source: { ...set.source!, baseTipSha: 'd'.repeat(40) } })).not.toBe(key);
    expect(requirementSourceKey(createRequirementsDraft())).toMatch(/^[a-f0-9]{64}$/);
  });

  it('preserves unambiguous human revisions across reorganization without relying on model item IDs', () => {
    const { draft, output } = fixture();
    acceptRequirementUnderstanding(draft, parseRequirementUnderstanding(output, draft, 'scope', 'model'));
    reviseRequirement(draft, 'RQ-1', 'Human title', 'Human rule', false, 'Later iteration');
    const next = structuredClone(output);
    next.requirements[0].id = 'RQ-new';
    next.checks[0].requirementIds = ['RQ-new'];
    acceptRequirementUnderstanding(draft, parseRequirementUnderstanding(next, draft, 'scope', 'model'));
    expect(draft.understanding?.requirements[0]).toMatchObject({ id: 'RQ-new', basis: 'human', title: 'Human title', text: 'Human rule', included: false, exclusionReason: 'Later iteration' });
    expect(draft.understandingHistory).toHaveLength(2);
    expect(restoreRequirementsDraft(draft).understanding?.requirements[0].text).toBe('Human rule');
    expect(draft.understanding?.checks).toHaveLength(0);
    acceptRequirementUnderstanding(draft, parseRequirementUnderstanding(next, draft, 'new-scope', 'model'));
    expect(draft.understanding?.requirements[0]).toMatchObject({ included: true, exclusionReason: '', text: 'Human rule' });
    expect(draft.history.at(-2)?.action).toContain('Previous exclusions');
  });
});
