import { randomUUID } from 'node:crypto';
import { m } from '../i18n';
import type { ReviewSet } from '../scope/types';
import type { ReviewSession } from './reviewSession';
import type { PendingComment, PublicationAttempt, ReviewConclusion } from './reviewStore';
import { businessHash } from './businessReview';
import { ConclusionDraftDataError, type ConclusionVerdict } from './conclusionDraft';

export interface ConclusionPublication {
  set: ReviewSet;
  cwd: string;
  verdict: ConclusionVerdict;
  body: string;
  comments: PendingComment[];
}

export interface ConclusionPublicationServices {
  busy(): boolean;
  fresh(): Promise<boolean>;
  confirm(request: ConclusionPublication): Promise<boolean>;
  post(request: ConclusionPublication): Promise<void>;
}

export async function publishConclusionDraft(
  session: ReviewSession, input: { id: string; revision: number; previewKey: string }, services: ConclusionPublicationServices,
): Promise<'posted' | 'local' | 'cancelled'> {
  const release = session.beginConclusionPublication();
  try { return await performConclusionPublication(session, input, services); }
  finally { release(); }
}

async function performConclusionPublication(
  session: ReviewSession, input: { id: string; revision: number; previewKey: string }, services: ConclusionPublicationServices,
): Promise<'posted' | 'local' | 'cancelled'> {
  const set = session.reviewSet;
  const snapshot = session.snapshot;
  const cwd = session.getCwd();
  const original = session.conclusionDraft;
  if (!set || !snapshot || !cwd || !original) throw new ConclusionDraftDataError(m().reviewCenter.draftRequired);
  const clearPreview = () => { if (session.snapshot === snapshot) session.clearConclusionPreview(); };
  const valid = () => {
    const draft = session.conclusionDraft;
    if (session.reviewSet !== set || session.snapshot !== snapshot || !draft || draft.id !== input.id
      || draft.revision !== input.revision || draft.previewKey !== input.previewKey || !session.conclusionPreviewCurrent
      || services.busy() || !session.canSubmitConclusion(draft.verdict)) throw new ConclusionDraftDataError(m().reviewCenter.publicationChanged);
    if (snapshot.publicationAttempts?.some((attempt) => attempt.status === 'unknown' && !attempt.checked)) throw new ConclusionDraftDataError(m().reviewCenter.unknownPublication);
    if (snapshot.postedConclusions?.some((receipt) => receipt.draftId === draft.id && receipt.draftRevision === draft.revision)
      || session.conclusion?.draftId === draft.id && session.conclusion.draftRevision === draft.revision) {
      throw new ConclusionDraftDataError(m().reviewCenter.alreadyPublished);
    }
    return draft;
  };
  valid();
  const request: ConclusionPublication = {
    set, cwd, verdict: original.verdict, body: original.body, comments: structuredClone(original.comments),
  };
  if (!await services.confirm(request)) return 'cancelled';
  if (!await services.fresh()) throw new ConclusionDraftDataError(m().reviewCenter.publicationChanged);
  valid();
  const receipt: ReviewConclusion = {
    businessRunId: session.businessReview?.id, draftId: original.id, draftRevision: original.revision,
    bodyHash: businessHash(original.body), verdict: original.verdict,
    label: original.verdict === 'approve' ? m().conclusion.approve : original.verdict === 'request-changes' ? m().conclusion.requestChanges : m().conclusion.comment,
    target: /^pr-\d+$/.test(set.scopeId) ? 'pr' : 'local', submittedAt: Date.now(),
    prNumber: /^pr-(\d+)$/.test(set.scopeId) ? Number(set.scopeId.slice(3)) : undefined,
  };
  if (receipt.target === 'local') {
    session.setConclusion(receipt);
    await session.persist();
    clearPreview();
    return 'local';
  }
  const attempt: PublicationAttempt = {
    id: randomUUID(), draftId: original.id, draftRevision: original.revision,
    bodyHash: receipt.bodyHash!, headSha: set.headSha, status: 'sending', at: Date.now(),
  };
  await session.recordPublicationAttempt(snapshot, attempt);
  try { valid(); }
  catch (error) {
    await session.recordPublicationAttempt(snapshot, { ...attempt, status: 'not-submitted', error: String(error) });
    throw error;
  }
  try { await services.post(request); }
  catch (error) {
    clearPreview();
    await session.recordPublicationAttempt(snapshot, { ...attempt, status: 'unknown', error: String(error) });
    throw new ConclusionDraftDataError(`${m().reviewCenter.publishFailed} ${String(error)}`);
  }
  try {
    await session.recordPostedConclusion(snapshot, receipt, original.comments.map((comment) => comment.id));
    await session.recordPublicationAttempt(snapshot, { ...attempt, status: 'posted' });
  } catch (error) {
    clearPreview();
    throw new ConclusionDraftDataError(`${m().reviewCenter.receiptSaveFailed} ${String(error)}`);
  }
  clearPreview();
  return 'posted';
}
