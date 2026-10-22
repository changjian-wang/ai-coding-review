import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { runBusinessReview, type BusinessReviewServices } from './businessReviewEngine';
import { BUSINESS_REVIEW_LIMITS, businessBaseline, businessBlockers, businessHash, businessRecord, coverageComplete, restoreBusinessReview, type BusinessModelPhase, type BusinessReviewRun } from './businessReview';
import { addRequirementMaterial, acceptRequirementUnderstanding, confirmRequirements, createRequirementsDraft, parseRequirementUnderstanding, requirementScopeKey } from './requirements';
import type { ReviewSet } from '../scope/types';

interface InputEvidence { id: string; kind: string; path: string; side: string; text: string }
function sources(payload: unknown): InputEvidence[] {
  return businessRecord(payload).evidence as InputEvidence[];
}
function cite(payload: unknown, text: string) {
  const source = sources(payload).find((source) => source.text.includes(text));
  if (!source) throw new Error(`Missing test evidence: ${text}`);
  return { evidenceId: source.id, quote: text };
}

const cwd = 'C:\\business-fixture';
const sourceText = new Map([
  ['cancel.ts', 'export async function cancel(order) {\n  await inventory.release(order.id);\n}\n'],
  ['restore.ts', 'export async function restore(order) {\n  await order.restore();\n  return { payable: true };\n}\n'],
]);

function fixture(requirements = false) {
  const set: ReviewSet = {
    scopeId: 'fixture', label: 'Business fixture', headSha: 'a'.repeat(40),
    source: { kind: 'commit', headRef: 'feature' }, files: [...sourceText.keys()].map((path) => ({ path })),
  };
  const draft = createRequirementsDraft();
  if (requirements) {
    const id = addRequirementMaterial(draft, { name: 'Order requirement', kind: 'paste', location: 'User requirement', format: 'text', text: 'Restore an order only after reserving inventory.' });
    const scope = requirementScopeKey(cwd, set);
    acceptRequirementUnderstanding(draft, parseRequirementUnderstanding({
      summary: 'Keep order and stock state consistent.',
      requirements: [{ id: 'RQ-1', title: 'Reserve before restore', text: 'Restore an order only after reserving inventory.', origins: [{ sourceId: id, version: 1, line: 1, endLine: 1, quote: 'Restore an order only after reserving inventory.' }] }],
      checks: [], questions: [],
    }, draft, scope, 'controlled-model'));
    confirmRequirements(draft, scope, true);
  }
  return { set, draft, baseline: businessBaseline(cwd, set, requirements ? draft : undefined) };
}

function discovery(payload: unknown) {
  const rules = businessRecord(payload).requirements as { id: string }[];
  return {
    kind: 'implementation', title: 'Restore does not recreate a released reservation',
    cause: 'Order state and stock reservation lifecycle do not close together',
    trigger: 'Cancel releases stock, then restore makes the order payable without reserving it again',
    impact: 'Stock can be promised twice', requirementIds: rules.map((rule) => rule.id),
    evidence: [cite(payload, 'await inventory.release(order.id);'), cite(payload, 'await order.restore();')],
  };
}

function harness(options: { globalDefect?: boolean; localDefect?: boolean; unknownCritical?: boolean } = {}) {
  const cts = new vscode.CancellationTokenSource();
  const updates: BusinessReviewRun[] = [];
  const read = vi.fn(async (file: string, _side: 'head' | 'base') => {
    const text = sourceText.get(file);
    if (text === undefined) throw new Error('File not provided');
    return text;
  });
  const request = vi.fn(async (phase: BusinessModelPhase, payload: unknown): Promise<unknown> => {
    const input = businessRecord(payload);
    if (phase === 'plan') {
      const files = input.files as { path: string }[];
      const rules = input.requirements as { id: string }[];
      return { units: [{ id: 'U-1', goal: 'Order cancellation and restoration', files: files.map((file) => file.path), requirementIds: rules.map((rule) => rule.id) }] };
    }
    if (phase === 'discover' || phase === 'global') {
      return {
        summary: 'Track release and restore together, not two isolated state updates.',
        candidates: phase === 'discover' && options.localDefect || phase === 'global' && options.globalDefect ? [discovery(payload)] : [],
        requests: [],
      };
    }
    if (phase === 'verify') {
      const candidates = input.candidates as { id: string; evidence: { evidenceId: string; quote: string }[]; requirementIds: string[] }[];
      const allEvidence = candidates.flatMap((candidate) => candidate.evidence);
      return { decisions: [{
        candidateIds: candidates.map((candidate) => candidate.id), kind: options.unknownCritical ? 'question' : 'implementation',
        status: options.unknownCritical ? 'unresolved' : 'confirmed', severity: 'high', attribution: 'unknown',
        title: 'One stock lifecycle defect', cause: 'Order state and stock reservation lifecycle do not close together',
        trigger: 'Cancel followed by restore', impact: 'Stock is promised twice',
        requirementIds: [...new Set(candidates.flatMap((candidate) => candidate.requirementIds))],
        evidence: allEvidence, counterEvidence: [],
        counterRationale: 'The supplied restore path has no reservation and the cancellation path releases it; no upstream guarantee was established.',
        critical: options.unknownCritical ? {
          dependsOn: 'Whether duplicate stock promises are prevented', impact: 'Orders could be fulfilled beyond stock',
          missingEvidence: 'The actual upstream reservation contract', question: 'Does every restore caller reserve atomically?',
        } : null,
      }] };
    }
    const requirements = input.requirements as { id: string }[];
    const findings = input.findings as { status: string; requirementIds: string[] }[];
    const questions = input.questions as { id: string }[];
    const prior = input.priorCritical as { id: string }[];
    return {
      requirements: requirements.map((rule) => ({
        id: rule.id, status: findings.some((finding) => finding.status === 'confirmed' && finding.requirementIds.includes(rule.id)) ? 'violated' : 'supported',
        rationale: 'Current source behavior was checked.', evidence: [cite(payload, 'await order.restore();')], critical: null,
      })),
      premises: questions.map((question) => ({ id: question.id, status: 'unknown', rationale: 'External behavior remains unavailable', evidence: [], critical: null })),
      priorCritical: prior.map((item) => ({ id: item.id, status: 'unknown', rationale: 'No new decisive evidence', evidence: [] })),
    };
  });
  const services: BusinessReviewServices = {
    modelId: 'controlled-model', token: cts.token, now: () => 100, cancel: () => cts.cancel(), isCurrent: () => true,
    read, resolve: async () => [], fits: async (_phase, payload) => JSON.stringify(payload).length < 90_000,
    request, update: async (run) => { updates.push(run); },
  };
  return { services, cts, updates, read, request };
}

describe('requirement-aware business review execution', () => {
  it('identifies an invalid requirement premise even when the implementation follows it literally', async () => {
    const rule = 'A timeout means the charge failed, so immediately allow a new payment.';
    const set: ReviewSet = { scopeId: 'payments', label: 'Payments', headSha: 'a'.repeat(40), files: [{ path: 'payment.ts' }, { path: 'gateway.ts' }] };
    const draft = createRequirementsDraft();
    const id = addRequirementMaterial(draft, { name: 'Payment rule', kind: 'paste', location: 'User', format: 'text', text: rule });
    const scope = requirementScopeKey(cwd, set);
    acceptRequirementUnderstanding(draft, parseRequirementUnderstanding({
      summary: 'Payment timeout handling', requirements: [{ id: 'RQ-1', title: 'Retry after timeout', text: rule, origins: [{ sourceId: id, version: 1, line: 1, endLine: 1, quote: rule }] }],
      checks: [], questions: [],
    }, draft, scope, 'controlled-model'));
    confirmRequirements(draft, scope, true);
    const baseline = businessBaseline(cwd, set, draft);
    const { services } = harness();
    services.read = async (file) => file === 'payment.ts'
      ? 'if (error.code === "TIMEOUT") return { allowNewPayment: true };\n'
      : 'export function finishChargeLaterAfterTimeout() { return settleOriginalCharge(); }\n';
    services.request = async (phase, payload) => {
      const refs = () => [cite(payload, 'return settleOriginalCharge();'), cite(payload, 'return { allowNewPayment: true };')];
      if (phase === 'plan') return { units: [{ id: 'U-pay', goal: 'Timeout and late settlement', files: ['payment.ts', 'gateway.ts'], requirementIds: ['RQ-1'] }] };
      if (phase === 'discover') return { summary: 'The implementation follows the literal timeout rule.', candidates: [], requests: [] };
      if (phase === 'global') return {
        summary: 'The actual provider can settle a timed-out charge later.',
        candidates: [{ kind: 'requirement', title: 'Timeout does not prove failure', cause: 'The requirement mistakes an unknown outcome for a definitive failure', trigger: 'A late successful charge races a new payment', impact: 'One order is charged twice', requirementIds: ['RQ-1'], evidence: refs() }], requests: [],
      };
      if (phase === 'verify') {
        const candidates = businessRecord(payload).candidates as { id: string }[];
        return { decisions: [{
          candidateIds: candidates.map((candidate) => candidate.id), kind: 'requirement', status: 'confirmed', severity: 'high', attribution: 'unknown',
          title: 'The requirement permits duplicate payments', cause: 'Timeout is not definitive failure', trigger: 'Late settlement after a timeout', impact: 'Duplicate charge',
          requirementIds: ['RQ-1'], evidence: refs(), counterEvidence: [],
          counterRationale: 'Literal implementation compliance is real, but it cannot make the provider outcome definitive.', critical: null,
        }] };
      }
      return { requirements: [{ id: 'RQ-1', status: 'violated', rationale: 'The premise contradicts the current provider implementation.', evidence: refs(), critical: null }], premises: [], priorCritical: [] };
    };
    const run = await runBusinessReview(set, baseline, services);
    expect(run.status).toBe('completed');
    expect(run.findings[0].kind).toBe('requirement');
    expect(run.findings[0].status).toBe('confirmed');
    expect(run.requirements[0].status).toBe('violated');
  });

  it('finds a cross-file combination even when all unit candidates are empty, without per-file reading', async () => {
    const { set, baseline } = fixture(true);
    const { services, request } = harness({ globalDefect: true });
    const run = await runBusinessReview(set, baseline, services);
    expect(run.status).toBe('completed');
    expect(run.globalCompleted).toBe(true);
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0]).toMatchObject({ status: 'confirmed', kind: 'implementation', attribution: 'unknown' });
    expect(run.findings[0].evidence.map((ref) => ref.path)).toEqual(expect.arrayContaining(['cancel.ts', 'restore.ts']));
    expect(run.requirements[0].status).toBe('violated');
    expect(run.coverage.every(coverageComplete)).toBe(true);
    expect(request.mock.calls.filter(([phase]) => phase === 'discover')).toHaveLength(1);
    expect(request.mock.calls.filter(([phase]) => phase === 'global')).toHaveLength(1);
    expect(businessBlockers(run)).toContain('Verified defects remain. A comment or an unverified human exception does not fix them.');
  });

  it('does not inflate one root cause into duplicate file findings', async () => {
    const { set, baseline } = fixture();
    const { services } = harness({ localDefect: true, globalDefect: true });
    const run = await runBusinessReview(set, baseline, services);
    expect(run.candidates).toHaveLength(2);
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0].candidateIds).toHaveLength(2);
  });

  it('allows an evidence-grounded upstream safeguard to dismiss a local suspicion', async () => {
    const { set, baseline } = fixture();
    const { services, request } = harness({ globalDefect: true });
    const original = services.request;
    const originalRead = services.read;
    services.read = (file, side) => file === 'api.ts'
      ? Promise.resolve('export async function apiRestore(order) {\n  await inventory.reserveForOrder(order);\n  return restore(order);\n}\n')
      : originalRead(file, side);
    services.resolve = async () => ['api.ts'];
    services.request = async (phase, payload) => {
      if (phase === 'discover') return {
        summary: 'Check the restore caller before treating the local reservation gap as a defect.', candidates: [],
        requests: [{ file: 'restore.ts', kind: 'references', symbol: 'restore', question: 'Does the allowed caller reserve before restoring?' }],
      };
      if (phase !== 'verify') return original(phase, payload);
      const input = businessRecord(payload);
      const candidates = input.candidates as { id: string }[];
      return { decisions: [{
        candidateIds: candidates.map((candidate) => candidate.id), kind: 'reasonable', status: 'dismissed', severity: 'low', attribution: 'unknown',
        title: 'A supplied guarantee covers this path', cause: 'Suspected contract gap', trigger: 'Restore call', impact: 'No confirmed bug',
        requirementIds: [], evidence: [], counterEvidence: [cite(payload, 'await inventory.reserveForOrder(order);')],
        counterRationale: 'The supplied API caller reserves before calling restore; this scope contains that route, not an assumed hidden guarantee.', critical: null,
      }] };
    };
    const run = await runBusinessReview(set, baseline, services);
    expect(run.status).toBe('completed');
    expect(run.findings[0].status).toBe('dismissed');
    run.confirmed = true;
    expect(businessBlockers(run)).toEqual([]);
    expect(request).toHaveBeenCalled();
  });

  it('makes critical uncertainty blocking but does not automatically turn every unknown into a blocker', async () => {
    const { set, baseline } = fixture();
    const first = harness({ globalDefect: true, unknownCritical: true });
    const critical = await runBusinessReview(set, baseline, first.services);
    critical.confirmed = true;
    expect(businessBlockers(critical)).toContain('A critical contradiction or decisive unverified premise remains open.');
    const other = harness({ globalDefect: true, unknownCritical: true });
    const request = other.services.request;
    other.services.request = async (phase, payload) => {
      const output = await request(phase, payload);
      if (phase === 'verify') {
        const raw = businessRecord(output);
        for (const entry of raw.decisions as Record<string, unknown>[]) entry.critical = null;
      }
      return output;
    };
    const noncritical = await runBusinessReview(set, baseline, other.services);
    noncritical.confirmed = true;
    expect(businessBlockers(noncritical)).toEqual([]);
  });

  it('covers every character in large single-line files through adaptive batches; global truncation is explicit', async () => {
    const text = 'x'.repeat(48_017);
    const { set } = fixture();
    set.files = [{ path: 'large.ts' }];
    const baseline = businessBaseline(cwd, set);
    const { services } = harness();
    services.read = async () => text;
    services.fits = async (_phase, payload) => JSON.stringify(payload).length < 9000;
    const run = await runBusinessReview(set, baseline, services);
    expect(run.coverage[0].characters).toBe(text.length);
    expect(coverageComplete(run.coverage[0])).toBe(true);
    expect(run.coverage[0].reviewed.length).toBeGreaterThan(3);
    expect(run.status).toBe('partial');
    expect(run.limitations).toContain('Global analysis could not receive the full available source context; coverage is limited.');
  });

  it('does not count unreadable sources or invalid model output as completed empty findings', async () => {
    const { set, baseline } = fixture();
    const io = harness();
    io.services.read = async (file) => { if (file === 'restore.ts') throw new Error('Access denied'); return sourceText.get(file)!; };
    const partial = await runBusinessReview(set, baseline, io.services);
    expect(partial.status).toBe('partial');
    expect(partial.coverage.find((entry) => entry.path === 'restore.ts')?.status).toBe('failed');
    expect(partial.errors.join('\n')).toContain('Access denied');
    const broken = harness();
    const request = broken.services.request;
    broken.services.request = (phase, payload) => phase === 'global' ? Promise.resolve({}) : request(phase, payload);
    const failed = await runBusinessReview(set, baseline, broken.services);
    expect(failed.status).toBe('failed');
    expect(failed.globalCompleted).toBe(false);
    expect(failed.errors.length).toBeGreaterThan(0);
  });

  it('retains a candidate as unresolved when independent verification omits its decision', async () => {
    const { set, baseline } = fixture();
    const { services } = harness({ globalDefect: true });
    const request = services.request;
    services.request = (phase, payload) => phase === 'verify' ? Promise.resolve({ decisions: [] }) : request(phase, payload);
    const run = await runBusinessReview(set, baseline, services);
    expect(run.status).toBe('partial');
    expect(run.findings[0].status).toBe('unresolved');
    expect(run.errors.join('\n')).toContain('omitted');
  });

  it('cancels a waiting model promptly and does not accept its late response', async () => {
    const { set, baseline } = fixture();
    const { services, cts, request } = harness();
    let late!: (value: unknown) => void;
    services.request = (phase, payload) => phase === 'global' ? new Promise((resolve) => { late = resolve; }) : request(phase, payload);
    const work = runBusinessReview(set, baseline, services);
    await vi.waitFor(() => expect(late).toBeTypeOf('function'));
    cts.cancel();
    const run = await work;
    expect(run.status).toBe('cancelled');
    expect(run.globalCompleted).toBe(false);
    late({ summary: 'Late result', candidates: [], requests: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run.status).toBe('cancelled');
  });

  it('invalidates the entire result when a source changes before persistence', async () => {
    const { set, baseline } = fixture();
    const { services } = harness();
    const reads = new Map<string, number>();
    services.read = async (file) => {
      const count = (reads.get(file) ?? 0) + 1;
      reads.set(file, count);
      return count > 1 ? `${sourceText.get(file)}\nChanged after analysis` : sourceText.get(file)!;
    };
    const run = await runBusinessReview(set, baseline, services);
    expect(run.status).toBe('stale');
    expect(businessBlockers(run).length).toBeGreaterThan(0);
  });

  it('reuses only exact-input completed calls on retry and rechecks new or changed evidence', async () => {
    const { set, baseline } = fixture();
    const first = harness();
    first.services.read = async (file) => `${sourceText.get(file)}\n//${'x'.repeat(20_000)}`;
    const run = await runBusinessReview(set, baseline, first.services);
    expect(run.status).toBe('completed');
    run.confirmed = true;
    const second = harness();
    second.services.read = first.services.read;
    const resumed = await runBusinessReview(set, baseline, second.services, run);
    expect(second.request).not.toHaveBeenCalled();
    expect(resumed.calls).toBe(0);
    expect(resumed.confirmed).toBe(false);
    const third = harness();
    third.services.read = async (file, side) => `${await first.services.read(file, side)}\n// changed beyond the planning preview and first segment`;
    const changed = await runBusinessReview(set, baseline, third.services, run);
    expect(third.request).toHaveBeenCalled();
    expect(changed.dependencies).not.toEqual(run.dependencies);
  });

  it('does not forget a previously known critical issue when switching to technical mode', async () => {
    const { set, baseline } = fixture();
    const { services } = harness();
    const prior = [{ id: 'known-critical', title: 'Timeout semantics', detail: 'Late success could cause duplicate charge.' }];
    const run = await runBusinessReview(set, baseline, services, undefined, prior);
    expect(run.mode).toBe('technical');
    expect(run.priorCriticalVerdicts[0].status).toBe('unknown');
    run.confirmed = true;
    expect(businessBlockers(run)).toContain('A critical contradiction or decisive unverified premise remains open.');
  });

  it('reads deletion and rename base sides explicitly, but never invents a base for added files', async () => {
    const { set } = fixture();
    set.files = [{ path: 'gone.ts', status: 'deleted' }, { path: 'next.ts', previousPath: 'prior.ts', status: 'renamed' }, { path: 'added.ts', status: 'added' }];
    set.comparison = { baseSha: 'b'.repeat(40), headSha: set.headSha };
    const { services } = harness();
    const read = vi.fn(async (file: string, side: 'head' | 'base') => `// ${file} at ${side}\r\nexport const value = 1;\r\n`);
    services.read = read;
    const run = await runBusinessReview(set, businessBaseline(cwd, set), services);
    expect(run.status).toBe('completed');
    expect(read.mock.calls).toEqual(expect.arrayContaining([['gone.ts', 'base'], ['next.ts', 'head'], ['prior.ts', 'base'], ['added.ts', 'head']]));
    expect(read.mock.calls).not.toEqual(expect.arrayContaining([['gone.ts', 'head']]));
    expect(read.mock.calls).not.toEqual(expect.arrayContaining([['added.ts', 'base']]));
    expect(run.coverage).toHaveLength(4);
    expect(run.coverage.every(coverageComplete)).toBe(true);
    const original = '// gone.ts at base\r\nexport const value = 1;\r\n';
    expect(run.dependencies['base:gone.ts']).toBe(businessHash(original));
    expect(run.coverage.find((item) => item.path === 'gone.ts')?.characters).toBe(original.replace(/\r\n/g, '\n').length);
  });

  it('records all 81 files but does not read or approve the one beyond its exact 80-file budget', async () => {
    const { set } = fixture();
    set.files = Array.from({ length: BUSINESS_REVIEW_LIMITS.files + 1 }, (_, index) => ({ path: `file-${index}.ts` }));
    const { services } = harness();
    const read = vi.fn(async (file: string) => `// ${file}\nexport const value = 1;\n`);
    services.read = read;
    const run = await runBusinessReview(set, businessBaseline(cwd, set), services);
    expect(run.status).toBe('partial');
    expect(run.coverage).toHaveLength(81);
    expect(run.coverage[80].status).toBe('limited');
    expect(read).not.toHaveBeenCalledWith('file-80.ts', 'head');
    expect(run.limitations).toContain('The file budget was reached; remaining files are not reviewed.');
    expect(restoreBusinessReview(run).coverage).toHaveLength(81);
  });

  it('stops at exactly 128 actual model calls and does not mark the rest of a huge file reviewed', async () => {
    const { set } = fixture();
    set.files = [{ path: 'huge.ts' }];
    const { services, request } = harness();
    services.read = async () => 'x'.repeat(BUSINESS_REVIEW_LIMITS.segmentCharacters * 130);
    services.fits = async (_phase, payload) => JSON.stringify(payload).length < 20_000;
    const run = await runBusinessReview(set, businessBaseline(cwd, set), services);
    expect(run.status).toBe('partial');
    expect(run.calls).toBe(128);
    expect(request).toHaveBeenCalledTimes(128);
    expect(run.globalCompleted).toBe(false);
    expect(coverageComplete(run.coverage[0])).toBe(false);
    expect(run.limitations).toContain('The model-call budget was reached.');
    expect(restoreBusinessReview(run).calls).toBe(128);
  });

  it('stops at the actual deadline rather than relying on model cancellation or a progress percentage', async () => {
    const { set, baseline } = fixture();
    const { services } = harness();
    let clock = 100;
    services.now = () => clock;
    const request = services.request;
    services.request = async (phase, payload) => {
      const result = await request(phase, payload);
      clock = 100 + BUSINESS_REVIEW_LIMITS.durationMs;
      return result;
    };
    const run = await runBusinessReview(set, baseline, services);
    expect(run.status).toBe('partial');
    expect(run.calls).toBe(1);
    expect(run.limitations).toContain('The business-review time budget was reached.');
  });

  it('preserves a restorable partial state at the exact candidate budget instead of persisting an oversized invalid run', async () => {
    const { set, baseline } = fixture();
    const { services } = harness();
    const request = services.request;
    services.request = (phase, payload) => phase === 'discover' || phase === 'global'
      ? Promise.resolve({ summary: 'Controlled candidate-budget fixture', candidates: Array.from({ length: 80 }, () => discovery(payload)), requests: [] })
      : request(phase, payload);
    const run = await runBusinessReview(set, baseline, services);
    expect(run.status).toBe('partial');
    expect(run.candidates).toHaveLength(80);
    expect(run.findings.every((finding) => finding.status === 'unresolved')).toBe(true);
    expect(run.limitations).toContain('The candidate budget was reached. Omitted leads were not verified or cleared.');
    expect(restoreBusinessReview(run).candidates).toHaveLength(80);
  });

  it('does not claim the final newly fetched source was globally checked after the last evidence pass', async () => {
    const { set, baseline } = fixture();
    const { services } = harness();
    const read = services.read;
    services.read = (file, side) => file.startsWith('dep') ? Promise.resolve(`export const ${file.slice(0, 4)} = true;\n`) : read(file, side);
    services.resolve = async (request) => [`${request.symbol}.ts`];
    let pass = 0;
    const request = services.request;
    services.request = (phase, payload) => phase === 'global'
      ? Promise.resolve({ summary: 'Requires another precise contract.', candidates: [], requests: [{ file: 'restore.ts', kind: 'contract', symbol: `dep${++pass}`, question: `What is contract ${pass}?` }] })
      : request(phase, payload);
    const run = await runBusinessReview(set, baseline, services);
    expect(pass).toBe(2);
    expect(run.dependencies['head:dep2.ts']).toBeTypeOf('string');
    expect(run.status).toBe('partial');
    expect(run.limitations).toContain('Global analysis could not receive the full available source context; coverage is limited.');
  });

  it('handles synchronous cancellation inside a model call before its cancellation listener was registered', async () => {
    const { set, baseline } = fixture();
    const { services, cts } = harness();
    const request = services.request;
    services.request = (phase, payload) => {
      if (phase !== 'global') return request(phase, payload);
      cts.cancel();
      return new Promise(() => {});
    };
    expect((await runBusinessReview(set, baseline, services)).status).toBe('cancelled');
  }, 1000);
});
