import type * as vscode from 'vscode';
import { m } from '../i18n';
import type { ReviewSet } from '../scope/types';
import {
  BUSINESS_REVIEW_LIMITS, businessHash, coverageComplete, createBusinessRun,
  parseBusinessAssessment, parseBusinessDiscovery, parseBusinessPlan, parseBusinessVerification, segmentBusinessEvidence,
  mergeBusinessFindings,
  businessCitations,
  type BusinessBaseline, type BusinessCandidate, type BusinessDiscovery, type BusinessEvidence, type BusinessEvidenceRequest,
  type BusinessFinding, type BusinessModelPhase, type BusinessPriorCritical, type BusinessReviewRun, type BusinessCoverage,
} from './businessReview';

export interface BusinessReviewServices {
  modelId: string;
  token: vscode.CancellationToken;
  now(): number;
  cancel(): void;
  isCurrent(): boolean;
  read(path: string, side: 'head' | 'base'): Promise<string>;
  readFresh?(path: string, side: 'head' | 'base'): Promise<string>;
  resolve(request: BusinessEvidenceRequest): Promise<string[]>;
  fits(phase: BusinessModelPhase, payload: unknown): Promise<boolean>;
  request(phase: BusinessModelPhase, payload: unknown): Promise<unknown>;
  update(run: BusinessReviewRun): Promise<void>;
}

class ReviewStop extends Error {
  constructor(readonly reason: 'budget' | 'cancelled' | 'stale', message: string) { super(message); }
}

export interface BusinessLegacyCandidate {
  id: string;
  path: string;
  line: number;
  anchor?: string;
  title: string;
  detail: string;
}

function unresolved(candidate: BusinessCandidate, reason: string): BusinessFinding {
  return {
    ...candidate, id: `br-${businessHash(candidate.id + candidate.cause).slice(0, 24)}`, candidateIds: [candidate.id],
    status: 'unresolved', severity: 'medium', attribution: 'unknown', counterEvidence: [],
    counterRationale: reason, critical: null,
  };
}

export async function runBusinessReview(
  set: ReviewSet, baseline: BusinessBaseline, services: BusinessReviewServices,
  previous?: BusinessReviewRun, priorCritical: BusinessPriorCritical[] = [],
  legacy: BusinessLegacyCandidate[] = [],
): Promise<BusinessReviewRun> {
  const t = m().businessReview;
  const run = createBusinessRun(baseline, services.modelId, priorCritical);
  run.startedAt = services.now();
  const deadline = run.startedAt + BUSINESS_REVIEW_LIMITS.durationMs;
  const known = new Map<string, BusinessEvidence>();
  const originals: BusinessEvidence[] = [];
  const requests: BusinessEvidenceRequest[] = [];
  const roots = set.files.filter((file) => !file.context);
  const notes = previous?.dispositions
    ? Object.entries(previous.dispositions).map(([id, note]) => ({ id, ...note, title: previous.findings.find((item) => item.id === id)?.title }))
    : [];
  const common = {
    scope: baseline.scope,
    mode: baseline.mode,
    requirements: baseline.requirements, excluded: baseline.excluded.map(({ id, exclusionReason }) => ({ id, reason: exclusionReason })),
    questions: baseline.questions, priorCritical, humanNotes: notes,
  };
  const matchingPrevious = previous?.bindingKey === baseline.bindingKey && previous.modelId === services.modelId ? previous : undefined;
  run.cache = matchingPrevious ? [...matchingPrevious.cache] : [];
  const current = () => {
    if (!services.isCurrent()) throw new ReviewStop('stale', t.stale);
    if (services.token.isCancellationRequested) throw new ReviewStop('cancelled', t.cancelled);
    if (services.now() >= deadline) throw new ReviewStop('budget', t.timeLimit);
  };
  const wait = <T>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    let settled = false;
    let cancellation: vscode.Disposable | undefined;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timer); cancellation?.dispose(); operation();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new ReviewStop('budget', t.timeLimit)));
      services.cancel();
    }, Math.max(1, deadline - services.now()));
    cancellation = services.token.onCancellationRequested?.(() => finish(() => reject(new ReviewStop('cancelled', t.cancelled))));
    if (services.token.isCancellationRequested) finish(() => reject(new ReviewStop('cancelled', t.cancelled)));
    work.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
  const update = async () => { current(); await services.update(structuredClone(run)); };
  const limit = (reason: string) => { if (!run.limitations.includes(reason)) run.limitations.push(reason); };
  const fits = async (phase: BusinessModelPhase, payload: unknown) => {
    current();
    return JSON.stringify(payload).length <= BUSINESS_REVIEW_LIMITS.inputCharacters && await wait(services.fits(phase, payload));
  };
  const query = async <T>(phase: BusinessModelPhase, payload: unknown, parse: (value: unknown) => T): Promise<T> => {
    current();
    run.phase = phase;
    const key = businessHash(JSON.stringify([run.version, run.modelId, phase, payload]));
    const cached = run.cache.find((entry) => entry.key === key && entry.phase === phase);
    if (cached) return parse(cached.value);
    if (!await fits(phase, payload)) throw new ReviewStop('budget', t.inputLimit);
    if (run.calls >= BUSINESS_REVIEW_LIMITS.modelCalls) throw new ReviewStop('budget', t.callLimit);
    run.calls++;
    await update();
    const raw = await wait(services.request(phase, payload));
    current();
    const parsed = parse(raw);
    if (run.cache.length >= BUSINESS_REVIEW_LIMITS.modelCalls) run.cache.shift();
    run.cache.push({ key, phase, value: structuredClone(raw) });
    return parsed;
  };
  const evidencePayload = (evidence: readonly BusinessEvidence[]) => evidence.map((source) => ({
    id: source.id, kind: source.kind, path: source.path, side: source.side, sourceId: source.sourceId, version: source.version,
    hash: source.sourceHash, start: source.start, end: source.end, line: source.line, text: source.text,
  }));
  const remember = (evidence: BusinessEvidence[]) => { evidence.forEach((item) => known.set(item.id, item)); return evidence; };
  const materialEvidence = baseline.materials.flatMap((source) => remember(segmentBusinessEvidence({
    kind: 'material', side: 'material', path: source.path, sourceId: source.sourceId, version: source.version,
    sourceHash: source.hash, text: source.text,
  })));
  const makeSources = (path: string, side: 'head' | 'base', text: string): BusinessEvidence[] => {
    const hash = businessHash(text);
    run.dependencies[`${side}:${path}`] = hash;
    return remember(segmentBusinessEvidence({ kind: 'code', path, side, sourceHash: hash, text }));
  };
  const split = (source: BusinessEvidence): BusinessEvidence[] => {
    const middle = Math.floor(source.text.length / 2);
    if (middle < 256) throw new ReviewStop('budget', t.inputLimit);
    return [0, middle].map((offset, index) => {
      const text = source.text.slice(offset, index === 0 ? middle : undefined);
      const start = source.start + offset;
      const item = {
        ...source, text, start, end: start + text.length,
        line: source.line + (source.text.slice(0, offset).match(/\n/g) ?? []).length,
        id: `ev-${businessHash(`${source.id}:${start}:${text.length}`).slice(0, 24)}`,
      };
      known.set(item.id, item);
      return item;
    });
  };
  const batches = async (
    phase: BusinessModelPhase, sources: BusinessEvidence[], body: Record<string, unknown>,
  ): Promise<BusinessEvidence[][]> => {
    const result: BusinessEvidence[][] = [];
    const queue = [...sources];
    let batch: BusinessEvidence[] = [];
    while (queue.length) {
      current();
      const source = queue.shift()!;
      const next = [...batch, source];
      if (await fits(phase, { ...common, ...body, evidence: evidencePayload(next) })) batch = next;
      else if (batch.length) { result.push(batch); batch = []; queue.unshift(source); }
      else queue.unshift(...split(source));
    }
    if (batch.length) result.push(batch);
    return result;
  };
  const coverageFor = (source: BusinessEvidence) => run.coverage.find((entry) => entry.path === source.path && entry.side === source.side);
  const reviewed = (source: BusinessEvidence) => {
    if (source.kind !== 'code') return;
    const entry = coverageFor(source);
    if (!entry) return;
    entry.reviewed.push({ start: source.start, end: source.end });
    entry.status = 'reviewed';
    if (!coverageComplete(entry)) entry.status = 'read';
  };
  const addDiscovery = (discovery: BusinessDiscovery) => {
    const available = BUSINESS_REVIEW_LIMITS.findings - run.candidates.length;
    run.candidates.push(...discovery.candidates.slice(0, available));
    requests.push(...discovery.requests);
    if (discovery.candidates.length > available) throw new ReviewStop('budget', t.findingLimit);
  };
  const fetchEvidence = async (): Promise<void> => {
    run.phase = 'evidence';
    const seen = new Set(run.requests.map((entry) => JSON.stringify(entry.request)));
    const related = new Set(originals.filter((entry) => entry.kind === 'code' && !roots.some((file) => file.path === entry.path)).map((entry) => entry.path));
    for (const request of requests) {
      current();
      const identity = JSON.stringify(request);
      if (seen.has(identity)) continue;
      if (run.requests.length >= BUSINESS_REVIEW_LIMITS.evidenceRequests) { limit(t.relatedLimit); break; }
      seen.add(identity);
      const record: BusinessReviewRun['requests'][number] = { request, paths: [] };
      run.requests.push(record);
      try {
        const paths = await wait(services.resolve(request));
        current();
        for (const path of [...new Set(paths)]) {
          if (originals.some((entry) => entry.kind === 'code' && entry.path === path && entry.side === 'head')) {
            record.paths.push(path);
            continue;
          }
          if (related.size >= BUSINESS_REVIEW_LIMITS.relatedFiles) { limit(t.relatedLimit); break; }
          const text = await wait(services.read(path, 'head'));
          current();
          originals.push(...makeSources(path, 'head', text));
          related.add(path);
          record.paths.push(path);
        }
        if (!record.paths.length) record.error = t.evidenceFailure;
      } catch (error) {
        if (error instanceof ReviewStop) throw error;
        record.error = `${t.evidenceFailure} ${String((error as Error).message)}`;
      }
    }
    await update();
  };

  try {
    const reads = roots.flatMap((file, index) => {
      const sides: ('head' | 'base')[] = [
        ...(file.status !== 'deleted' ? ['head' as const] : []),
        ...((file.status === 'deleted' || set.comparison && file.status !== 'added') ? ['base' as const] : []),
      ];
      return sides.map((side) => {
        const path = side === 'base' ? file.previousPath ?? file.path : file.path;
        const entry: BusinessCoverage = { path, side, characters: 0, reviewed: [], status: 'pending' };
        run.coverage.push(entry);
        if (index >= BUSINESS_REVIEW_LIMITS.files) { entry.status = 'limited'; limit(t.fileLimit); }
        return entry;
      });
    });
    for (const entry of reads) {
        if (entry.status === 'limited') continue;
        const { path, side } = entry;
        current();
        try {
          const text = await wait(services.read(path, side));
          current();
          const sources = makeSources(path, side, text);
          entry.hash = businessHash(text);
          entry.characters = text.replace(/\r\n/g, '\n').length;
          entry.status = 'read';
          originals.push(...sources);
        } catch (error) {
          if (error instanceof ReviewStop) throw error;
          entry.status = 'failed'; entry.error = String((error as Error).message);
          run.errors.push(`${t.readFailure} ${side}:${path}: ${entry.error}`);
        }
    }
    for (const item of legacy.slice(0, BUSINESS_REVIEW_LIMITS.findings)) {
      current();
      if (!originals.some((source) => source.path === item.path && source.side === 'head')) {
        try {
          if (new Set(originals.map((source) => source.path)).size - roots.length >= BUSINESS_REVIEW_LIMITS.relatedFiles) {
            limit(t.relatedLimit);
          } else {
            originals.push(...makeSources(item.path, 'head', await wait(services.read(item.path, 'head'))));
          }
        } catch (error) {
          if (error instanceof ReviewStop) throw error;
          run.requests.push({
            request: { file: item.path, symbol: item.title, kind: 'contract', question: item.detail },
            paths: [], error: `${t.evidenceFailure} ${String((error as Error).message)}`,
          });
        }
      }
      const source = originals.find((source) => source.path === item.path && source.side === 'head'
        && item.anchor && source.text.includes(item.anchor) && source.text.indexOf(item.anchor) === source.text.lastIndexOf(item.anchor));
      const evidence = source && item.anchor ? businessCitations([{ evidenceId: source.id, quote: item.anchor }], [source]) : [];
      run.candidates.push({
        id: `legacy-${item.id}`, kind: 'question', title: item.title,
        cause: item.detail, trigger: t.legacyUnverified, impact: item.detail, requirementIds: [], evidence,
      });
    }
    if (legacy.length > BUSINESS_REVIEW_LIMITS.findings) limit(t.findingLimit);
    await update();
    const readable = roots.slice(0, BUSINESS_REVIEW_LIMITS.files).map((file) => file.path);
    const manifest = roots.slice(0, BUSINESS_REVIEW_LIMITS.files).map((file) => ({
      ...file, sides: (['head', 'base'] as const).flatMap((side) => {
        const sources = originals.filter((source) => source.kind === 'code' && source.side === side && [file.path, file.previousPath].includes(source.path));
        if (!sources.length) return [];
        return [{
          side, hash: sources[0].sourceHash, characters: sources.reduce((sum, source) => sum + source.text.length, 0),
          // Only a planning preview; this is never counted as reviewed coverage.
          preview: sources[0].text.slice(0, 1000),
        }];
      }),
    }));
    run.units = await query('plan', { ...common, files: manifest }, (value) => parseBusinessPlan(value, readable, baseline));
    await update();
    for (const unit of run.units) {
      const unitRoots = roots.filter((file) => unit.files.includes(file.path));
      const sourcePaths = unitRoots.flatMap((file) => [file.path, ...(file.previousPath ? [file.previousPath] : [])]);
      const sources = [...originals.filter((source) => source.kind === 'code' && sourcePaths.includes(source.path)), ...materialEvidence];
      const groups = await batches('discover', sources, { unit });
      for (const [index, group] of groups.entries()) {
        current();
        const payload = { ...common, unit, evidence: evidencePayload(group) };
        try {
          const result = await query('discover', payload, (value) => parseBusinessDiscovery(value, group, baseline, `${unit.id}-${index}`));
          addDiscovery(result);
          group.forEach(reviewed);
          run.unitSummaries.push({ id: `${unit.id}-${index}`, text: result.summary, evidenceIds: group.map((source) => source.id) });
        } catch (error) {
          if (error instanceof ReviewStop) throw error;
          run.errors.push(`${unit.id}: ${String((error as Error).message)}`);
        }
        await update();
      }
    }
    await fetchEvidence();
    for (let pass = 0; pass < 2; pass++) {
      current();
      const all = [...originals, ...materialEvidence];
      const group: BusinessEvidence[] = [];
      const body = { ...common, units: run.units, summaries: run.unitSummaries, earlierCandidates: run.candidates, requests: run.requests };
      for (const source of all) {
        if (await fits('global', { ...body, evidence: evidencePayload([...group, source]) })) group.push(source);
        else limit(t.globalLimit);
      }
      // This always runs, including when no local candidate was found.
      const result = await query('global', { ...body, evidence: evidencePayload(group) },
        (value) => parseBusinessDiscovery(value, group, baseline, `global-${pass}`));
      run.globalCompleted = true;
      addDiscovery(result);
      const before = Object.keys(run.dependencies).length;
      await fetchEvidence();
      if (Object.keys(run.dependencies).length === before) break;
      if (pass === 1) limit(t.globalLimit);
    }
    const pending = [...run.candidates];
    while (pending.length) {
      current();
      const candidate = pending.shift()!;
      const group = [candidate];
      const requiredSources = (candidates: BusinessCandidate[]) => [...new Set(candidates.flatMap((entry) => entry.evidence.map((ref) => ref.evidenceId)))]
        .map((id) => known.get(id)).filter((source): source is BusinessEvidence => !!source);
      let evidence = requiredSources(group);
      const body = { ...common, units: run.units, summaries: run.unitSummaries, requests: run.requests };
      while (pending.length) {
        const next = [...group, pending[0]];
        if (!await fits('verify', { ...body, candidates: next, evidence: evidencePayload(requiredSources(next)) })) break;
        group.push(pending.shift()!);
        evidence = requiredSources(group);
      }
      for (const source of [...originals, ...materialEvidence]) {
        if (evidence.some((entry) => entry.id === source.id)) continue;
        if (await fits('verify', { ...body, candidates: group, evidence: evidencePayload([...evidence, source]) })) evidence.push(source);
        else limit(t.verifyLimit);
      }
      try {
        const verified = await query('verify', { ...body, candidates: group, evidence: evidencePayload(evidence) },
          (value) => parseBusinessVerification(value, group, evidence, baseline));
        run.findings.push(...verified);
      } catch (error) {
        if (error instanceof ReviewStop) throw error;
        const reason = String((error as Error).message);
        run.errors.push(reason);
        run.findings.push(...group.map((entry) => unresolved(entry, reason)));
      }
      await update();
    }
    // Exactly matching verified causes can share one result; neither file count nor title is identity.
    const merged = mergeBusinessFindings(run.findings);
    run.findings = merged.findings;
    if (merged.conflicting) run.errors.push(t.inconsistentRoot);
    const assessmentEvidence = [...new Set([
      ...run.findings.flatMap((finding) => [...finding.evidence, ...finding.counterEvidence].map((ref) => ref.evidenceId)),
      ...materialEvidence.map((source) => source.id),
    ])].map((id) => known.get(id)).filter((source): source is BusinessEvidence => !!source);
    for (const source of originals) {
      if (!assessmentEvidence.some((entry) => entry.id === source.id)
        && await fits('assess', { ...common, findings: run.findings, evidence: evidencePayload([...assessmentEvidence, source]) })) assessmentEvidence.push(source);
    }
    Object.assign(run, await query('assess', {
      ...common, findings: run.findings, coverage: run.coverage, limitations: run.limitations, errors: run.errors,
      evidence: evidencePayload(assessmentEvidence),
    }, (value) => parseBusinessAssessment(value, baseline, run.findings, assessmentEvidence, priorCritical)));
    for (const [key, expected] of Object.entries(run.dependencies)) {
      current();
      const colon = key.indexOf(':');
      const side = key.slice(0, colon);
      if (side !== 'head' && side !== 'base') throw new Error(t.invalidOutput);
      const text = await wait((services.readFresh ?? services.read)(key.slice(colon + 1), side));
      if (businessHash(text) !== expected) throw new ReviewStop('stale', t.stale);
    }
    current();
    run.status = run.errors.length || run.limitations.length || run.coverage.some((entry) => !coverageComplete(entry)) ? 'partial' : 'completed';
  } catch (error) {
    if (error instanceof ReviewStop) {
      run.status = error.reason === 'cancelled' ? 'cancelled' : error.reason === 'stale' ? 'stale' : 'partial';
      if (error.reason === 'budget') limit(error.message);
      else run.errors.push(error.message);
    } else {
      run.status = 'failed';
      run.errors.push(String((error as Error).message));
    }
    const decided = new Set(run.findings.flatMap((finding) => finding.candidateIds));
    run.findings.push(...run.candidates.filter((candidate) => !decided.has(candidate.id)).map((candidate) => unresolved(candidate, run.errors.at(-1) ?? run.limitations.at(-1) ?? t.incomplete)));
  }
  run.finishedAt = services.now();
  // Cancellation/staleness deliberately bypass current(): the final incomplete state must be saved.
  await services.update(structuredClone(run));
  return run;
}
