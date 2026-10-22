import { describe, expect, it, vi } from 'vitest';
import { canonicalRepositoryPath, repositoryStorageId } from './repositoryIdentity';
import { ReviewSession } from './reviewSession';
import { WorkspaceStateReviewStore } from './reviewStore';
import type { ReviewSnapshot, PerFileState } from './reviewStore';
import type * as vscode from 'vscode';
import type { ReviewSet } from '../scope/types';

function memoryStore() {
  const records = new Map<string, unknown>();
  const memento: vscode.Memento = {
    keys: () => [...records.keys()],
    get: <T>(key: string, fallback?: T) => (records.has(key) ? records.get(key) as T : fallback),
    update: async (key, value) => { if (value === undefined) records.delete(key); else records.set(key, value); },
  };
  return { records, store: new WorkspaceStateReviewStore(memento) };
}

const set = (sha = 'a'.repeat(40)): ReviewSet => ({
  scopeId: 'pr-1', label: 'PR #1', headSha: sha,
  source: { kind: 'commit', headRef: 'feature' }, files: [{ path: 'src/example.ts' }],
});

describe('repository and source storage identity', () => {
  it('normalizes Windows spelling but does not collide for same-name repositories', () => {
    expect(canonicalRepositoryPath('C:\\Work\\Repo\\..\\Repo')).toBe('c:/work/repo');
    expect(repositoryStorageId('C:\\Work\\Repo')).toBe(repositoryStorageId('c:/work/repo'));
    expect(repositoryStorageId('C:\\first\\repo')).not.toBe(repositoryStorageId('C:\\second\\repo'));
    expect(repositoryStorageId('/first/Repo')).not.toBe(repositoryStorageId('/first/repo'));
  });

  it('isolates findings, annotations and conclusions by root and exact code scope', async () => {
    const { store } = memoryStore();
    const session = new ReviewSession(store, 'repo');
    await session.start(set(), 'C:\\first\\repo');
    const firstKey = session.getRepoName();
    session.setFindings('src/example.ts', [{ id: 'f0', line: 1, severity: 'bug', title: 'Old', detail: 'Different source' }]);
    await session.persist();
    await session.start(set(), 'C:\\second\\repo');
    expect(session.getRepoName()).not.toBe(firstKey);
    expect(session.findings('src/example.ts')).toEqual([]);
    expect(session.getRepoLabel()).toBe('repo');
    await session.start(set('b'.repeat(40)), 'C:\\first\\repo');
    expect(session.findings('src/example.ts')).toEqual([]);
    await session.start({ ...set(), scopeId: 'pr-2' }, 'C:\\first\\repo');
    expect(session.findings('src/example.ts')).toEqual([]);
    await session.start(set(), 'C:\\first\\repo');
    expect(session.findings('src/example.ts')[0].title).toBe('Old');
    expect(session.snapshot).toMatchObject({ schemaVersion: 2, repositoryRoot: 'c:/first/repo' });
    session.dispose();
  });

  it('preserves ambiguous basename history separately without migrating approval or notes into another repo', async () => {
    const { records, store } = memoryStore();
    const oldFile: PerFileState = {
      seenLines: [1], totalLines: 1, analyzed: true, findings: [], confirmedFindings: [],
      annotations: [{ id: 'note', kind: 'note', startLine: 1, endLine: 1, sourceText: 'old', content: 'keep me', createdAt: 1 }],
    };
    const legacy: ReviewSnapshot = {
      repo: 'repo', scopeId: 'pr-1', headSha: set().headSha, perFile: { 'src/example.ts': oldFile },
      globalDone: true, conclusion: { verdict: 'approve', label: 'Approved', target: 'pr', prNumber: 1, submittedAt: 1 }, updatedAt: 1,
    };
    records.set(`codereview:review:repo#pr-1@${legacy.headSha}`, legacy);
    records.set('codereview:file:repo#src/example.ts', oldFile);
    const session = new ReviewSession(store, 'repo');
    await session.start(set(), 'C:\\new\\repo');
    expect(session.findings('src/example.ts')).toEqual([]);
    expect(session.annotations('src/example.ts')).toEqual([]);
    expect(session.conclusion).toBeUndefined();
    expect(session.globalConfirmed).toBe(false);
    expect(session.legacyArchive?.snapshots[0]).toEqual(legacy);
    expect(session.legacyArchive?.files['src/example.ts'].annotations?.[0].content).toBe('keep me');
    expect(records.get('codereview:file:repo#src/example.ts')).toEqual(oldFile);
    session.dispose();
  });

  it('does not reuse reviews when the remote repository changes at the same local path', async () => {
    const { store } = memoryStore();
    const session = new ReviewSession(store, 'repo');
    await session.start({ ...set(), repositoryIdentity: 'github.com/first/repo' }, 'C:\\repo');
    const first = session.getRepoName();
    session.addAnnotation('src/example.ts', {
      id: 'n1', kind: 'note', startLine: 1, endLine: 1, sourceText: '', content: 'First repository only', createdAt: 1,
    });
    await session.persist();
    await session.start({ ...set(), repositoryIdentity: 'github.com/second/repo' }, 'C:\\repo');
    expect(session.getRepoName()).not.toBe(first);
    expect(session.annotations('src/example.ts')).toEqual([]);
    await session.start({ ...set(), repositoryIdentity: 'github.com/first/repo' }, 'C:\\repo');
    expect(session.annotations('src/example.ts')[0].content).toBe('First repository only');
    session.dispose();
  });

  it('invalidates approval when the target base tip advances even if the merge-base and head stay the same', async () => {
    const { store } = memoryStore();
    const session = new ReviewSession(store, 'repo');
    const previous = {
      ...set(), comparison: { baseSha: 'b'.repeat(40), headSha: set().headSha },
      source: { kind: 'commit' as const, headRef: 'feature', baseRef: 'main', baseTipSha: 'c'.repeat(40) },
    };
    await session.start(previous, 'C:\\repo');
    session.setConclusion({ verdict: 'approve', label: 'Approved old base', target: 'pr', prNumber: 1, submittedAt: 1 });
    await session.persist();
    const oldKey = session.getRepoName();
    await session.start({ ...previous, source: { ...previous.source, baseTipSha: 'd'.repeat(40) } }, 'C:\\repo');
    expect(session.getRepoName()).not.toBe(oldKey);
    expect(session.conclusion).toBeUndefined();
    expect(session.globalConfirmed).toBe(false);
    expect(session.snapshot?.source?.baseTipSha).toBe('d'.repeat(40));
    session.dispose();
  });

  it('records a late PR publication against its original snapshot without clearing another scopes drafts', async () => {
    const { store } = memoryStore();
    const session = new ReviewSession(store, 'repo');
    await session.start(set(), 'C:\\repo');
    session.addPendingComment({ id: 'posted', path: 'src/example.ts', startLine: 1, endLine: 1, body: 'Posted text', source: 'manual', createdAt: 1 });
    session.addPendingComment({ id: 'keep', path: 'src/example.ts', startLine: 2, endLine: 2, body: 'Not posted', source: 'manual', createdAt: 2 });
    const old = session.snapshot!;
    await session.start({ ...set(), scopeId: 'pr-2' }, 'C:\\repo');
    session.addPendingComment({ id: 'new-scope', path: 'src/example.ts', startLine: 1, endLine: 1, body: 'Other PR', source: 'manual', createdAt: 3 });
    await session.recordPostedConclusion(old, { verdict: 'comment', label: 'Posted', target: 'pr', prNumber: 1, submittedAt: 4 }, ['posted']);
    expect(session.pendingComments.map((item) => item.id)).toEqual(['new-scope']);
    expect(session.conclusion).toBeUndefined();
    const saved = await store.load(old);
    expect(saved?.pendingComments?.map((item) => item.id)).toEqual(['keep']);
    expect(saved?.conclusion?.prNumber).toBe(1);
    session.dispose();
  });

  it('merges a late receipt into the same reloaded scope without losing new drafts or retaining posted drafts', async () => {
    const { store } = memoryStore();
    const session = new ReviewSession(store, 'repo');
    await session.start(set(), 'C:\\repo');
    session.addPendingComment({ id: 'posted', path: 'src/example.ts', startLine: 1, endLine: 1, body: 'Published', source: 'manual', createdAt: 1 });
    await session.persist();
    const old = session.snapshot!;
    await session.start(set(), 'C:\\repo');
    session.addPendingComment({ id: 'new', path: 'src/example.ts', startLine: 2, endLine: 2, body: 'Still a draft', source: 'manual', createdAt: 2 });
    await session.recordPostedConclusion(old, { verdict: 'comment', label: 'Posted', target: 'pr', prNumber: 1, submittedAt: 3 }, ['posted']);
    expect(session.pendingComments.map((comment) => comment.id)).toEqual(['new']);
    expect((await store.load(old))?.pendingComments?.map((comment) => comment.id)).toEqual(['new']);
    session.dispose();
  });

  it('does not count a context-limited snapshot analysis as full readiness', async () => {
    const { store } = memoryStore();
    const session = new ReviewSession(store, 'repo');
    await session.start(set(), 'C:\\repo');
    session.setFindings('src/example.ts', [], {
      candidates: 0, confirmed: 0, dismissed: 0, unresolved: 0,
      contextTruncated: true, contextLimitReasons: ['language-services-unavailable'],
    });
    expect(session.fileReady('src/example.ts')).toBe(false);
    expect(session.totalCoverage().filesReady).toBe(0);
    expect(session.gatePassed()).toBe(false);
    session.dispose();
  });

  it('discards a slow older repository load instead of replacing the newer session', async () => {
    const { store } = memoryStore();
    let completeOld!: (value: ReviewSnapshot | undefined) => void;
    const oldLoad = new Promise<ReviewSnapshot | undefined>((resolve) => { completeOld = resolve; });
    const load = vi.spyOn(store, 'load').mockImplementationOnce(() => oldLoad);
    const session = new ReviewSession(store, 'repo');
    const old = session.start(set(), 'C:\\old\\repo');
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await session.start({ ...set(), scopeId: 'pr-2' }, 'C:\\new\\repo');
    completeOld(undefined);
    await old;
    expect(session.getCwd()).toBe('C:\\new\\repo');
    expect(session.snapshot?.repositoryRoot).toBe('c:/new/repo');
    expect(session.reviewSet?.scopeId).toBe('pr-2');
    session.dispose();
  });
});
