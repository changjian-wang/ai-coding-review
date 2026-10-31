import { createHash, randomUUID } from 'node:crypto';
import type { Finding, FindingEvidenceRef } from '../ai/types';
import type { ReviewSet } from '../scope/types';

export type ReviewStage = 'prepare' | 'review' | 'conclusion';
export type ReviewRunStatus = 'idle' | 'running' | 'completed' | 'partial' | 'cancelled' | 'stale';
export type ReviewVerdict = 'approve' | 'request-changes' | 'comment';
export type RequirementMaterialKind = 'text' | 'file' | 'link' | 'human';

export type WorkflowErrorCode =
  | 'noReview' | 'emptyMaterial' | 'materialTooLarge' | 'missingSource'
  | 'invalidReference' | 'invalidUnderstanding' | 'invalidBusinessReview' | 'staleResult'
  | 'understandingPending' | 'understandingFailed' | 'confirmationRequired'
  | 'exclusionReasonRequired' | 'noRequirements' | 'running'
  | 'noResults' | 'staleResults' | 'incomplete' | 'unhandled'
  | 'criticalConcern' | 'requirementViolated' | 'confirmationChanged' | 'unsupportedWorkflow'
  | 'priorFindingPending' | 'applicabilityUnconfirmed';

export class WorkflowError extends Error {
  constructor(readonly code: WorkflowErrorCode, readonly detail = '') {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export interface RequirementMaterial {
  id: string;
  kind: RequirementMaterialKind;
  label: string;
  location: string;
  selected: boolean;
  version: number;
  snapshots: { version: number; text: string; createdAt: number }[];
}

export interface RequirementOrigin {
  sourceId: string;
  version: number;
  line: number;
  quote: string;
}

export interface ReviewRequirement {
  id: string;
  title: string;
  text: string;
  basis: 'source' | 'human';
  origins: RequirementOrigin[];
  included: boolean;
  exclusionReason?: string;
}

export interface RequirementCheck {
  id: string;
  requirementIds: string[];
  text: string;
}

export interface RequirementUnderstanding {
  revision: number;
  status: 'pending' | 'ready' | 'failed';
  summary: string;
  requirements: ReviewRequirement[];
  checks: RequirementCheck[];
  questions: RequirementCheck[];
  error?: string;
  modelId?: string;
}

export interface RequirementBaseline {
  version: number;
  revision: number;
  scopeKey: string;
  confirmedAt: number;
  signature: string;
  requirements: ReviewRequirement[];
  checks: RequirementCheck[];
  questions: RequirementCheck[];
}

export interface BusinessChain {
  id: string;
  title: string;
  description: string;
  files: string[];
  findingRefs: string[];
}

export interface RequirementAssessment {
  requirementId: string;
  status: 'satisfied' | 'violated' | 'unknown' | 'conflict' | 'not-applicable';
  critical: boolean;
  rationale: string;
  evidence: FindingEvidenceRef[];
  findingRefs?: string[];
}

export interface ReviewConcern {
  id: string;
  kind: 'requirement' | 'question';
  title: string;
  detail: string;
  impact: string;
  requirementIds: string[];
  critical: boolean;
  status: 'open' | 'resolved';
  evidence: FindingEvidenceRef[];
  findingRef?: string;
}

export interface BusinessReview {
  priorFindings?: {
    id: string;
    status: 'confirmed' | 'dismissed' | 'unresolved';
    findingRef?: string;
    rationale: string;
    evidence: FindingEvidenceRef[];
  }[];
  chains: BusinessChain[];
  requirements: RequirementAssessment[];
  concerns: ReviewConcern[];
  limitations: string[];
}

export interface WorkflowRun {
  priorFindings?: { id: string; path: string; finding: Finding }[];
  unreviewedFindings?: string[];
  id: string;
  status: ReviewRunStatus;
  key: string;
  completed: string[];
  failed: { path: string; error: string }[];
  excluded: { path: string; reason: string }[];
  hashes: Record<string, string>;
  results: Record<string, { hashes: Record<string, string>; limitations: string[]; complete: boolean; modelId?: string }>;
  globalComplete: boolean;
  limitations: string[];
  business?: BusinessReview;
  modelId?: string;
  unreviewedConcerns?: string[];
  startedAt?: number;
  completedAt?: number;
  repositoryStamp?: string;
}

export interface ReviewWorkflowState {
  schema: 1;
  repositoryKey: string;
  scopeKey: string;
  revision: number;
  stage: ReviewStage;
  materials: RequirementMaterial[];
  understanding: RequirementUnderstanding;
  baseline?: RequirementBaseline;
  baselineHistory: RequirementBaseline[];
  baselineVersion: number;
  run: WorkflowRun;
  verdict: ReviewVerdict;
  notes: string;
  interrupted?: boolean;
  priorExclusions?: { scopeKey: string; id: string; reason: string; origins: RequirementOrigin[] }[];
  retiredRequirements?: ReviewRequirement[];
}

export interface WorkflowBlocker {
  code: WorkflowErrorCode;
  detail?: string;
}

const MAX_MATERIAL_CHARACTERS = 64_000;
const MAX_SELECTED_CHARACTERS = 128_000;

export function contentSignature(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function workflowScopeKey(set: ReviewSet, cwd: string): string {
  return contentSignature(JSON.stringify([
    cwd, set.scopeId, set.headSha, set.comparison,
    set.files.filter((file) => !file.context)
      .map((file) => [file.path, file.previousPath, file.status])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]));
}

function emptyRun(): WorkflowRun {
  return { id: '', status: 'idle', key: '', completed: [], failed: [], excluded: [], hashes: {}, results: {}, globalComplete: false, limitations: [] };
}

export function createReviewWorkflow(scopeKey: string, repositoryKey: string): ReviewWorkflowState {
  return {
    schema: 1, repositoryKey, scopeKey, revision: 0, stage: 'prepare',
    materials: [],
    understanding: { revision: 0, status: 'ready', summary: '', requirements: [], checks: [], questions: [] },
    baselineHistory: [], baselineVersion: 0, run: emptyRun(), verdict: 'request-changes', notes: '',
  };
}

export function restoreReviewWorkflow(
  saved: ReviewWorkflowState,
  scopeKey: string,
  repositoryKey: string,
): ReviewWorkflowState {
  if (saved.schema !== 1) throw new WorkflowError('unsupportedWorkflow');
  if (saved.repositoryKey !== repositoryKey) return createReviewWorkflow(scopeKey, repositoryKey);
  const interruptedUnderstanding = saved.scopeKey === scopeKey && saved.understanding.status === 'pending';
  const restored = structuredClone(saved);
  if (restored.scopeKey !== scopeKey) {
    const previousScope = restored.scopeKey;
    for (const requirement of restored.understanding.requirements) {
      if (!requirement.included && requirement.exclusionReason) {
        (restored.priorExclusions ??= []).push({
          scopeKey: previousScope, id: requirement.id, reason: requirement.exclusionReason,
          origins: structuredClone(requirement.origins),
        });
      }
    }
    restored.scopeKey = scopeKey;
    restored.notes = '';
    restored.verdict = 'request-changes';
    materialChanged(restored);
    restored.stage = 'prepare';
    for (const requirement of restored.understanding.requirements) {
      requirement.included = true;
      delete requirement.exclusionReason;
    }
  }
  if (restored.run.status === 'running') {
    restored.run.status = 'cancelled';
    restored.interrupted = true;
  }
  if (interruptedUnderstanding) {
    restored.understanding.status = 'failed';
    restored.understanding.error = 'interrupted';
    restored.interrupted = true;
  }
  return restored;
}

export function materialText(material: RequirementMaterial, version = material.version): string {
  const snapshot = material.snapshots.find((item) => item.version === version);
  if (!snapshot) throw new WorkflowError('missingSource', material.id);
  return snapshot.text;
}

function assertMaterialSize(text: string): void {
  if (!text.trim()) throw new WorkflowError('emptyMaterial');
  if (text.length > MAX_MATERIAL_CHARACTERS) throw new WorkflowError('materialTooLarge');
}

function materialChanged(state: ReviewWorkflowState): void {
  state.revision++;
  state.understanding.status = state.materials.some((item) => item.selected) ? 'pending' : 'ready';
  state.understanding.revision = state.revision;
  state.understanding.error = undefined;
  if (!state.materials.some((item) => item.selected)) {
    state.understanding = { revision: state.revision, status: 'ready', summary: '', requirements: [], checks: [], questions: [] };
  }
  invalidateWorkflow(state);
}

export function putRequirementMaterial(
  state: ReviewWorkflowState,
  input: { kind: RequirementMaterialKind; label: string; location?: string; text: string },
): RequirementMaterial {
  assertMaterialSize(input.text);
  if (state.run.status === 'running') throw new WorkflowError('running');
  const location = input.location || `input:${randomUUID()}`;
  const id = contentSignature(`${input.kind}\0${location}`).slice(0, 20);
  const existing = state.materials.find((item) => item.id === id);
  const selectedSize = state.materials
    .filter((item) => item.selected && item.id !== id)
    .reduce((total, item) => total + materialText(item).length, input.text.length);
  if (selectedSize > MAX_SELECTED_CHARACTERS) throw new WorkflowError('materialTooLarge');
  if (existing) {
    if (materialText(existing) !== input.text) {
      existing.version++;
      existing.snapshots.push({ version: existing.version, text: input.text, createdAt: Date.now() });
    } else if (existing.selected) {
      return existing;
    }
    existing.selected = true;
    existing.label = input.label;
    materialChanged(state);
    return existing;
  }
  const material: RequirementMaterial = {
    id, kind: input.kind, label: input.label, location, selected: true, version: 1,
    snapshots: [{ version: 1, text: input.text, createdAt: Date.now() }],
  };
  state.materials.push(material);
  materialChanged(state);
  return material;
}

export function selectRequirementMaterial(state: ReviewWorkflowState, id: string, selected: boolean): void {
  if (state.run.status === 'running') throw new WorkflowError('running');
  const material = state.materials.find((item) => item.id === id);
  if (!material) throw new WorkflowError('missingSource', id);
  if (material.selected === selected) return;
  if (selected && state.materials.filter((item) => item.selected).reduce((size, item) => size + materialText(item).length, materialText(material).length) > MAX_SELECTED_CHARACTERS) {
    throw new WorkflowError('materialTooLarge');
  }
  material.selected = selected;
  materialChanged(state);
}

export function validateRequirementOrigins(state: ReviewWorkflowState, requirement: ReviewRequirement): void {
  if (!requirement.origins.length) throw new WorkflowError('invalidReference', requirement.id);
  for (const origin of requirement.origins) {
    const material = state.materials.find((item) => item.id === origin.sourceId && item.selected && item.version === origin.version);
    if (!material || !Number.isInteger(origin.line) || origin.line < 1 || !origin.quote.trim() || /[\r\n]/.test(origin.quote)) {
      throw new WorkflowError('invalidReference', requirement.id);
    }
    const line = materialText(material).split(/\r?\n/)[origin.line - 1];
    if (line === undefined || !line.includes(origin.quote)) throw new WorkflowError('invalidReference', requirement.id);
  }
}

export function applyRequirementUnderstanding(
  state: ReviewWorkflowState,
  understanding: RequirementUnderstanding,
  scopeKey: string,
): void {
  if (state.scopeKey !== scopeKey || state.revision !== understanding.revision) throw new WorkflowError('staleResult');
  const ids = new Set<string>();
  for (const requirement of understanding.requirements) {
    if (!requirement.id || ids.has(requirement.id) || !requirement.title.trim() || !requirement.text.trim()) {
      throw new WorkflowError('invalidUnderstanding');
    }
    ids.add(requirement.id);
    validateRequirementOrigins(state, requirement);
  }
  for (const check of [...understanding.checks, ...understanding.questions]) {
    if (!check.text.trim() || check.requirementIds.some((id) => !ids.has(id))) throw new WorkflowError('invalidUnderstanding');
  }
  const next = structuredClone(understanding);
  for (const previous of state.understanding.requirements) {
    const current = next.requirements.find((item) =>
      item.id === previous.id && JSON.stringify(item.origins) === JSON.stringify(previous.origins),
    );
    if (current) {
      if (previous.basis === 'human') Object.assign(current, { title: previous.title, text: previous.text, basis: 'human' as const });
      current.included = previous.included;
      current.exclusionReason = previous.exclusionReason;
    } else if (previous.basis === 'human' || !previous.included) {
      const history = state.retiredRequirements ??= [];
      if (!history.some((item) => JSON.stringify(item) === JSON.stringify(previous))) history.push(structuredClone(previous));
    }
  }
  const previous = understandingSignature(state);
  state.understanding = { ...next, status: 'ready' };
  if (previous !== understandingSignature(state)) invalidateWorkflow(state);
}

export function reviseReviewRequirement(
  state: ReviewWorkflowState,
  id: string,
  title: string,
  text: string,
): void {
  if (state.run.status === 'running') throw new WorkflowError('running');
  if (!title.trim() || !text.trim()) throw new WorkflowError('emptyMaterial');
  const requirement = state.understanding.requirements.find((item) => item.id === id);
  if (!requirement) throw new WorkflowError('invalidUnderstanding', id);
  validateRequirementOrigins(state, requirement);
  requirement.title = title.trim();
  requirement.text = text;
  requirement.basis = 'human';
  state.revision++;
  state.understanding.revision = state.revision;
  state.understanding.checks = state.understanding.checks.filter((item) => !item.requirementIds.includes(id));
  state.understanding.questions = state.understanding.questions.filter((item) => !item.requirementIds.includes(id));
  invalidateWorkflow(state);
}

export function includeReviewRequirement(state: ReviewWorkflowState, id: string, included: boolean, reason = ''): void {
  if (state.run.status === 'running') throw new WorkflowError('running');
  if (!included && !reason.trim()) throw new WorkflowError('exclusionReasonRequired');
  const requirement = state.understanding.requirements.find((item) => item.id === id);
  if (!requirement) throw new WorkflowError('invalidUnderstanding', id);
  requirement.included = included;
  requirement.exclusionReason = included ? undefined : reason.trim();
  state.revision++;
  state.understanding.revision = state.revision;
  invalidateWorkflow(state);
}

export function currentRequirements(state: ReviewWorkflowState): ReviewRequirement[] {
  return state.understanding.requirements.filter((item) => item.included);
}

function understandingSignature(state: ReviewWorkflowState): string {
  return contentSignature(JSON.stringify([
    state.scopeKey, state.revision,
    [...state.understanding.requirements].sort((a, b) => a.id.localeCompare(b.id)),
  ]));
}

export function requirementsConfirmed(state: ReviewWorkflowState): boolean {
  return state.baseline?.revision === state.revision
    && state.baseline.scopeKey === state.scopeKey
    && state.baseline.signature === understandingSignature(state);
}

export function confirmReviewRequirements(state: ReviewWorkflowState): RequirementBaseline | undefined {
  if (state.understanding.status !== 'ready') throw new WorkflowError(state.understanding.status === 'pending' ? 'understandingPending' : 'understandingFailed');
  if (state.understanding.revision !== state.revision) throw new WorkflowError('staleResult');
  for (const item of state.understanding.requirements) {
    validateRequirementOrigins(state, item);
    if (!item.included && !item.exclusionReason?.trim()) throw new WorkflowError('exclusionReasonRequired');
  }
  if (!currentRequirements(state).length) return undefined;
  if (requirementsConfirmed(state)) return state.baseline;
  if (state.baseline) state.baselineHistory.push(structuredClone(state.baseline));
  state.baseline = {
    version: ++state.baselineVersion, revision: state.revision, scopeKey: state.scopeKey, confirmedAt: Date.now(),
    signature: understandingSignature(state),
    requirements: structuredClone(state.understanding.requirements),
    checks: structuredClone(state.understanding.checks), questions: structuredClone(state.understanding.questions),
  };
  return state.baseline;
}

export function workflowResultKey(state: ReviewWorkflowState): string {
  return contentSignature(JSON.stringify([state.scopeKey, understandingSignature(state), state.baseline?.version]));
}

export function beginWorkflowRun(
  state: ReviewWorkflowState, confirmed: boolean, modelId: string, resume = false,
  forcePaths: ReadonlySet<string> = new Set(),
): void {
  if (state.run.status === 'running') throw new WorkflowError('running');
  if (state.understanding.status !== 'ready') throw new WorkflowError(state.understanding.status === 'pending' ? 'understandingPending' : 'understandingFailed');
  if (currentRequirements(state).length && !requirementsConfirmed(state)) {
    if (!confirmed) throw new WorkflowError('confirmationRequired');
    confirmReviewRequirements(state);
  }
  const previous = state.run;
  const key = workflowResultKey(state);
  const concerns = previous.business?.concerns.filter((item) => item.critical && item.status === 'open') ?? [];
  state.run = { ...emptyRun(), id: randomUUID(), status: 'running', key, modelId, startedAt: Date.now() };
  if (resume && previous.key === key && ['completed', 'partial', 'cancelled'].includes(previous.status)) {
    for (const [file, result] of Object.entries(previous.results)) {
      if (!result.complete || forcePaths.has(file)) continue;
      state.run.results[file] = structuredClone(result);
      state.run.completed.push(file);
      Object.assign(state.run.hashes, result.hashes);
      state.run.limitations.push(...result.limitations);
    }
  }
  if (concerns.length) state.run.business = { chains: [], requirements: [], concerns, limitations: [] };
  state.stage = 'review';
  state.interrupted = false;
}

export function recordWorkflowFile(
  state: ReviewWorkflowState,
  runId: string,
  path: string,
  hashes: Record<string, string>,
  limitations: string[] = [],
  complete = true,
): void {
  if (state.run.status !== 'running' || state.run.id !== runId || workflowResultKey(state) !== state.run.key) throw new WorkflowError('staleResult');
  if (!hashes[path]) throw new WorkflowError('incomplete', path);
  if (Object.entries(hashes).some(([file, hash]) => state.run.hashes[file] !== undefined && state.run.hashes[file] !== hash)) {
    throw new WorkflowError('staleResult', path);
  }
  if (!state.run.completed.includes(path)) state.run.completed.push(path);
  Object.assign(state.run.hashes, hashes);
  state.run.results[path] = { hashes: structuredClone(hashes), limitations: [...limitations], complete, modelId: state.run.modelId };
  state.run.limitations = [...new Set([...state.run.limitations, ...limitations])];
}

export function finishWorkflowRun(
  state: ReviewWorkflowState,
  runId: string,
  requiredFiles: readonly string[],
  business: BusinessReview,
): void {
  if (state.run.status !== 'running' || state.run.id !== runId || workflowResultKey(state) !== state.run.key) throw new WorkflowError('staleResult');
  const expected = new Set(currentRequirements(state).map((item) => item.id));
  const assessed = new Set(business.requirements.map((item) => item.requirementId));
  if (assessed.size !== business.requirements.length || assessed.size !== expected.size || [...assessed].some((id) => !expected.has(id))) {
    throw new WorkflowError('invalidBusinessReview');
  }
  if (new Set(business.concerns.map((item) => item.id)).size !== business.concerns.length
    || business.concerns.some((item) => item.critical && item.status === 'resolved' && !item.evidence.length)
    || business.requirements.some((item) => item.status === 'violated' && !item.findingRefs?.length)) {
    throw new WorkflowError('invalidBusinessReview');
  }
  const previous = state.run.business?.concerns.filter((item) => item.critical && item.status === 'open') ?? [];
  state.run.unreviewedConcerns = [];
  for (const concern of previous) {
    const updated = business.concerns.find((item) => item.id === concern.id);
    if (!updated) {
      business.concerns.push(concern);
      state.run.unreviewedConcerns.push(concern.id);
    } else if (updated.status === 'open') {
      updated.critical = true;
    } else if (!updated.evidence.length) {
      throw new WorkflowError('invalidBusinessReview', concern.id);
    }
  }
  state.run.business = structuredClone(business);
  state.run.unreviewedFindings = (state.run.priorFindings ?? [])
    .filter((prior) => !business.priorFindings?.some((item) => item.id === prior.id && item.status !== 'unresolved'))
    .map((item) => item.id);
  state.run.globalComplete = true;
  state.run.limitations = [...new Set([...state.run.limitations, ...business.limitations])];
  state.run.status = requiredFiles.every((path) => state.run.completed.includes(path))
    && !state.run.failed.length && state.run.completed.every((path) => state.run.results[path]?.complete)
    && !state.run.unreviewedConcerns.length && !state.run.unreviewedFindings.length ? 'completed' : 'partial';
  state.run.completedAt = Date.now();
}

export function invalidateWorkflow(state: ReviewWorkflowState): void {
  state.run.status = state.run.key ? 'stale' : 'idle';
}

export function workflowGate(
  state: ReviewWorkflowState,
  unhandled: number,
  handledRefs: ReadonlySet<string> = new Set(),
): { approve: WorkflowBlocker[]; feedback: WorkflowBlocker[] } {
  const approve: WorkflowBlocker[] = [];
  const feedback: WorkflowBlocker[] = [];
  if (state.run.status === 'running') feedback.push({ code: 'running' });
  if (!state.run.completed.length) feedback.push({ code: 'noResults' });
  if (state.run.key !== workflowResultKey(state) || state.run.status === 'stale') feedback.push({ code: 'staleResults' });
  approve.push(...feedback);
  if (state.run.status !== 'completed') approve.push({ code: 'incomplete' });
  if (currentRequirements(state).length && !requirementsConfirmed(state)) {
    approve.push({ code: 'confirmationRequired' });
  }
  if (unhandled) approve.push({ code: 'unhandled', detail: String(unhandled) });
  for (const id of state.run.unreviewedFindings ?? []) {
    approve.push({ code: 'priorFindingPending', detail: state.run.priorFindings?.find((item) => item.id === id)?.finding.title ?? id });
  }
  for (const concern of state.run.business?.concerns ?? []) {
    if (concern.critical && concern.status === 'open') approve.push({ code: 'criticalConcern', detail: concern.title });
  }
  for (const assessment of state.run.business?.requirements ?? []) {
    if (assessment.status === 'not-applicable') approve.push({ code: 'applicabilityUnconfirmed', detail: assessment.requirementId });
    if (assessment.status === 'violated' && !unhandled
      && !assessment.findingRefs?.every((ref) => handledRefs.has(ref))) {
      approve.push({ code: 'requirementViolated', detail: assessment.requirementId });
    }
    if (assessment.critical && ['unknown', 'conflict'].includes(assessment.status)
      && !state.run.business?.concerns.some((item) => item.critical && item.status === 'open' && item.requirementIds.includes(assessment.requirementId))) {
      approve.push({ code: 'criticalConcern', detail: assessment.rationale });
    }
  }
  return { approve, feedback };
}
