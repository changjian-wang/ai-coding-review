import { describe, expect, it } from 'vitest';
import {
  BUSINESS_REVIEW_LIMITS, businessBaseline, businessBlockers, businessCitations, businessHash, businessKnownCritical, coverageComplete, createBusinessRun,
  mergeBusinessFindings, parseBusinessAssessment, parseBusinessDiscovery, parseBusinessPlan, parseBusinessVerification,
  restoreBusinessReview, segmentBusinessEvidence,
} from './businessReview';
import { addRequirementMaterial, acceptRequirementUnderstanding, confirmRequirements, createRequirementsDraft, parseRequirementUnderstanding, requirementScopeKey } from './requirements';
import type { ReviewSet } from '../scope/types';

const set: ReviewSet = { scopeId: 'feature', label: 'Feature', headSha: 'a'.repeat(40), files: [{ path: 'a.ts' }], source: { kind: 'commit', headRef: 'feature' } };
const code = 'if (!record) return;\nawait save(record);\n';
const evidence = segmentBusinessEvidence({ kind: 'code', path: 'a.ts', side: 'head', sourceHash: businessHash(code), text: code });
const ref = { evidenceId: evidence[0].id, quote: 'if (!record) return;' };
const baseline = businessBaseline('C:\\repo', set);
const candidate = parseBusinessDiscovery({
  summary: 'Review the guard.', candidates: [{ kind: 'implementation', title: 'Guard missing', cause: 'Null read', trigger: 'record is null', impact: 'Request fails', requirementIds: [], evidence: [ref] }], requests: [],
}, evidence, baseline, 'unit').candidates[0];

function decision(status: 'confirmed' | 'dismissed' | 'unresolved' = 'dismissed') {
  return {
    candidateIds: [candidate.id], kind: status === 'dismissed' ? 'reasonable' : 'implementation', status, severity: 'high', attribution: 'unknown',
    title: 'Guard covers null records', cause: 'Null record access', trigger: 'A missing record', impact: 'Request outcome',
    requirementIds: [], evidence: status === 'confirmed' ? [ref] : [], counterEvidence: status === 'dismissed' ? [ref] : [],
    counterRationale: 'The upstream early return covers the null path.', critical: null,
  };
}

describe('business evidence and actual interval coverage', () => {
  it.each([0, 1, BUSINESS_REVIEW_LIMITS.segmentCharacters, BUSINESS_REVIEW_LIMITS.segmentCharacters + 1, 48_017])(
    'segments all %i characters without replacing full source with a prefix', (length) => {
      const text = 'x'.repeat(length);
      const parts = segmentBusinessEvidence({ kind: 'code', path: 'large.ts', side: 'head', sourceHash: businessHash(text), text });
      expect(parts.map((part) => part.text).join('')).toBe(text);
      expect(parts.every((part) => part.text.length <= BUSINESS_REVIEW_LIMITS.segmentCharacters)).toBe(true);
      expect(coverageComplete({ path: 'large.ts', side: 'head', characters: length, status: 'reviewed', reviewed: parts.map(({ start, end }) => ({ start, end })) })).toBe(true);
    },
  );

  it('rejects gaps and fake overrun ranges rather than using a file-count proxy', () => {
    expect(coverageComplete({ path: 'a.ts', side: 'head', characters: 100, status: 'reviewed', reviewed: [{ start: 0, end: 99 }] })).toBe(false);
    expect(coverageComplete({ path: 'a.ts', side: 'head', characters: 100, status: 'reviewed', reviewed: [{ start: 0, end: 50 }, { start: 51, end: 100 }] })).toBe(false);
    expect(coverageComplete({ path: 'a.ts', side: 'head', characters: 100, status: 'reviewed', reviewed: [{ start: 0, end: 101 }] })).toBe(false);
  });

  it('derives exact locations from unique quotes and rejects ambiguous, missing or fabricated citations', () => {
    const references = businessCitations([ref], evidence);
    expect(references[0]).toMatchObject({ path: 'a.ts', side: 'head', line: 1, endLine: 1, sourceHash: businessHash(code) });
    expect(() => businessCitations([{ ...ref, quote: 'a fabricated guard' }], evidence)).toThrow(/quotation/);
    const repeated = segmentBusinessEvidence({ kind: 'code', side: 'head', path: 'a.ts', sourceHash: 'hash', text: 'return;\nreturn;\n' });
    expect(() => businessCitations([{ evidenceId: repeated[0].id, quote: 'return;' }], repeated)).toThrow(/quotation/);
    const crlf = code.replace(/\n/g, '\r\n');
    const normalized = segmentBusinessEvidence({ kind: 'code', side: 'head', path: 'a.ts', sourceHash: businessHash(crlf), text: crlf });
    expect(normalized[0].text).toBe(code);
    expect(businessCitations([{ evidenceId: normalized[0].id, quote: 'await save(record);' }], normalized)[0]).toMatchObject({ line: 2, endLine: 2, sourceHash: businessHash(crlf) });
  });
});

describe('business decision contracts', () => {
  it('requires a plan to cover the selected files and rejects fabricated requirement IDs', () => {
    expect(() => parseBusinessPlan({ units: [{ id: 'u', goal: 'Behavior', files: ['other.ts'], requirementIds: [] }] }, ['a.ts'], baseline)).toThrow();
    expect(() => parseBusinessPlan({ units: [] }, ['a.ts'], baseline)).toThrow();
    expect(() => parseBusinessPlan({ units: [{ id: 'u', goal: 'Behavior', files: ['a.ts'], requirementIds: ['invented'] }] }, ['a.ts'], baseline)).toThrow();
  });

  it('requires counterevidence to dismiss a suspicion and never treats missing evidence as a disproof', () => {
    const result = parseBusinessVerification({ decisions: [decision()] }, [candidate], evidence, baseline);
    expect(result[0]).toMatchObject({ kind: 'reasonable', status: 'dismissed' });
    expect(() => parseBusinessVerification({ decisions: [{ ...decision(), counterEvidence: [] }] }, [candidate], evidence, baseline)).toThrow(/quotation/);
    expect(() => parseBusinessVerification({ decisions: [] }, [candidate], evidence, baseline)).toThrow(/omitted/);
    expect(() => parseBusinessVerification({ decisions: [decision(), decision()] }, [candidate], evidence, baseline)).toThrow();
  });

  it('does not label a question as confirmed, and requires decisive critical-premise metadata', () => {
    expect(() => parseBusinessVerification({ decisions: [{ ...decision('confirmed'), kind: 'question' }] }, [candidate], evidence, baseline)).toThrow();
    expect(() => parseBusinessVerification({ decisions: [{ ...decision('unresolved'), critical: { impact: 'Unknown' } }] }, [candidate], evidence, baseline)).toThrow();
    expect(parseBusinessVerification({ decisions: [decision('unresolved')] }, [candidate], evidence, baseline)[0].critical).toBeNull();
    expect(() => parseBusinessVerification({ decisions: [{ ...decision('confirmed'), attribution: 'introduced' }] }, [candidate], evidence, baseline)).toThrow(/contradicts/);
  });

  it('merges one cause across locations without dropping evidence; conflicting decisions become unverified', () => {
    const confirmed = parseBusinessVerification({ decisions: [decision('confirmed')] }, [candidate], evidence, baseline)[0];
    const known = createBusinessRun(baseline, 'model');
    known.findings = [confirmed];
    expect(businessKnownCritical(known)).toHaveLength(1);
    expect(businessKnownCritical(known)[0].detail).toContain(confirmed.impact);
    const other = { ...confirmed, candidateIds: ['other'], evidence: [...confirmed.evidence, { ...confirmed.evidence[0], evidenceId: 'other', path: 'b.ts' }] };
    const merged = mergeBusinessFindings([confirmed, other]);
    expect(merged.findings).toHaveLength(1);
    expect(merged.findings[0].evidence).toHaveLength(2);
    expect(merged.findings[0].candidateIds).toEqual([candidate.id, 'other']);
    const conflict = mergeBusinessFindings([confirmed, { ...other, status: 'dismissed' }]);
    expect(conflict.conflicting).toBe(true);
    expect(conflict.findings[0].status).toBe('unresolved');
  });

  it('does not clear known critical issues or prove requirement satisfaction using only normative wording', () => {
    const draft = createRequirementsDraft();
    const id = addRequirementMaterial(draft, { name: 'Rule', kind: 'paste', location: 'User', format: 'text', text: 'Charge only once.' });
    const scopeKey = requirementScopeKey('C:\\repo', set);
    acceptRequirementUnderstanding(draft, parseRequirementUnderstanding({
      summary: 'Charge consistency', requirements: [{ id: 'RQ-1', title: 'Charge once', text: 'Charge only once.', origins: [{ sourceId: id, version: 1, line: 1, endLine: 1, quote: 'Charge only once.' }] }],
      checks: [], questions: [{ id: 'Q-1', text: 'Does the provider guarantee that?', origins: [{ sourceId: id, version: 1, line: 1, endLine: 1, quote: 'Charge only once.' }] }],
    }, draft, scopeKey, 'model'));
    confirmRequirements(draft, scopeKey, true);
    const active = businessBaseline('C:\\repo', set, draft);
    const material = segmentBusinessEvidence({ kind: 'material', path: 'User', side: 'material', sourceId: id, version: 1, sourceHash: businessHash('Charge only once.'), text: 'Charge only once.' });
    const cite = { evidenceId: material[0].id, quote: 'Charge only once.' };
    expect(() => parseBusinessVerification({
      decisions: [{ ...decision('confirmed'), kind: 'requirement', requirementIds: ['RQ-1'], evidence: [cite] }],
    }, [candidate], material, active)).toThrow(/quotation/);
    const contradictory = { ...active, requirements: [...active.requirements, { ...active.requirements[0], id: 'RQ-2', text: 'Charge twice for every order.', basis: 'human' as const }] };
    expect(parseBusinessVerification({
      decisions: [{ ...decision('confirmed'), kind: 'requirement', requirementIds: ['RQ-1', 'RQ-2'], evidence: [], cause: 'Charge only once and charge twice cannot both hold for the same order', trigger: 'One order is paid', impact: 'The acceptance rules are contradictory' }],
    }, [candidate], [], contradictory)[0]).toMatchObject({ kind: 'requirement', status: 'confirmed' });
    expect(() => parseBusinessAssessment({
      requirements: [{ id: 'RQ-1', status: 'supported', rationale: 'Because the requirement says so', evidence: [cite], critical: null }], premises: [], priorCritical: [],
    }, active, [], material, [])).toThrow(/contradicts/);
    expect(() => parseBusinessAssessment({
      requirements: [{ id: 'RQ-1', status: 'unknown', rationale: 'Unknown provider behavior', evidence: [], critical: null }],
      premises: [{ id: 'Q-1', status: 'clarified', rationale: 'Because the requirement says so', evidence: [cite], critical: null }],
      priorCritical: [],
    }, active, [], material, [])).toThrow(/quotation/);
    expect(() => parseBusinessAssessment({ requirements: [], premises: [], priorCritical: [{ id: 'known', status: 'cleared', rationale: 'A comment was posted', evidence: [] }] },
      baseline, [], evidence, [{ id: 'known', title: 'Known premise', detail: 'Decisive' }])).toThrow();
    expect(() => parseBusinessAssessment({
      requirements: [], premises: [], priorCritical: [{ id: 'known', status: 'cleared', rationale: 'The same requirement was confirmed again', evidence: [cite] }],
    }, baseline, [], material, [{ id: 'known', title: 'Known premise', detail: 'Decisive', normativeOrigins: active.requirements[0].origins }])).toThrow(/quotation/);
    const copied = [{ ...material[0], id: 'copied-evidence', sourceId: 'copied-source' }];
    expect(() => parseBusinessAssessment({
      requirements: [], premises: [], priorCritical: [{ id: 'known', status: 'cleared', rationale: 'The same normative text was uploaded under another identity', evidence: [{ evidenceId: 'copied-evidence', quote: 'Charge only once.' }] }],
    }, baseline, [], copied, [{ id: 'known', title: 'Known premise', detail: 'Decisive', normativeOrigins: active.requirements[0].origins }])).toThrow(/quotation/);
    const critical = { dependsOn: 'Charge consistency', impact: 'Duplicate payment', missingEvidence: 'Provider contract', question: 'Can a timed-out charge settle later?' };
    const first = createBusinessRun(active, 'model');
    first.requirements = [{ id: 'RQ-1', status: 'unknown', rationale: 'Missing provider facts', evidence: [], critical }];
    const known = businessKnownCritical(first);
    const next = createBusinessRun({ ...active, requirements: [{ ...active.requirements[0], text: 'A different requirement with the same RQ-1 identifier.' }] }, 'model', known);
    next.requirements = first.requirements;
    expect(businessKnownCritical(next)).toHaveLength(2);
    expect(businessKnownCritical(next).some((item) => item.detail.includes('Charge only once.'))).toBe(true);
  });

  it('retains valid snapshots but rejects unsupported or malformed persisted runs', () => {
    const run = createBusinessRun(baseline, 'test-model');
    expect(restoreBusinessReview(run)).toEqual(run);
    expect(() => restoreBusinessReview({ ...run, version: 'old-version' })).toThrow();
    expect(() => restoreBusinessReview({ ...run, calls: NaN })).toThrow();
    expect(businessBlockers(run)).toContain('The required review workflow is incomplete, limited, failed, cancelled or stale.');
    run.priorCritical.push({ id: 'long-critical', title: 'Preserved history', detail: 'x'.repeat(80_000) });
    run.dispositions['historical-note'] = { kind: 'commented', reason: 'x'.repeat(30_000), at: 1 };
    expect(restoreBusinessReview(run).priorCritical[0].detail).toHaveLength(80_000);
    expect(restoreBusinessReview(run).dispositions['historical-note'].reason).toHaveLength(30_000);
    run.baseline.questions = [{ id: 'Q-1', text: 'An unresolved premise', origins: [{ sourceId: 's', version: 0, line: 1, endLine: 1, quote: 'Source text' }] }];
    expect(() => restoreBusinessReview(run)).toThrow();
  });

  it('retains and assesses more than 80 previously known critical premises without silent omission', () => {
    const prior = Array.from({ length: 81 }, (_, index) => ({ id: `critical-${index}`, title: `Premise ${index}`, detail: 'Requires independent evidence.' }));
    const run = createBusinessRun(baseline, 'model', prior);
    expect(restoreBusinessReview(run).priorCritical).toHaveLength(81);
    const output = parseBusinessAssessment({
      requirements: [], premises: [], priorCritical: prior.map((item) => ({ id: item.id, status: 'unknown', rationale: 'Not established', evidence: [] })),
    }, baseline, [], evidence, prior);
    expect(output.priorCriticalVerdicts).toHaveLength(81);
    run.priorCriticalVerdicts = output.priorCriticalVerdicts;
    expect(restoreBusinessReview(run).priorCriticalVerdicts).toHaveLength(81);
  });
});
