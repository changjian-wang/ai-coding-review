import { createHash, randomUUID } from 'node:crypto';
import { m } from '../i18n';
import type { ReviewSet } from '../scope/types';
import {
  currentMaterial, requirementFingerprint, requirementReadiness, requirementScopeKey, selectedMaterials,
  type RequirementItem, type RequirementOrigin, type RequirementQuestion, type RequirementsDraft,
} from './requirements';

export const BUSINESS_REVIEW_VERSION = 'business-review-v1';
export const BUSINESS_REVIEW_LIMITS = {
  files: 80, units: 24, segmentCharacters: 16_000, inputCharacters: 100_000,
  evidenceRequests: 24, relatedFiles: 24, modelCalls: 128, durationMs: 180_000, findings: 80,
} as const;

export type BusinessReviewPhase = 'read' | 'plan' | 'discover' | 'global' | 'evidence' | 'verify' | 'assess';
export type BusinessModelPhase = Exclude<BusinessReviewPhase, 'read' | 'evidence'>;
export type BusinessReviewStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'stale';
export interface BusinessCitation {
  evidenceId: string;
  kind: 'code' | 'material';
  path: string;
  side: 'head' | 'base' | 'material';
  sourceId?: string;
  version?: number;
  sourceHash: string;
  line: number;
  endLine: number;
  quote: string;
}
export interface BusinessEvidence {
  id: string;
  kind: 'code' | 'material';
  path: string;
  side: BusinessCitation['side'];
  sourceId?: string;
  version?: number;
  sourceHash: string;
  start: number;
  end: number;
  line: number;
  text: string;
}
export interface BusinessCriticalPremise {
  dependsOn: string;
  impact: string;
  missingEvidence: string;
  question: string;
}
export interface BusinessCandidate {
  id: string;
  title: string;
  kind: 'implementation' | 'requirement' | 'question';
  cause: string;
  trigger: string;
  impact: string;
  requirementIds: string[];
  evidence: BusinessCitation[];
}
export interface BusinessFinding extends Omit<BusinessCandidate, 'id' | 'kind'> {
  id: string;
  candidateIds: string[];
  kind: BusinessCandidate['kind'] | 'reasonable';
  status: 'confirmed' | 'dismissed' | 'unresolved';
  severity: 'high' | 'medium' | 'low';
  attribution: 'introduced' | 'existing' | 'exposed' | 'unknown';
  counterEvidence: BusinessCitation[];
  counterRationale: string;
  critical: BusinessCriticalPremise | null;
}
export interface BusinessRequirementVerdict {
  id: string;
  status: 'supported' | 'violated' | 'unknown' | 'not-applicable';
  rationale: string;
  evidence: BusinessCitation[];
  critical: BusinessCriticalPremise | null;
}
export interface BusinessPremiseVerdict {
  id: string;
  status: 'clarified' | 'unknown';
  rationale: string;
  evidence: BusinessCitation[];
  critical: BusinessCriticalPremise | null;
}
export interface BusinessPriorCriticalVerdict {
  id: string;
  status: 'cleared' | 'remains' | 'unknown';
  rationale: string;
  evidence: BusinessCitation[];
}
export interface BusinessUnit {
  id: string;
  goal: string;
  files: string[];
  requirementIds: string[];
}
export interface BusinessCoverage {
  path: string;
  side: 'head' | 'base';
  hash?: string;
  characters: number;
  reviewed: { start: number; end: number }[];
  status: 'pending' | 'read' | 'reviewed' | 'failed' | 'limited';
  error?: string;
}
export interface BusinessEvidenceRequest {
  file: string;
  symbol: string;
  kind: 'definition' | 'references' | 'tests' | 'configuration' | 'contract';
  question: string;
}
export interface BusinessDiscovery {
  summary: string;
  candidates: BusinessCandidate[];
  requests: BusinessEvidenceRequest[];
}
export interface BusinessPriorCritical {
  id: string;
  title: string;
  detail: string;
  normativeOrigins?: RequirementOrigin[];
}
export interface BusinessReviewRun {
  version: typeof BUSINESS_REVIEW_VERSION;
  id: string;
  bindingKey: string;
  status: BusinessReviewStatus;
  phase: BusinessReviewPhase;
  mode: 'requirements' | 'technical';
  modelId: string;
  scope: { label: string; repository: string; headSha: string; baseSha?: string; baseTipSha?: string };
  baseline: {
    requirements: RequirementItem[]; questions: RequirementQuestion[]; excluded: RequirementItem[];
    materials: { sourceId: string; version: number; path: string; hash: string }[];
  };
  startedAt: number;
  finishedAt?: number;
  calls: number;
  globalCompleted: boolean;
  coverage: BusinessCoverage[];
  units: BusinessUnit[];
  unitSummaries: { id: string; text: string; evidenceIds: string[] }[];
  candidates: BusinessCandidate[];
  findings: BusinessFinding[];
  requirements: BusinessRequirementVerdict[];
  premises: BusinessPremiseVerdict[];
  priorCritical: BusinessPriorCritical[];
  priorCriticalVerdicts: BusinessPriorCriticalVerdict[];
  requests: { request: BusinessEvidenceRequest; paths: string[]; error?: string }[];
  dependencies: Record<string, string>;
  limitations: string[];
  errors: string[];
  cache: { key: string; phase: BusinessModelPhase; value: unknown }[];
  confirmed: boolean;
  dispositions: Record<string, { kind: 'commented' | 'not-applicable'; reason: string; at: number }>;
}
export interface BusinessBaseline {
  scope: BusinessReviewRun['scope'];
  scopeKey: string;
  bindingKey: string;
  mode: BusinessReviewRun['mode'];
  requirements: RequirementItem[];
  questions: RequirementQuestion[];
  excluded: RequirementItem[];
  materials: { sourceId: string; version: number; path: string; text: string; hash: string }[];
}

export const businessHash = (value: string): string => createHash('sha256').update(value).digest('hex');

export function businessBindingKey(cwd: string, set: ReviewSet, draft?: RequirementsDraft): string {
  const scopeKey = requirementScopeKey(cwd, set);
  return businessHash(JSON.stringify([
    BUSINESS_REVIEW_VERSION, scopeKey, draft ? requirementFingerprint(draft, scopeKey) : null,
    draft?.confirmation?.fingerprint, draft?.technicalOnly === true,
  ]));
}

export function businessBaseline(cwd: string, set: ReviewSet, draft?: RequirementsDraft): BusinessBaseline {
  const scopeKey = requirementScopeKey(cwd, set);
  const readiness = draft ? requirementReadiness(draft, scopeKey) : undefined;
  if (draft && selectedMaterials(draft).length && !draft.technicalOnly && !readiness?.confirmed) throw new Error(m().businessReview.baselineRequired);
  const requirements = draft && !draft.technicalOnly && readiness?.confirmed
    ? draft.understanding?.requirements.filter((item) => item.included) ?? [] : [];
  return {
    scope: { label: set.label, repository: set.repositoryIdentity ?? cwd, headSha: set.headSha, baseSha: set.comparison?.baseSha, baseTipSha: set.source?.baseTipSha },
    scopeKey, bindingKey: businessBindingKey(cwd, set, draft),
    mode: requirements.length ? 'requirements' : 'technical', requirements,
    questions: draft && !draft.technicalOnly && readiness?.confirmed ? draft.understanding?.questions ?? [] : [],
    excluded: draft && !draft.technicalOnly && readiness?.confirmed ? draft.understanding?.requirements.filter((item) => !item.included) ?? [] : [],
    materials: draft ? selectedMaterials(draft).map((source) => {
      const current = currentMaterial(source);
      return { sourceId: source.id, version: current.version, path: source.location, text: current.text, hash: current.hash };
    }) : [],
  };
}

export function createBusinessRun(baseline: BusinessBaseline, modelId: string, priorCritical: BusinessPriorCritical[] = []): BusinessReviewRun {
  return {
    version: BUSINESS_REVIEW_VERSION, id: randomUUID(), bindingKey: baseline.bindingKey,
    status: 'running', phase: 'read', mode: baseline.mode, modelId, startedAt: Date.now(), calls: 0, globalCompleted: false,
    scope: structuredClone(baseline.scope),
    baseline: structuredClone({
      requirements: baseline.requirements, questions: baseline.questions, excluded: baseline.excluded,
      materials: baseline.materials.map(({ sourceId, version, path, hash }) => ({ sourceId, version, path, hash })),
    }),
    coverage: [], units: [], unitSummaries: [], candidates: [], findings: [], requirements: [], premises: [],
    priorCritical, priorCriticalVerdicts: [], requests: [], dependencies: {}, limitations: [], errors: [],
    cache: [], confirmed: false, dispositions: {},
  };
}

export function segmentBusinessEvidence(
  source: Omit<BusinessEvidence, 'id' | 'text' | 'start' | 'end' | 'line'> & { text: string },
  maximum = BUSINESS_REVIEW_LIMITS.segmentCharacters,
): BusinessEvidence[] {
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error(m().businessReview.invalidOutput);
  const normalized = source.text.replace(/\r\n/g, '\n');
  const result: BusinessEvidence[] = [];
  let start = 0;
  let line = 1;
  do {
    let end = Math.min(normalized.length, start + maximum);
    if (end < normalized.length) {
      const newline = normalized.lastIndexOf('\n', end - 1);
      if (newline >= start + Math.floor(maximum / 2)) end = newline + 1;
    }
    const text = normalized.slice(start, end);
    const id = `ev-${businessHash(JSON.stringify([source.kind, source.path, source.side, source.sourceId, source.version, source.sourceHash, start, end])).slice(0, 24)}`;
    result.push({ ...source, id, text, start, end, line });
    line += (text.match(/\n/g) ?? []).length;
    start = end;
  } while (start < normalized.length);
  return result;
}

export function coverageComplete(coverage: BusinessCoverage): boolean {
  if (coverage.status !== 'reviewed') return false;
  let end = 0;
  for (const span of [...coverage.reviewed].sort((a, b) => a.start - b.start)) {
    if (span.start > end || span.end < span.start || span.end > coverage.characters) return false;
    end = Math.max(end, span.end);
  }
  return end === coverage.characters;
}

export function businessRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(m().businessReview.invalidOutput);
  return value as Record<string, unknown>;
}
export function businessText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000) throw new Error(m().businessReview.invalidOutput);
  return value;
}
export function businessList(value: unknown, max: number = BUSINESS_REVIEW_LIMITS.findings): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(m().businessReview.invalidOutput);
  return value;
}
function names(value: unknown): string[] {
  return businessList(value).map(businessText);
}
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new Error(m().businessReview.invalidOutput);
}
function requireKnown(values: readonly string[], available: readonly string[]): void {
  unique(values);
  if (values.some((value) => !available.includes(value))) throw new Error(m().businessReview.invalidOutput);
}
export function businessCritical(value: unknown): BusinessCriticalPremise | null {
  if (value === null) return null;
  const critical = businessRecord(value);
  return {
    dependsOn: businessText(critical.dependsOn), impact: businessText(critical.impact),
    missingEvidence: businessText(critical.missingEvidence), question: businessText(critical.question),
  };
}

export function businessCitations(value: unknown, evidence: readonly BusinessEvidence[]): BusinessCitation[] {
  return businessList(value).map((entry) => {
    const cite = businessRecord(entry);
    const id = businessText(cite.evidenceId);
    const quote = businessText(cite.quote);
    const source = evidence.find((item) => item.id === id);
    const offset = source?.text.indexOf(quote) ?? -1;
    if (!source || offset < 0 || source.text.indexOf(quote, offset + 1) >= 0) throw new Error(m().businessReview.invalidCitation);
    const line = source.line + (source.text.slice(0, offset).match(/\n/g) ?? []).length;
    return {
      evidenceId: id, kind: source.kind, path: source.path, side: source.side, sourceId: source.sourceId, version: source.version,
      sourceHash: source.sourceHash, line, endLine: line + (quote.match(/\n/g) ?? []).length, quote,
    };
  });
}

function hasIndependentFact(refs: readonly BusinessCitation[], origins: readonly RequirementOrigin[]): boolean {
  return refs.some((ref) => ref.kind === 'code' ? ref.side === 'head' : !origins.some((origin) =>
    origin.sourceId === ref.sourceId && origin.version === ref.version && origin.line <= ref.endLine && origin.endLine >= ref.line
      || origin.quote.includes(ref.quote),
  ));
}

export function parseBusinessPlan(value: unknown, files: readonly string[], baseline: BusinessBaseline): BusinessUnit[] {
  const units = businessList(businessRecord(value).units, BUSINESS_REVIEW_LIMITS.units).map((entry): BusinessUnit => {
    const item = businessRecord(entry);
    const members = names(item.files);
    if (!members.length) throw new Error(m().businessReview.invalidOutput);
    requireKnown(members, files);
    const requirementIds = names(item.requirementIds);
    requireKnown(requirementIds, baseline.requirements.map((item) => item.id));
    return { id: businessText(item.id), goal: businessText(item.goal), files: members, requirementIds };
  });
  unique(units.map((unit) => unit.id));
  if (!units.length || files.some((file) => !units.some((unit) => unit.files.includes(file)))) throw new Error(m().businessReview.incompletePlan);
  return units;
}

export function parseBusinessDiscovery(
  value: unknown, evidence: readonly BusinessEvidence[], baseline: BusinessBaseline, prefix: string,
): BusinessDiscovery {
  const root = businessRecord(value);
  const candidates = businessList(root.candidates).map((entry, index): BusinessCandidate => {
    const item = businessRecord(entry);
    const kind = item.kind;
    if (kind !== 'implementation' && kind !== 'requirement' && kind !== 'question') throw new Error(m().businessReview.invalidOutput);
    const requirementIds = names(item.requirementIds);
    requireKnown(requirementIds, baseline.requirements.map((requirement) => requirement.id));
    if (kind === 'requirement' && !requirementIds.length) throw new Error(m().businessReview.invalidOutput);
    const citations = businessCitations(item.evidence, evidence);
    if (!citations.length && (kind !== 'requirement' || requirementIds.length < 2)) throw new Error(m().businessReview.invalidCitation);
    return {
      id: `${prefix}-${index}`, kind, title: businessText(item.title), cause: businessText(item.cause),
      trigger: businessText(item.trigger), impact: businessText(item.impact), requirementIds, evidence: citations,
    };
  });
  const requests = businessList(root.requests, BUSINESS_REVIEW_LIMITS.evidenceRequests).map((entry): BusinessEvidenceRequest => {
    const item = businessRecord(entry);
    const file = businessText(item.file);
    const kind = item.kind;
    if (!evidence.some((source) => source.kind === 'code' && source.path === file)
      || kind !== 'definition' && kind !== 'references' && kind !== 'tests' && kind !== 'configuration' && kind !== 'contract') {
      throw new Error(m().businessReview.invalidOutput);
    }
    return { file, kind, symbol: businessText(item.symbol), question: businessText(item.question) };
  });
  return { summary: businessText(root.summary), candidates, requests };
}

export function parseBusinessVerification(
  value: unknown, candidates: readonly BusinessCandidate[], evidence: readonly BusinessEvidence[], baseline: BusinessBaseline,
): BusinessFinding[] {
  const covered: string[] = [];
  const findings = businessList(businessRecord(value).decisions).map((entry): BusinessFinding => {
    const item = businessRecord(entry);
    const candidateIds = names(item.candidateIds);
    if (!candidateIds.length) throw new Error(m().businessReview.invalidOutput);
    requireKnown(candidateIds, candidates.map((candidate) => candidate.id));
    covered.push(...candidateIds);
    const status = item.status;
    const kind = item.kind;
    const severity = item.severity;
    const attribution = item.attribution;
    if (status !== 'confirmed' && status !== 'dismissed' && status !== 'unresolved'
      || kind !== 'implementation' && kind !== 'requirement' && kind !== 'question' && kind !== 'reasonable'
      || severity !== 'high' && severity !== 'medium' && severity !== 'low'
      || attribution !== 'introduced' && attribution !== 'existing' && attribution !== 'exposed' && attribution !== 'unknown') throw new Error(m().businessReview.invalidOutput);
    const requirementIds = names(item.requirementIds);
    requireKnown(requirementIds, baseline.requirements.map((requirement) => requirement.id));
    const support = businessCitations(item.evidence, evidence);
    const counter = businessCitations(item.counterEvidence, evidence);
    if (attribution !== 'unknown' && (!baseline.scope.baseSha
      || ![...support, ...counter].some((ref) => ref.kind === 'code' && ref.side === 'base')
      || ![...support, ...counter].some((ref) => ref.kind === 'code' && ref.side === 'head'))) {
      throw new Error(m().businessReview.inconsistentAssessment);
    }
    if (status === 'confirmed' && kind !== 'implementation' && kind !== 'requirement'
      || kind === 'reasonable' && status !== 'dismissed' || kind === 'question' && status !== 'unresolved'
      || status === 'dismissed' && !counter.length
      || status === 'confirmed' && kind === 'implementation' && !support.some((ref) => ref.kind === 'code' && ref.side === 'head')
      || kind === 'requirement' && !requirementIds.length
      || status === 'confirmed' && kind === 'requirement' && requirementIds.length < 2
        && !hasIndependentFact(support, [...baseline.requirements, ...baseline.excluded].flatMap((item) => item.origins))) {
      throw new Error(m().businessReview.invalidCitation);
    }
    const cause = businessText(item.cause);
    const trigger = businessText(item.trigger);
    const impact = businessText(item.impact);
    // Duplicate locations are not identity: one causal mechanism + trigger + constraint is.
    const id = `br-${businessHash(JSON.stringify([kind, cause, trigger, [...requirementIds].sort()])).slice(0, 24)}`;
    return {
      id, candidateIds, kind, status, severity, attribution, cause, trigger, impact,
      title: businessText(item.title), requirementIds, evidence: support, counterEvidence: counter,
      counterRationale: businessText(item.counterRationale), critical: businessCritical(item.critical),
    };
  });
  unique(covered);
  if (candidates.some((candidate) => !covered.includes(candidate.id))) throw new Error(m().businessReview.missingDecision);
  return findings;
}

export function parseBusinessAssessment(
  value: unknown, baseline: BusinessBaseline, findings: readonly BusinessFinding[], evidence: readonly BusinessEvidence[], prior: readonly BusinessPriorCritical[],
): Pick<BusinessReviewRun, 'requirements' | 'premises' | 'priorCriticalVerdicts'> {
  const root = businessRecord(value);
  const requirements = businessList(root.requirements).map((entry): BusinessRequirementVerdict => {
    const item = businessRecord(entry);
    const id = businessText(item.id);
    if (!baseline.requirements.some((requirement) => requirement.id === id)) throw new Error(m().businessReview.invalidOutput);
    const status = item.status;
    if (status !== 'supported' && status !== 'violated' && status !== 'unknown') throw new Error(m().businessReview.invalidOutput);
    const refs = businessCitations(item.evidence, evidence);
    if (status === 'supported' && !refs.some((ref) => ref.kind === 'code' && ref.side === 'head')
      || status === 'supported' && findings.some((finding) => finding.status === 'confirmed' && finding.requirementIds.includes(id))
      || status === 'violated' && !findings.some((finding) => finding.status === 'confirmed' && finding.requirementIds.includes(id))) {
      throw new Error(m().businessReview.inconsistentAssessment);
    }
    const critical = businessCritical(item.critical);
    if (status !== 'unknown' && critical) throw new Error(m().businessReview.invalidOutput);
    return { id, status, evidence: refs, critical, rationale: businessText(item.rationale) };
  });
  requireKnown(requirements.map((item) => item.id), baseline.requirements.map((item) => item.id));
  if (requirements.length !== baseline.requirements.length) throw new Error(m().businessReview.missingDecision);
  requirements.push(...baseline.excluded.map((item): BusinessRequirementVerdict => ({
    id: item.id, status: 'not-applicable', rationale: item.exclusionReason, evidence: [], critical: null,
  })));
  const premises = businessList(root.premises).map((entry): BusinessPremiseVerdict => {
    const item = businessRecord(entry);
    const status = item.status;
    if (status !== 'clarified' && status !== 'unknown') throw new Error(m().businessReview.invalidOutput);
    const refs = businessCitations(item.evidence, evidence);
    const critical = businessCritical(item.critical);
    const independent = hasIndependentFact(refs, [...baseline.requirements, ...baseline.excluded].flatMap((item) => item.origins));
    if (status === 'clarified' && (!independent || critical)) throw new Error(m().businessReview.invalidCitation);
    return { id: businessText(item.id), status, rationale: businessText(item.rationale), evidence: refs, critical };
  });
  requireKnown(premises.map((item) => item.id), baseline.questions.map((item) => item.id));
  if (premises.length !== baseline.questions.length) throw new Error(m().businessReview.missingDecision);
  const priorCriticalVerdicts = businessList(root.priorCritical, Math.max(prior.length, BUSINESS_REVIEW_LIMITS.findings)).map((entry): BusinessPriorCriticalVerdict => {
    const item = businessRecord(entry);
    const status = item.status;
    if (status !== 'cleared' && status !== 'remains' && status !== 'unknown') throw new Error(m().businessReview.invalidOutput);
    const refs = businessCitations(item.evidence, evidence);
    const origins = [
      ...[...baseline.requirements, ...baseline.excluded].flatMap((requirement) => requirement.origins),
      ...(prior.find((prior) => prior.id === item.id)?.normativeOrigins ?? []),
    ];
    const independent = hasIndependentFact(refs, origins);
    if (status === 'cleared' && !independent) throw new Error(m().businessReview.invalidCitation);
    return { id: businessText(item.id), status, rationale: businessText(item.rationale), evidence: refs };
  });
  requireKnown(priorCriticalVerdicts.map((item) => item.id), prior.map((item) => item.id));
  if (priorCriticalVerdicts.length !== prior.length) throw new Error(m().businessReview.missingDecision);
  return { requirements, premises, priorCriticalVerdicts };
}

export function businessBlockers(run: BusinessReviewRun): string[] {
  const reasons: string[] = [];
  if (run.status !== 'completed' || !run.globalCompleted || run.errors.length || run.limitations.length) reasons.push(m().businessReview.incomplete);
  if (!run.coverage.length || run.coverage.some((item) => !coverageComplete(item))) reasons.push(m().businessReview.incompleteCoverage);
  if (run.findings.some((finding) => finding.critical && finding.status !== 'dismissed')
    || run.requirements.some((item) => item.critical) || run.premises.some((item) => item.critical)
    || run.priorCriticalVerdicts.some((item) => item.status !== 'cleared')
    || run.priorCriticalVerdicts.length !== run.priorCritical.length) reasons.push(m().businessReview.criticalBlocked);
  if (run.findings.some((finding) => finding.status === 'confirmed')) reasons.push(m().businessReview.defectsBlocked);
  if (!run.confirmed) reasons.push(m().businessReview.humanConfirm);
  return reasons;
}

export function businessKnownCritical(run: BusinessReviewRun | undefined): BusinessPriorCritical[] {
  if (!run) return [];
  return [
    ...run.findings.filter((item) => item.status !== 'dismissed' && (item.critical || item.status === 'confirmed' && item.severity === 'high')).map((item) => ({
      id: `finding-${businessHash(JSON.stringify([item.id, item.critical?.dependsOn, item.critical?.question])).slice(0, 24)}`,
      title: item.title,
      detail: [
        item.cause, ...run.baseline.requirements.filter((rule) => item.requirementIds.includes(rule.id)).map((rule) => rule.text),
        ...(item.critical ? [item.critical.dependsOn, item.critical.impact, item.critical.missingEvidence, item.critical.question] : [item.trigger, item.impact, item.counterRationale]),
      ].join('\n'),
      normativeOrigins: run.baseline.requirements.filter((rule) => item.requirementIds.includes(rule.id)).flatMap((rule) => rule.origins),
    })),
    ...run.requirements.filter((item) => item.critical).map((item) => {
      const rule = run.baseline.requirements.find((rule) => rule.id === item.id);
      return {
        id: `req-${businessHash(JSON.stringify([rule?.text, item.critical?.dependsOn, item.critical?.question])).slice(0, 24)}`,
        title: rule?.title ?? item.id, detail: `${rule?.text ?? ''}\n${item.rationale}\n${item.critical?.dependsOn}\n${item.critical?.impact}\n${item.critical?.missingEvidence}\n${item.critical?.question}`,
        normativeOrigins: rule?.origins ?? [],
      };
    }),
    ...run.premises.filter((item) => item.critical).map((item) => ({
      id: `premise-${businessHash(JSON.stringify([run.baseline.questions.find((question) => question.id === item.id)?.text, item.critical?.dependsOn, item.critical?.question])).slice(0, 24)}`,
      title: run.baseline.questions.find((question) => question.id === item.id)?.text ?? item.id,
      detail: `${item.rationale}\n${item.critical?.dependsOn}\n${item.critical?.impact}\n${item.critical?.missingEvidence}\n${item.critical?.question}`,
      normativeOrigins: [...run.baseline.requirements, ...run.baseline.excluded].flatMap((rule) => rule.origins),
    })),
    ...run.priorCritical.filter((item) => !run.priorCriticalVerdicts.some((verdict) => verdict.id === item.id && verdict.status === 'cleared')),
  ].filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index);
}

export function mergeBusinessFindings(findings: BusinessFinding[]): { findings: BusinessFinding[]; conflicting: boolean } {
  const results = new Map<string, BusinessFinding>();
  let conflicting = false;
  for (const finding of findings) {
    const previous = results.get(finding.id);
    if (!previous) { results.set(finding.id, structuredClone(finding)); continue; }
    if (previous.status !== finding.status) { previous.status = 'unresolved'; conflicting = true; }
    if (previous.attribution !== finding.attribution) previous.attribution = 'unknown';
    if (finding.severity === 'high' || previous.severity === 'low') previous.severity = finding.severity;
    previous.candidateIds = [...new Set([...previous.candidateIds, ...finding.candidateIds])];
    for (const key of ['evidence', 'counterEvidence'] as const) {
      previous[key] = [...previous[key], ...finding[key]].filter((ref, index, all) => all.findIndex((item) =>
        item.evidenceId === ref.evidenceId && item.quote === ref.quote) === index);
    }
    if (previous.counterRationale !== finding.counterRationale) previous.counterRationale += `\n${finding.counterRationale}`;
    previous.critical ??= finding.critical;
  }
  return { findings: [...results.values()], conflicting };
}

function assertStoredRun(value: unknown): asserts value is BusinessReviewRun {
  const run = businessRecord(value);
  if (run.version !== BUSINESS_REVIEW_VERSION || typeof run.confirmed !== 'boolean' || typeof run.globalCompleted !== 'boolean'
    || !['running', 'completed', 'partial', 'failed', 'cancelled', 'stale'].includes(String(run.status))
    || !['read', 'plan', 'discover', 'global', 'evidence', 'verify', 'assess'].includes(String(run.phase))
    || !['requirements', 'technical'].includes(String(run.mode))) throw new Error(m().businessReview.invalidOutput);
  for (const key of ['id', 'bindingKey', 'modelId']) businessText(run[key]);
  const scope = businessRecord(run.scope);
  for (const key of ['label', 'repository', 'headSha']) businessText(scope[key]);
  if (scope.baseSha !== undefined) businessText(scope.baseSha);
  if (scope.baseTipSha !== undefined) businessText(scope.baseTipSha);
  for (const key of ['startedAt', 'calls']) {
    if (typeof run[key] !== 'number' || !Number.isFinite(run[key]) || Number(run[key]) < 0) throw new Error(m().businessReview.invalidOutput);
  }
  if (!Number.isInteger(run.calls) || Number(run.calls) > BUSINESS_REVIEW_LIMITS.modelCalls
    || run.finishedAt !== undefined && (typeof run.finishedAt !== 'number' || !Number.isFinite(run.finishedAt))) throw new Error(m().businessReview.invalidOutput);
  const array = (value: unknown) => businessList(value, 1_000_000);
  const storedText = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(m().businessReview.invalidOutput);
  };
  const storedOrigin = (value: unknown) => {
    const origin = businessRecord(value);
    businessText(origin.sourceId); storedText(origin.quote);
    if (!Number.isInteger(origin.version) || !Number.isInteger(origin.line) || !Number.isInteger(origin.endLine)
      || Number(origin.version) < 1 || Number(origin.line) < 1 || Number(origin.endLine) < Number(origin.line)) throw new Error(m().businessReview.invalidOutput);
  };
  const storedCitation = (value: unknown) => {
    const ref = businessRecord(value);
    for (const key of ['evidenceId', 'path', 'sourceHash', 'quote']) businessText(ref[key]);
    if (!['head', 'base', 'material'].includes(String(ref.side)) || !['code', 'material'].includes(String(ref.kind))
      || !Number.isInteger(ref.line) || !Number.isInteger(ref.endLine) || Number(ref.line) < 1 || Number(ref.endLine) < Number(ref.line)
      || ref.sourceId !== undefined && typeof ref.sourceId !== 'string' || ref.version !== undefined && !Number.isInteger(ref.version)) {
      throw new Error(m().businessReview.invalidOutput);
    }
  };
  const refs = (value: unknown) => array(value).forEach(storedCitation);
  const baseline = businessRecord(run.baseline);
  businessList(baseline.materials).forEach((entry) => {
    const source = businessRecord(entry);
    for (const key of ['sourceId', 'path', 'hash']) businessText(source[key]);
    if (!Number.isInteger(source.version)) throw new Error(m().businessReview.invalidOutput);
  });
  const requirements = [...businessList(baseline.requirements), ...businessList(baseline.excluded)];
  requirements.forEach((value) => {
    const item = businessRecord(value);
    businessText(item.id);
    for (const key of ['title', 'text', 'extractedText']) storedText(item[key]);
    if (typeof item.included !== 'boolean' || typeof item.exclusionReason !== 'string' || !['explicit', 'human'].includes(String(item.basis))) throw new Error(m().businessReview.invalidOutput);
    businessList(item.origins).forEach(storedOrigin);
  });
  businessList(baseline.questions).forEach((entry) => {
    const question = businessRecord(entry);
    businessText(question.id); storedText(question.text); businessList(question.origins).forEach(storedOrigin);
  });
  array(run.coverage).forEach((entry) => {
    const item = businessRecord(entry);
    businessText(item.path);
    if (!['head', 'base'].includes(String(item.side)) || !['pending', 'read', 'reviewed', 'failed', 'limited'].includes(String(item.status))
      || !Number.isInteger(item.characters) || Number(item.characters) < 0 || item.hash !== undefined && typeof item.hash !== 'string'
      || item.error !== undefined && typeof item.error !== 'string') throw new Error(m().businessReview.invalidOutput);
    array(item.reviewed).forEach((entry) => {
      const span = businessRecord(entry);
      if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || Number(span.start) < 0 || Number(span.end) < Number(span.start)
        || Number(span.end) > Number(item.characters)) throw new Error(m().businessReview.invalidOutput);
    });
  });
  businessList(run.units, BUSINESS_REVIEW_LIMITS.units).forEach((entry) => {
    const unit = businessRecord(entry); businessText(unit.id); businessText(unit.goal); names(unit.files); names(unit.requirementIds);
  });
  array(run.unitSummaries).forEach((entry) => {
    const summary = businessRecord(entry); businessText(summary.id); businessText(summary.text); array(summary.evidenceIds).forEach(businessText);
  });
  const candidateFields = (entry: unknown) => {
    const candidate = businessRecord(entry);
    businessText(candidate.id);
    for (const key of ['title', 'cause', 'trigger', 'impact']) storedText(candidate[key]);
    names(candidate.requirementIds); refs(candidate.evidence);
    return candidate;
  };
  businessList(run.candidates).forEach((entry) => {
    const item = candidateFields(entry);
    if (!['implementation', 'requirement', 'question'].includes(String(item.kind))) throw new Error(m().businessReview.invalidOutput);
  });
  businessList(run.findings).forEach((entry) => {
    const item = candidateFields(entry);
    if (!['implementation', 'requirement', 'question', 'reasonable'].includes(String(item.kind))
      || !['confirmed', 'dismissed', 'unresolved'].includes(String(item.status))
      || !['high', 'medium', 'low'].includes(String(item.severity))
      || !['introduced', 'existing', 'exposed', 'unknown'].includes(String(item.attribution))) throw new Error(m().businessReview.invalidOutput);
    names(item.candidateIds); refs(item.counterEvidence); businessText(item.counterRationale); businessCritical(item.critical);
  });
  businessList(run.requirements).forEach((entry) => {
    const item = businessRecord(entry);
    businessText(item.id); storedText(item.rationale); refs(item.evidence); businessCritical(item.critical);
    if (!['supported', 'violated', 'unknown', 'not-applicable'].includes(String(item.status))) throw new Error(m().businessReview.invalidOutput);
  });
  businessList(run.premises).forEach((entry) => {
    const item = businessRecord(entry);
    businessText(item.id); businessText(item.rationale); refs(item.evidence); businessCritical(item.critical);
    if (!['clarified', 'unknown'].includes(String(item.status))) throw new Error(m().businessReview.invalidOutput);
  });
  array(run.priorCritical).forEach((entry) => {
    const item = businessRecord(entry); businessText(item.id); storedText(item.title); storedText(item.detail);
    array(item.normativeOrigins ?? []).forEach(storedOrigin);
  });
  array(run.priorCriticalVerdicts).forEach((entry) => {
    const item = businessRecord(entry); businessText(item.id); businessText(item.rationale); refs(item.evidence);
    if (!['cleared', 'remains', 'unknown'].includes(String(item.status))) throw new Error(m().businessReview.invalidOutput);
  });
  array(run.requests).forEach((entry) => {
    const item = businessRecord(entry); const request = businessRecord(item.request);
    for (const key of ['file', 'symbol', 'question']) businessText(request[key]);
    if (!['definition', 'references', 'tests', 'configuration', 'contract'].includes(String(request.kind))) throw new Error(m().businessReview.invalidOutput);
    array(item.paths).forEach(businessText);
    if (item.error !== undefined) businessText(item.error);
  });
  Object.values(businessRecord(run.dependencies)).forEach(businessText);
  array(run.limitations).forEach(businessText); array(run.errors).forEach(businessText);
  businessList(run.cache, BUSINESS_REVIEW_LIMITS.modelCalls).forEach((entry) => {
    const item = businessRecord(entry);
    businessText(item.key);
    if (!['plan', 'discover', 'global', 'verify', 'assess'].includes(String(item.phase)) || !Object.hasOwn(item, 'value')) throw new Error(m().businessReview.invalidOutput);
  });
  Object.values(businessRecord(run.dispositions)).forEach((entry) => {
    const item = businessRecord(entry); storedText(item.reason);
    if (!['commented', 'not-applicable'].includes(String(item.kind)) || typeof item.at !== 'number' || !Number.isFinite(item.at)) throw new Error(m().businessReview.invalidOutput);
  });
}

export function restoreBusinessReview(value: unknown): BusinessReviewRun {
  assertStoredRun(value);
  return structuredClone(value);
}
