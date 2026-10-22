import { createHash, randomUUID } from 'node:crypto';
import { fmt, m } from '../i18n';
import type { ReviewSet } from '../scope/types';
import { repositoryStorageId } from './repositoryIdentity';

export const REQUIREMENT_LIMITS = { sources: 12, bytes: 512_000, characters: 120_000, items: 80 } as const;

export interface RequirementSourceVersion {
  version: number;
  text: string;
  hash: string;
  readAt: number;
}

export interface RequirementMaterial {
  id: string;
  kind: 'paste' | 'file' | 'url' | 'github';
  name: string;
  location: string;
  format: 'markdown' | 'text' | 'html';
  selected: boolean;
  versions: RequirementSourceVersion[];
}

export interface RequirementOrigin {
  sourceId: string;
  version: number;
  line: number;
  endLine: number;
  quote: string;
}

export interface RequirementItem {
  id: string;
  title: string;
  text: string;
  extractedText: string;
  basis: 'explicit' | 'human';
  origins: RequirementOrigin[];
  included: boolean;
  exclusionReason: string;
}

export interface RequirementCheck {
  id: string;
  text: string;
  requirementIds: string[];
}

export interface RequirementQuestion {
  id: string;
  text: string;
  origins: RequirementOrigin[];
}

export interface RequirementUnderstanding {
  summary: string;
  requirements: RequirementItem[];
  checks: RequirementCheck[];
  questions: RequirementQuestion[];
  sourceKey: string;
  scopeKey: string;
  modelId: string;
  createdAt: number;
}

export interface RequirementsDraft {
  version: 1;
  revision: number;
  materials: RequirementMaterial[];
  understanding?: RequirementUnderstanding;
  understandingHistory: RequirementUnderstanding[];
  confirmation?: { version: number; fingerprint: string; scopeKey: string; at: number };
  confirmationVersion: number;
  technicalOnly?: boolean;
  history: { at: number; action: string }[];
  usage: { input: number; output: number; calls: number };
}

export interface RequirementPreparationRecord {
  draft: RequirementsDraft;
  selection?: { cwd: string; kind: 'pr' | 'branchChanges' | 'branchFull' | 'files'; prNumber?: number; headRef?: string; baseRef?: string };
}

export function createRequirementsDraft(): RequirementsDraft {
  return { version: 1, revision: 0, materials: [], understandingHistory: [], confirmationVersion: 0, history: [], usage: { input: 0, output: 0, calls: 0 } };
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function requirementScopeKey(cwd: string, set: ReviewSet): string {
  return hash(JSON.stringify([
    repositoryStorageId(cwd, set.repositoryIdentity), set.scopeId, set.headSha,
    set.comparison?.baseSha, set.source?.baseTipSha, set.files.filter((file) => !file.context).map((file) => [file.path, file.previousPath, file.status]),
  ]));
}

export function currentMaterial(source: RequirementMaterial): RequirementSourceVersion {
  const current = source.versions.at(-1);
  if (!current) throw new Error(m().requirements.invalidState);
  return current;
}

export function selectedMaterials(draft: RequirementsDraft): RequirementMaterial[] {
  return draft.materials.filter((source) => source.selected);
}

export function requirementSourceKey(draft: RequirementsDraft): string {
  return hash(JSON.stringify(selectedMaterials(draft).map((source) => [
    source.id, currentMaterial(source).version, currentMaterial(source).hash,
  ])));
}

function invalidate(draft: RequirementsDraft, action: string): void {
  draft.revision++;
  draft.confirmation = undefined;
  draft.technicalOnly = false;
  draft.history.push({ at: Date.now(), action });
}

export function validateMaterialText(text: string): void {
  if (typeof text !== 'string' || !text.trim() || text.includes('\0')) throw new Error(m().requirements.invalidText);
  if (Buffer.byteLength(text, 'utf8') > REQUIREMENT_LIMITS.bytes) throw new Error(m().requirements.sourceTooLarge);
}

export function addRequirementMaterial(
  draft: RequirementsDraft,
  input: Pick<RequirementMaterial, 'kind' | 'name' | 'location' | 'format'> & { text: string },
): string {
  validateMaterialText(input.text);
  if (!input.name.trim() || !input.location.trim()) throw new Error(m().requirements.invalidText);
  if (draft.materials.length >= REQUIREMENT_LIMITS.sources) throw new Error(m().requirements.tooManySources);
  const source: RequirementMaterial = {
    id: randomUUID(), kind: input.kind, name: input.name.trim(), location: input.location,
    format: input.format, selected: true,
    versions: [{ version: 1, text: input.text, hash: hash(input.text), readAt: Date.now() }],
  };
  draft.materials.push(source);
  invalidate(draft, m().requirements.materialChanged);
  return source.id;
}

export function updateRequirementMaterial(draft: RequirementsDraft, id: string, text: string): void {
  validateMaterialText(text);
  const source = draft.materials.find((item) => item.id === id);
  if (!source) throw new Error(m().requirements.invalidState);
  const previous = currentMaterial(source);
  if (previous.text === text) return;
  source.versions.push({ version: previous.version + 1, text, hash: hash(text), readAt: Date.now() });
  invalidate(draft, m().requirements.materialChanged);
}

export function selectRequirementMaterial(draft: RequirementsDraft, id: string, selected: boolean): void {
  const source = draft.materials.find((item) => item.id === id);
  if (!source || typeof selected !== 'boolean') throw new Error(m().requirements.invalidState);
  if (source.selected === selected) return;
  source.selected = selected;
  invalidate(draft, m().requirements.materialChanged);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(m().requirements.invalidOutput);
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000) throw new Error(m().requirements.invalidOutput);
  return value;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > REQUIREMENT_LIMITS.items) throw new Error(m().requirements.invalidOutput);
  return value;
}

function origins(value: unknown, draft: RequirementsDraft, historical = false): RequirementOrigin[] {
  const result = list(value).map((entry) => {
    const item = record(entry);
    if (typeof item.sourceId !== 'string' || !Number.isInteger(item.version) || !Number.isInteger(item.line)
      || !Number.isInteger(item.endLine) || typeof item.quote !== 'string' || !item.quote.trim()) {
      throw new Error(m().requirements.invalidOrigin);
    }
    const source = draft.materials.find((material) => material.id === item.sourceId && (historical || material.selected));
    if (!source) throw new Error(m().requirements.invalidOrigin);
    const current = historical ? source.versions.find((version) => version.version === item.version) : currentMaterial(source);
    if (!current) throw new Error(m().requirements.invalidOrigin);
    const line = Number(item.line);
    const endLine = Number(item.endLine);
    const lines = current.text.split(/\r?\n/);
    if (item.version !== current.version || line < 1 || endLine < line || endLine > lines.length
      || lines.slice(line - 1, endLine).join('\n') !== item.quote) throw new Error(m().requirements.invalidOrigin);
    return { sourceId: item.sourceId, version: Number(item.version), line, endLine, quote: item.quote };
  });
  if (!result.length) throw new Error(m().requirements.invalidOrigin);
  return result;
}

export function parseRequirementUnderstanding(
  value: unknown, draft: RequirementsDraft, scopeKey: string, modelId: string, historical = false,
): RequirementUnderstanding {
  const root = record(value);
  const ids = new Set<string>();
  const uniqueId = (value: unknown): string => {
    const id = text(value);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || ids.has(id)) throw new Error(m().requirements.invalidOutput);
    ids.add(id);
    return id;
  };
  const requirements = list(root.requirements).map((entry): RequirementItem => {
    const item = record(entry);
    return {
      id: uniqueId(item.id), title: text(item.title), text: text(item.text), extractedText: text(item.text), basis: 'explicit',
      origins: origins(item.origins, draft, historical), included: true, exclusionReason: '',
    };
  });
  const checks = list(root.checks).map((entry): RequirementCheck => {
    const item = record(entry);
    const requirementIds = list(item.requirementIds).map(text);
    if (!requirementIds.length || requirementIds.some((id) => !requirements.some((requirement) => requirement.id === id))) {
      throw new Error(m().requirements.invalidOutput);
    }
    return { id: uniqueId(item.id), text: text(item.text), requirementIds };
  });
  const questions = list(root.questions).map((entry): RequirementQuestion => {
    const item = record(entry);
    return { id: uniqueId(item.id), text: text(item.text), origins: origins(item.origins, draft, historical) };
  });
  if (!scopeKey || !modelId) throw new Error(m().requirements.invalidState);
  return {
    summary: text(root.summary), requirements, checks, questions,
    sourceKey: requirementSourceKey(draft), scopeKey, modelId, createdAt: Date.now(),
  };
}

export function acceptRequirementUnderstanding(draft: RequirementsDraft, understanding: RequirementUnderstanding): void {
  if (understanding.sourceKey !== requirementSourceKey(draft)) throw new Error(m().requirements.stale);
  if (draft.understanding) {
    const sameScope = draft.understanding.scopeKey === understanding.scopeKey;
    draft.understandingHistory.push(structuredClone(draft.understanding));
    const identity = (item: RequirementItem) => JSON.stringify([
      item.extractedText,
      item.origins.map((origin) => [origin.sourceId, origin.version, origin.line, origin.endLine, origin.quote]).sort(),
    ]);
    for (const item of understanding.requirements) {
      const matches = draft.understanding.requirements.filter((old) => old.basis === 'human' && identity(old) === identity(item));
      if (matches.length === 1 && understanding.requirements.filter((entry) => identity(entry) === identity(item)).length === 1) {
        const old = matches[0];
        Object.assign(item, {
          title: old.title, text: old.text, basis: old.basis,
          included: sameScope ? old.included : true, exclusionReason: sameScope ? old.exclusionReason : '',
        });
      }
    }
    if (!sameScope && draft.understanding.requirements.some((item) => !item.included)) {
      draft.history.push({ at: Date.now(), action: m().requirements.scopeExclusionsChanged });
    }
    understanding.checks = understanding.checks.filter((check) => check.requirementIds.every((id) => {
      const item = understanding.requirements.find((entry) => entry.id === id);
      return item?.text === item?.extractedText;
    }));
  }
  draft.understanding = understanding;
  invalidate(draft, m().requirements.understandingChanged);
}

export function reviseRequirement(draft: RequirementsDraft, id: string, title: string, body: string, included: boolean, reason: string): void {
  const item = draft.understanding?.requirements.find((requirement) => requirement.id === id);
  if (!item || draft.understanding?.sourceKey !== requirementSourceKey(draft) || typeof included !== 'boolean') {
    throw new Error(m().requirements.stale);
  }
  if (!included && !reason.trim()) throw new Error(m().requirements.exclusionRequired);
  const validTitle = text(title);
  const validBody = text(body);
  draft.understandingHistory.push(structuredClone(draft.understanding!));
  item.title = validTitle;
  item.text = validBody;
  item.basis = 'human';
  item.included = included;
  item.exclusionReason = included ? '' : reason;
  if (item.text !== item.extractedText && draft.understanding) {
    draft.understanding.checks = draft.understanding.checks.filter((check) => !check.requirementIds.includes(id));
  }
  invalidate(draft, m().requirements.understandingChanged);
}

export function requirementFingerprint(draft: RequirementsDraft, scopeKey: string): string {
  return hash(JSON.stringify([scopeKey, requirementSourceKey(draft), draft.understanding]));
}

export function requirementReadiness(draft: RequirementsDraft, scopeKey: string): { canConfirm: boolean; confirmed: boolean; count: number } {
  const understanding = draft.understanding;
  const count = understanding?.requirements.filter((item) => item.included).length ?? 0;
  if (!selectedMaterials(draft).length) return { canConfirm: true, confirmed: false, count: 0 };
  const canConfirm = !!understanding && understanding.sourceKey === requirementSourceKey(draft)
    && understanding.scopeKey === scopeKey
    && understanding.requirements.every((item) => item.included || !!item.exclusionReason.trim());
  return {
    canConfirm, count,
    confirmed: canConfirm && draft.confirmation?.scopeKey === scopeKey
      && draft.confirmation.fingerprint === requirementFingerprint(draft, scopeKey),
  };
}

export function confirmRequirements(draft: RequirementsDraft, scopeKey: string, explicitlyConfirmed: boolean): void {
  const ready = requirementReadiness(draft, scopeKey);
  if (!ready.canConfirm) throw new Error(m().requirements.stale);
  if (selectedMaterials(draft).length && !explicitlyConfirmed) throw new Error(m().requirements.confirmRequired);
  if (!selectedMaterials(draft).length) { draft.confirmation = undefined; return; }
  if (ready.confirmed) return;
  draft.confirmationVersion++;
  draft.technicalOnly = false;
  draft.confirmation = { version: draft.confirmationVersion, fingerprint: requirementFingerprint(draft, scopeKey), scopeKey, at: Date.now() };
  draft.history.push({ at: Date.now(), action: m().requirements.confirmationRecorded });
}

export function clearRequirementConfirmation(draft: RequirementsDraft): void {
  draft.confirmation = undefined;
  draft.technicalOnly = false;
}

export function restoreRequirementsDraft(value: unknown): RequirementsDraft {
  const root = record(value);
  if (root.version !== 1 || !Number.isInteger(root.revision) || Number(root.revision) < 0
    || !Number.isInteger(root.confirmationVersion) || Number(root.confirmationVersion) < 0
    || root.technicalOnly !== undefined && typeof root.technicalOnly !== 'boolean') throw new Error(m().requirements.invalidState);
  const usage = record(root.usage);
  if (!Array.isArray(root.materials) || root.materials.length > REQUIREMENT_LIMITS.sources
    || !Array.isArray(root.understandingHistory)
    || !Array.isArray(root.history) || ['input', 'output', 'calls'].some((key) => {
      const amount = usage[key];
      return typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0;
    })) throw new Error(m().requirements.invalidState);
  const draft: RequirementsDraft = {
    version: 1, revision: Number(root.revision), confirmationVersion: Number(root.confirmationVersion),
    technicalOnly: root.technicalOnly === true, materials: [], history: [], understandingHistory: [],
    usage: { input: Number(usage.input), output: Number(usage.output), calls: Number(usage.calls) },
  };
  const ids = new Set<string>();
  for (const entry of root.materials) {
    const source = record(entry);
    const kind = source.kind;
    const format = source.format;
    if (typeof source.id !== 'string' || !source.id || ids.has(source.id) || typeof source.name !== 'string'
      || typeof source.location !== 'string' || typeof source.selected !== 'boolean'
      || kind !== 'paste' && kind !== 'file' && kind !== 'url' && kind !== 'github'
      || format !== 'markdown' && format !== 'text' && format !== 'html'
      || !Array.isArray(source.versions) || !source.versions.length) throw new Error(m().requirements.invalidState);
    const versions = source.versions.map((entry, index): RequirementSourceVersion => {
      const version = record(entry);
      if (typeof version.text !== 'string') throw new Error(m().requirements.invalidState);
      validateMaterialText(version.text);
      if (version.version !== index + 1 || version.hash !== hash(version.text) || typeof version.readAt !== 'number' || !Number.isFinite(version.readAt)) {
        throw new Error(m().requirements.invalidState);
      }
      return { text: version.text, hash: String(version.hash), version: index + 1, readAt: version.readAt };
    });
    ids.add(source.id);
    draft.materials.push({
      id: source.id, kind, format, name: source.name, location: source.location, selected: source.selected, versions,
    });
  }
  draft.history = root.history.map((entry) => {
    const item = record(entry);
    if (typeof item.at !== 'number' || !Number.isFinite(item.at) || typeof item.action !== 'string') throw new Error(m().requirements.invalidState);
    return { at: item.at, action: item.action };
  });
  const restoreUnderstanding = (value: unknown): RequirementUnderstanding => {
    const understanding = record(value);
    if (typeof understanding.scopeKey !== 'string' || !understanding.scopeKey || typeof understanding.sourceKey !== 'string'
      || typeof understanding.modelId !== 'string' || typeof understanding.createdAt !== 'number' || !Number.isFinite(understanding.createdAt)) {
      throw new Error(m().requirements.invalidState);
    }
    const validated = parseRequirementUnderstanding(understanding, draft, understanding.scopeKey, understanding.modelId, true);
    validated.requirements.forEach((item, index) => {
      const old = record(list(understanding.requirements)[index]);
      if (old.basis !== 'explicit' && old.basis !== 'human' || typeof old.included !== 'boolean' || typeof old.exclusionReason !== 'string'
        || typeof old.extractedText !== 'string' || !old.extractedText.trim()) {
        throw new Error(m().requirements.invalidState);
      }
      Object.assign(item, { extractedText: old.extractedText, basis: old.basis, included: old.included, exclusionReason: old.exclusionReason });
    });
    return { ...validated, sourceKey: understanding.sourceKey, createdAt: understanding.createdAt };
  };
  if (root.understanding !== undefined) draft.understanding = restoreUnderstanding(root.understanding);
  draft.understandingHistory = root.understandingHistory.map(restoreUnderstanding);
  if (root.confirmation !== undefined) {
    if (draft.technicalOnly) throw new Error(m().requirements.invalidState);
    const confirmation = record(root.confirmation);
    if (!Number.isInteger(confirmation.version) || confirmation.version !== draft.confirmationVersion
      || typeof confirmation.scopeKey !== 'string' || !confirmation.scopeKey || typeof confirmation.fingerprint !== 'string'
      || typeof confirmation.at !== 'number' || !Number.isFinite(confirmation.at)) throw new Error(m().requirements.invalidState);
    draft.confirmation = { version: Number(confirmation.version), scopeKey: confirmation.scopeKey, fingerprint: confirmation.fingerprint, at: confirmation.at };
  }
  return draft;
}

/** Until M3 consumes these requirements, no existing analysis proves their satisfaction. */
export function requirementBoundary(draft: RequirementsDraft | undefined, scopeKey?: string): string {
  if (!draft || !scopeKey || !requirementReadiness(draft, scopeKey).confirmed) return m().requirements.unreviewed;
  const count = draft.understanding?.requirements.filter((item) => item.included).length ?? 0;
  return fmt(m().requirements.confirmedUnreviewed, draft.confirmation?.version ?? 0, count);
}
