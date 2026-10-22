import { describe, expect, it, vi } from 'vitest';
import { ReviewSession } from './reviewSession';
import { publishConclusionDraft, type ConclusionPublicationServices } from './conclusionPublisher';
import { reviewCenterFixture } from '../test/reviewCenterFixture';
import { businessHash } from './businessReview';

async function preview(session: ReviewSession, verdict: 'approve' | 'comment' | 'request-changes' = 'request-changes', body = '# Exact saved review\n\nA bounded conclusion.') {
  const initial = session.conclusionDraft ?? await session.generateConclusionDraft(body);
  const draft = await session.saveConclusionDraft(initial.id, initial.revision, body, verdict);
  await session.prepareConclusionPreview(draft.id, draft.revision);
  const saved = session.conclusionDraft!;
  session.acknowledgeConclusionPreview(saved.id, saved.revision, saved.previewKey!);
  return { id: saved.id, revision: saved.revision, previewKey: saved.previewKey! };
}

function services(): ConclusionPublicationServices {
  return { busy: () => false, fresh: vi.fn(async () => true), confirm: vi.fn(async () => true), post: vi.fn(async () => {}) };
}

describe('version-bound conclusion publication', () => {
  it('sends exactly the saved body and frozen inline comments, preserving newly added drafts', async () => {
    const { session } = await reviewCenterFixture();
    session.addPendingComment({ id: 'old', path: 'src/restore.ts', startLine: 2, endLine: 2, body: '**Original inline comment**', source: 'manual', createdAt: 1 });
    const body = '# Exact body\n\n| Check | Outcome |\n| --- | --- |\n| Reservation | Missing |';
    const input = await preview(session, 'request-changes', body);
    const deps = services();
    deps.post = vi.fn<ConclusionPublicationServices['post']>(async (request) => {
      expect(request.body).toBe(body);
      expect(request.set.headSha).toBe('a'.repeat(40));
      expect(request.comments.map((comment) => comment.id)).toEqual(['old']);
      session.addPendingComment({ id: 'new', path: 'src/api.ts', startLine: 1, endLine: 1, body: 'Not included in the preview', source: 'manual', createdAt: 2 });
    });
    await expect(publishConclusionDraft(session, input, deps)).resolves.toBe('posted');
    expect(deps.post).toHaveBeenCalledTimes(1);
    expect(session.pendingComments.map((comment) => comment.id)).toEqual(['new']);
    expect(session.snapshot?.postedConclusions?.[0]).toMatchObject({ draftId: input.id, draftRevision: input.revision, bodyHash: businessHash(body) });
    expect(session.snapshot?.publicationAttempts?.[0].status).toBe('posted');
    session.dispose();
  });

  it('enforces the approval gate on the host even with a valid preview', async () => {
    const { session } = await reviewCenterFixture();
    session.confirmBusinessReview();
    const input = await preview(session, 'approve');
    const deps = services();
    await expect(publishConclusionDraft(session, input, deps)).rejects.toThrow(/baseline changed/);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.post).not.toHaveBeenCalled();
    session.dispose();
  });

  it('requires acknowledgement of the rendered current preview, not merely a saved body', async () => {
    const { session } = await reviewCenterFixture();
    const draft = await session.generateConclusionDraft('Saved but not previewed.');
    const deps = services();
    await expect(publishConclusionDraft(session, { id: draft.id, revision: draft.revision, previewKey: 'invented' }, deps)).rejects.toThrow();
    expect(deps.post).not.toHaveBeenCalled();
    session.dispose();
  });

  it('does not submit if the body changes while the confirmation dialog is open', async () => {
    const { session } = await reviewCenterFixture();
    const input = await preview(session);
    const deps = services();
    deps.confirm = async () => { await session.saveConclusionDraft(input.id, input.revision, 'New unpreviewed text.', 'comment'); return true; };
    await expect(publishConclusionDraft(session, input, deps)).rejects.toThrow();
    expect(deps.post).not.toHaveBeenCalled();
    expect(session.conclusionDraft?.body).toBe('New unpreviewed text.');
    session.dispose();
  });

  it('does not submit if source freshness cannot be established', async () => {
    const { session } = await reviewCenterFixture();
    const input = await preview(session);
    const deps = services();
    deps.fresh = async () => { session.invalidateBusinessReview(); return false; };
    await expect(publishConclusionDraft(session, input, deps)).rejects.toThrow();
    expect(deps.post).not.toHaveBeenCalled();
    session.dispose();
  });

  it('prevents concurrent submission and repeat publication of the same saved revision', async () => {
    const { session } = await reviewCenterFixture();
    const input = await preview(session);
    const deps = services();
    let release!: (confirmed: boolean) => void;
    deps.confirm = () => new Promise((resolve) => { release = resolve; });
    const first = publishConclusionDraft(session, input, deps);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(publishConclusionDraft(session, input, deps)).rejects.toThrow(/Checking/);
    release(true);
    await first;
    const same = await preview(session);
    expect(same.revision).toBe(input.revision);
    await expect(publishConclusionDraft(session, same, services())).rejects.toThrow(/already/);
    expect(deps.post).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it('retains an unknown write outcome and blocks blind retry until explicit remote checking', async () => {
    const { session, store, set, cwd } = await reviewCenterFixture();
    const input = await preview(session);
    const deps = services();
    deps.post = async () => { throw new Error('Connection ended before the receipt'); };
    await expect(publishConclusionDraft(session, input, deps)).rejects.toThrow(/Remote publication may be unknown/);
    expect(session.snapshot?.publicationAttempts?.[0].status).toBe('unknown');
    const reloaded = new ReviewSession(store, 'fixture');
    await reloaded.start(set, cwd);
    expect(reloaded.conclusionPreviewCurrent).toBe(false);
    const again = await preview(reloaded);
    await expect(publishConclusionDraft(reloaded, again, services())).rejects.toThrow(/unknown remote state/);
    await reloaded.acknowledgePublicationUncertainty(reloaded.snapshot!.publicationAttempts![0].id);
    await expect(publishConclusionDraft(reloaded, again, services())).resolves.toBe('posted');
    session.dispose(); reloaded.dispose();
  });

  it('restores an interrupted sending state as unknown, not posted or safe to retry', async () => {
    const { session, store, set, cwd } = await reviewCenterFixture();
    const draft = await session.generateConclusionDraft('Retained draft.');
    await session.recordPublicationAttempt(session.snapshot!, {
      id: 'sending', draftId: draft.id, draftRevision: draft.revision, bodyHash: businessHash(draft.body),
      headSha: set.headSha, status: 'sending', at: 1,
    });
    const reloaded = new ReviewSession(store, 'fixture');
    await reloaded.start(set, cwd);
    expect(reloaded.snapshot?.publicationAttempts?.[0]).toMatchObject({ status: 'unknown' });
    expect(reloaded.snapshot?.postedConclusions).toBeUndefined();
    session.dispose(); reloaded.dispose();
  });

  it('preserves the saved draft on oversize or stale input rather than truncating or accepting it', async () => {
    const { session } = await reviewCenterFixture();
    const draft = await session.generateConclusionDraft('Original body.');
    await expect(session.saveConclusionDraft(draft.id, draft.revision, 'x'.repeat(60_001), 'comment')).rejects.toThrow(/60,000/);
    expect(session.conclusionDraft?.body).toBe('Original body.');
    session.invalidateBusinessReview();
    await expect(session.saveConclusionDraft(draft.id, draft.revision, 'New body.', 'comment')).rejects.toThrow();
    expect(session.conclusionDraft?.body).toBe('Original body.');
    session.dispose();
  });

  it('records a definite non-submission when inputs change while the sending marker is being persisted', async () => {
    const { session } = await reviewCenterFixture();
    const input = await preview(session);
    const record = session.recordPublicationAttempt.bind(session);
    vi.spyOn(session, 'recordPublicationAttempt').mockImplementationOnce(async (snapshot, attempt) => {
      await record(snapshot, attempt);
      session.invalidateBusinessReview();
    });
    const deps = services();
    await expect(publishConclusionDraft(session, input, deps)).rejects.toThrow(/baseline changed/);
    expect(deps.post).not.toHaveBeenCalled();
    expect(session.snapshot?.publicationAttempts?.[0].status).toBe('not-submitted');
    session.dispose();
  });

  it('does not clear another scope preview when an older publication completes', async () => {
    const { session, set, cwd } = await reviewCenterFixture();
    const input = await preview(session);
    const previous = session.snapshot!;
    const deps = services();
    deps.post = async () => {
      await session.start({ ...set, scopeId: 'pr-43' }, cwd);
      await preview(session, 'comment', 'The new scope draft.');
      expect(session.conclusionPreviewCurrent).toBe(true);
    };
    await expect(publishConclusionDraft(session, input, deps)).resolves.toBe('posted');
    expect(session.conclusionPreviewCurrent).toBe(true);
    expect(session.snapshot?.postedConclusions).toBeUndefined();
    expect(previous.postedConclusions?.[0].draftId).toBe(input.id);
    session.dispose();
  });

  it('does not open confirmation or publish while another analysis is active', async () => {
    const { session } = await reviewCenterFixture();
    const input = await preview(session);
    const deps = services();
    deps.busy = () => true;
    await expect(publishConclusionDraft(session, input, deps)).rejects.toThrow(/baseline changed/);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.post).not.toHaveBeenCalled();
    session.dispose();
  });
});
