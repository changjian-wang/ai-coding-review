import { randomUUID } from 'node:crypto';
import { businessBindingKey, businessHash, type BusinessReviewRun } from './businessReview';
import type { RequirementsDraft } from './requirements';
import type { PendingComment, ReviewSnapshot } from './reviewStore';
import type { ReviewSet } from '../scope/types';
import { m } from '../i18n';

export const CONCLUSION_BODY_LIMIT = 60_000;
export type ConclusionVerdict = 'approve' | 'request-changes' | 'comment';
export interface ConclusionDraft {
  version: 1;
  id: string;
  bindingKey: string;
  revision: number;
  verdict: ConclusionVerdict;
  body: string;
  comments: PendingComment[];
  previewKey?: string;
  updatedAt: number;
}

export class ConclusionDraftDataError extends Error {
  constructor(message = m().reviewCenter.invalidDraft) { super(message); }
}

function publicRun(run: BusinessReviewRun): object {
  return {
    id: run.id, bindingKey: run.bindingKey, status: run.status,
    coverage: run.coverage, globalCompleted: run.globalCompleted, findings: run.findings,
    requirements: run.requirements, premises: run.premises, priorCritical: run.priorCritical,
    priorCriticalVerdicts: run.priorCriticalVerdicts, dependencies: run.dependencies,
    limitations: run.limitations, errors: run.errors, dispositions: run.dispositions,
  };
}

export function conclusionBindingKey(
  cwd: string, set: ReviewSet, requirements: RequirementsDraft | undefined, snapshot: ReviewSnapshot,
): string {
  const report = snapshot.businessReview ? publicRun(snapshot.businessReview) : {
    files: Object.entries(snapshot.perFile).map(([path, file]) => ({
      path, analyzed: file.analyzed, findings: file.findings, dispositions: file.dispositions,
      seen: file.seenLines, total: file.totalLines,
    })),
    global: snapshot.globalReport, globalDone: snapshot.globalDone, dispositions: snapshot.globalFixDispositions,
  };
  return businessHash(JSON.stringify([businessBindingKey(cwd, set, requirements), report, snapshot.pendingComments ?? []]));
}

export function createConclusionDraft(bindingKey: string, body: string, comments: readonly PendingComment[]): ConclusionDraft {
  validateConclusionBody(body);
  return {
    version: 1, id: randomUUID(), bindingKey, revision: 1, verdict: 'comment',
    body, comments: structuredClone([...comments]), updatedAt: Date.now(),
  };
}

export function validateConclusionBody(body: unknown): asserts body is string {
  if (typeof body !== 'string' || !body.trim()) throw new ConclusionDraftDataError(m().reviewCenter.emptyDraft);
  if (body.length > CONCLUSION_BODY_LIMIT) throw new ConclusionDraftDataError(m().reviewCenter.draftTooLong);
}

export function restoreConclusionDraft(value: unknown): ConclusionDraft | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConclusionDraftDataError();
  const draft = value as Record<string, unknown>;
  if (draft.version !== 1 || typeof draft.id !== 'string' || !draft.id || typeof draft.bindingKey !== 'string' || !draft.bindingKey
    || !Number.isInteger(draft.revision) || Number(draft.revision) < 1 || !['approve', 'request-changes', 'comment'].includes(String(draft.verdict))
    || typeof draft.updatedAt !== 'number' || !Number.isFinite(draft.updatedAt)
    || draft.previewKey !== undefined && typeof draft.previewKey !== 'string' || !Array.isArray(draft.comments)) throw new ConclusionDraftDataError();
  validateConclusionBody(draft.body);
  for (const value of draft.comments) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConclusionDraftDataError();
    const comment = value as Record<string, unknown>;
    if (typeof comment.id !== 'string' || !comment.id || typeof comment.path !== 'string' || !comment.path
      || typeof comment.body !== 'string' || !comment.body.trim() || !Number.isInteger(comment.startLine) || !Number.isInteger(comment.endLine)
      || Number(comment.startLine) < 1 || Number(comment.endLine) < Number(comment.startLine)
      || !['manual', 'finding'].includes(String(comment.source)) || typeof comment.createdAt !== 'number' || !Number.isFinite(comment.createdAt)) throw new ConclusionDraftDataError();
  }
  return structuredClone(value) as ConclusionDraft;
}

export function conclusionPreviewKey(draft: ConclusionDraft): string {
  return businessHash(JSON.stringify([draft.id, draft.bindingKey, draft.revision, draft.verdict, draft.body, draft.comments]));
}

export function updateConclusionDraft(
  draft: ConclusionDraft, bindingKey: string, expectedRevision: number, body: string, verdict: ConclusionVerdict,
): ConclusionDraft {
  if (draft.bindingKey !== bindingKey || draft.revision !== expectedRevision) throw new ConclusionDraftDataError(m().reviewCenter.publicationChanged);
  if (!['approve', 'request-changes', 'comment'].includes(verdict)) throw new ConclusionDraftDataError();
  validateConclusionBody(body);
  if (draft.body === body && draft.verdict === verdict) return { ...structuredClone(draft), previewKey: undefined, updatedAt: Date.now() };
  return { ...structuredClone(draft), body, verdict, previewKey: undefined, revision: draft.revision + 1, updatedAt: Date.now() };
}
