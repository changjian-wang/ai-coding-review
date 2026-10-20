import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewSet } from '../scope/types';
import {
  findingContentSignature,
  findingContentSignatures,
  globalFixSpotSignature,
} from '../ai/types';
import type {
  PerFileState,
  ReviewKey,
  ReviewSnapshot,
  ReviewStore,
} from './reviewStore';
import { ReviewSession } from './reviewSession';

describe('ReviewSession seen-line persistence', () => {
  afterEach(() => vi.useRealTimers());

  it('coalesces repeated scroll coverage into one trailing file write', async () => {
    vi.useFakeTimers();
    const store = new RecordingStore();
    const session = new ReviewSession(store, 'repo');
    await session.start(reviewSet(), 'C:\\repo');

    session.markSeen('src/example.ts', [1, 2]);
    session.markSeen('src/example.ts', [3, 4]);

    expect(store.fileWrites).toBe(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(store.fileWrites).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.fileWrites).toBe(1);
    expect(store.lastFileState?.seenLines).toEqual([1, 2, 3, 4]);
    session.dispose();
  });

  it('flushes pending coverage before replacing the active review', async () => {
    vi.useFakeTimers();
    const store = new RecordingStore();
    const session = new ReviewSession(store, 'repo');
    await session.start(reviewSet(), 'C:\\repo');
    session.markSeen('src/example.ts', [1, 2]);

    await session.start({
      scopeId: 'files-1-next',
      label: 'Next scope',
      headSha: 'live',
      files: [{ path: 'src/next.ts' }],
    }, 'C:\\repo');

    expect(store.fileWrites).toBe(1);
    expect(store.lastFileState?.seenLines).toEqual([1, 2]);
    session.dispose();
  });
});

describe('ReviewSession review-file index', () => {
  it('serves hot-path status queries without scanning the review array', async () => {
    const files: ReviewSet['files'] = [
      { path: 'src/live.ts', status: 'modified' },
      { path: 'src/deleted.ts', status: 'deleted' },
    ];
    const session = new ReviewSession(new RecordingStore(), 'repo');
    await session.start({
      scopeId: 'pr-1',
      label: 'PR #1',
      headSha: 'abc',
      files,
    }, 'C:\\repo');
    files.find = () => { throw new Error('linear find should not run'); };
    files.some = () => { throw new Error('linear some should not run'); };

    expect(session.hasReviewFile('src/live.ts')).toBe(true);
    expect(session.reviewFile('src/live.ts')?.status).toBe('modified');
    expect(session.fileReady('src/deleted.ts')).toBe(true);
    expect(session.fileReady('src/live.ts')).toBe(false);
    session.dispose();
  });
});

describe('ReviewSession sparse state', () => {
  it('does not allocate empty state for untouched files', async () => {
    const store = new RecordingStore();
    const session = new ReviewSession(store, 'repo');
    const files = Array.from({ length: 5000 }, (_, index) => ({
      path: `src/File${index}.ts`,
    }));

    await session.start({
      scopeId: 'files-5000-test',
      label: 'Large scope',
      headSha: 'live',
      files,
    }, 'C:\\repo');

    expect(store.bulkLoads).toBe(1);
    expect(Object.keys(session.snapshot?.perFile ?? {})).toHaveLength(0);
    session.setTotalLines(files[0].path, 20);
    expect(Object.keys(session.snapshot?.perFile ?? {})).toEqual([files[0].path]);
    session.dispose();
  });

  it('aggregates only touched states while counting deleted files as ready', async () => {
    const session = new ReviewSession(new RecordingStore(), 'repo');
    await session.start({
      scopeId: 'pr-7',
      label: 'PR #7',
      headSha: 'abc',
      files: [
        { path: 'src/live.ts', status: 'modified' },
        { path: 'src/deleted.ts', status: 'deleted' },
        { path: 'src/untouched.ts', status: 'modified' },
      ],
    }, 'C:\\repo');
    session.setTotalLines('src/live.ts', 10);
    session.markSeen('src/live.ts', [1, 2, 3]);
    session.setFindings('src/live.ts', []);

    expect(session.totalCoverage()).toEqual({
      seen: 3,
      total: 10,
      filesReady: 2,
      filesTotal: 3,
    });
    session.dispose();
  });

  it('keeps unresolved repository candidates visible without blocking readiness', async () => {
    const session = new ReviewSession(new RecordingStore(), 'repo');
    await session.start(reviewSet(), 'C:\\repo');
    session.setFindings('src/example.ts', [{
      id: 'f0',
      line: 4,
      severity: 'conditional',
      title: 'Needs repository evidence',
      detail: 'The external contract could not be established.',
      verification: {
        status: 'unresolved',
        rationale: 'No definition provider was available.',
        evidence: [],
      },
    }], {
      candidates: 2,
      confirmed: 0,
      dismissed: 1,
      unresolved: 1,
    });

    expect(session.findings('src/example.ts')).toHaveLength(1);
    expect(session.actionableFindings('src/example.ts')).toEqual([]);
    expect(session.unconfirmedCount('src/example.ts')).toBe(0);
    expect(session.fileReady('src/example.ts')).toBe(true);
    expect(session.fileState('src/example.ts')?.analysisSummary).toEqual({
      candidates: 2,
      confirmed: 0,
      dismissed: 1,
      unresolved: 1,
    });
    session.dispose();
  });

  it('reconciles global flip verdicts through content signatures, not finding ids', async () => {
    const session = new ReviewSession(new RecordingStore(), 'repo');
    await session.start(reviewSet(), 'C:\\repo');
    const finding = {
      id: 'f7',
      line: 4,
      severity: 'conditional' as const,
      title: 'Possible KeyError',
      detail: 'The return contract is external.',
      anchor: 'public.pop("default_analyzer")',
    };
    session.setFindings('src/example.ts', [finding]);

    const changed = session.reconcileGlobalVerdicts({
      conclusion: 'The candidate is a false positive.',
      recommendation: 'approve',
      evidence: [],
      verdicts: [{
        kind: 'flip',
        title: 'Key guaranteed',
        before: 'The key may be absent.',
        after: 'The producer always includes the key.',
        file: 'src/example.ts',
        line: 4,
        findingRef: findingContentSignature({ ...finding, id: 'different-positional-id' }),
      }],
      fixSpots: [],
    });

    expect(changed).toEqual(['src/example.ts']);
    expect(session.findings('src/example.ts')[0].verification).toMatchObject({
      status: 'overturned',
      rationale: 'The producer always includes the key.',
    });
    expect(session.fileReady('src/example.ts')).toBe(true);

    const cleared = session.reconcileGlobalVerdicts({
      conclusion: 'No cross-file verdicts remain.',
      recommendation: 'comment',
      evidence: [],
      verdicts: [],
      fixSpots: [],
    });
    expect(cleared).toEqual(['src/example.ts']);
    expect(session.findings('src/example.ts')[0].verification).toBeUndefined();
    expect(session.fileReady('src/example.ts')).toBe(false);

    session.reconcileGlobalVerdicts({
      conclusion: 'The candidate is a false positive.',
      recommendation: 'approve',
      evidence: [],
      verdicts: [{
        kind: 'flip',
        title: 'Key guaranteed',
        before: 'The key may be absent.',
        after: 'The producer always includes the key.',
        file: 'src/example.ts',
        line: 4,
        findingRef: findingContentSignature(finding),
      }],
      fixSpots: [],
    });
    session.setGlobalReport({
      conclusion: 'The candidate is a false positive.',
      recommendation: 'approve',
      evidence: [],
      verdicts: [{
        kind: 'flip',
        title: 'Key guaranteed',
        before: 'The key may be absent.',
        after: 'The producer always includes the key.',
        file: 'src/example.ts',
        line: 4,
        findingRef: findingContentSignature(finding),
      }],
      fixSpots: [],
    });
    session.setFindings('src/example.ts', [{ ...finding, id: 'f99', verification: undefined }]);
    expect(session.findings('src/example.ts')[0].verification).toBeUndefined();
    expect(session.globalReport).toBeUndefined();
    expect(session.globalConfirmed).toBe(false);
    session.dispose();
  });

  it('invalidates a confirmed global review after file findings change', async () => {
    const session = new ReviewSession(new RecordingStore(), 'repo');
    await session.start(reviewSet(), 'C:\\repo');
    session.setFindings('src/example.ts', []);
    session.setGlobalReport({
      conclusion: 'No cross-file issues.',
      recommendation: 'approve',
      evidence: [],
      verdicts: [],
      fixSpots: [],
    });
    session.confirmGlobal();
    expect(session.globalConfirmed).toBe(true);

    session.setFindings('src/example.ts', [{
      id: 'f0',
      line: 1,
      severity: 'bug',
      title: 'New issue',
      detail: 'Fresh file analysis result.',
    }]);

    expect(session.globalConfirmed).toBe(false);
    session.dispose();
  });

  it('invalidates file and global analysis after an applied edit changes source', async () => {
    const session = new ReviewSession(new RecordingStore(), 'repo');
    await session.start(reviewSet(), 'C:\\repo');
    session.setFindings('src/example.ts', []);
    session.setGlobalReport({
      conclusion: 'No cross-file issues.',
      recommendation: 'approve',
      evidence: [],
      verdicts: [],
      fixSpots: [],
    });
    session.confirmGlobal();
    expect(session.fileReady('src/example.ts')).toBe(true);

    session.invalidateAfterFileChange('src/example.ts');

    expect(session.fileState('src/example.ts')?.analyzed).toBe(false);
    expect(session.globalReport).toBeUndefined();
    expect(session.globalConfirmed).toBe(false);
    expect(session.gatePassed()).toBe(false);
    session.dispose();
  });

  it('removes related-file findings derived from an entry file after that entry changes', async () => {
    const store = new RecordingStore();
    const session = new ReviewSession(store, 'repo');
    await session.start(reviewSet(), 'C:\\repo');
    session.setRootedFindings('src/example.ts', {
      'src/dependency.ts': [{
        id: 'f0',
        line: 3,
        severity: 'bug',
        title: 'Derived bug',
        detail: 'Confirmed through the entry-file call path.',
        anchor: 'broken();',
        analysisRoot: 'src/example.ts',
      }],
    }, {
      candidates: 1,
      confirmed: 1,
      dismissed: 0,
      unresolved: 0,
    });
    expect(session.findings('src/dependency.ts')).toHaveLength(1);

    session.invalidateAfterFileChange('src/example.ts');

    expect(session.findings('src/dependency.ts')).toEqual([]);
    expect(session.reviewSet?.files.map((file) => file.path)).not.toContain(
      'src/dependency.ts',
    );
    expect(store.clearedFiles).toContain('src/dependency.ts');
    session.dispose();
  });

  it('invalidates rooted results when a non-scope dependency changes', async () => {
    const session = new ReviewSession(new RecordingStore(), 'repo');
    await session.start(reviewSet(), 'C:\\repo');
    session.setRootedFindings('src/example.ts', {
      'src/example.ts': [{
        id: 'f0',
        line: 3,
        severity: 'bug',
        title: 'Dependency mismatch',
        detail: 'The root assumption conflicts with shared.ts.',
        anchor: 'useShared();',
        analysisRoot: 'src/example.ts',
      }],
    }, {
      candidates: 1,
      confirmed: 1,
      dismissed: 0,
      unresolved: 0,
    }, ['src/example.ts', 'src/shared.ts']);
    expect(session.fileState('src/example.ts')?.analyzed).toBe(true);
    expect(session.hasAnalysisDependency('src/shared.ts')).toBe(true);

    const changed = session.invalidateAfterFileChange('src/shared.ts');

    expect(changed.changed).toBe(true);
    expect(changed.affectedFiles).toContain('src/example.ts');
    expect(session.fileState('src/example.ts')?.analyzed).toBe(false);
    expect(session.findings('src/example.ts')).toEqual([]);
    expect(session.hasAnalysisDependency('src/shared.ts')).toBe(false);
    session.dispose();
  });

  it('keeps a shared finding while another confirming root remains valid', async () => {
    const session = new ReviewSession(new RecordingStore(), 'repo');
    await session.start({
      scopeId: 'files-shared-root-test',
      label: 'Shared roots',
      headSha: 'live',
      files: [{ path: 'src/root-a.ts' }, { path: 'src/root-b.ts' }],
    }, 'C:\\repo');
    const sharedFinding = {
      id: 'temporary',
      line: 7,
      severity: 'bug' as const,
      title: 'Shared dependency bug',
      detail: 'Both roots reach the same broken behavior.',
      anchor: 'throw broken;',
      verification: {
        status: 'repo-confirmed' as const,
        rationale: 'Both call paths reach this statement.',
        evidence: [],
        source: 'file' as const,
      },
    };
    session.setRootedFindings('src/root-a.ts', {
      'src/dependency.ts': [sharedFinding],
    }, {
      candidates: 1,
      confirmed: 1,
      dismissed: 0,
      unresolved: 0,
    }, ['src/root-a.ts', 'src/dependency.ts']);
    session.setRootedFindings('src/root-b.ts', {
      'src/dependency.ts': [sharedFinding],
    }, {
      candidates: 1,
      confirmed: 1,
      dismissed: 0,
      unresolved: 0,
    }, ['src/root-b.ts', 'src/dependency.ts']);

    expect(session.findings('src/dependency.ts')).toHaveLength(1);
    expect(session.findings('src/dependency.ts')[0].analysisRoots).toEqual([
      'src/root-a.ts',
      'src/root-b.ts',
    ]);

    session.invalidateAfterFileChange('src/root-b.ts');

    expect(session.findings('src/dependency.ts')).toHaveLength(1);
    expect(session.findings('src/dependency.ts')[0].analysisRoots).toEqual([
      'src/root-a.ts',
    ]);
    session.dispose();
  });

  it('keeps distinct bugs on the same statement as separate findings', async () => {
    const session = new ReviewSession(new RecordingStore(), 'repo');
    await session.start({
      scopeId: 'files-distinct-root-test',
      label: 'Distinct roots',
      headSha: 'live',
      files: [{ path: 'src/root-a.ts' }, { path: 'src/root-b.ts' }],
    }, 'C:\\repo');
    const location = {
      id: 'temporary',
      line: 7,
      severity: 'bug' as const,
      anchor: 'dangerousCall();',
    };
    session.setRootedFindings('src/root-a.ts', {
      'src/dependency.ts': [{
        ...location,
        title: 'Resource leak',
        detail: 'The call leaks its acquired resource.',
      }],
    }, {
      candidates: 1,
      confirmed: 1,
      dismissed: 0,
      unresolved: 0,
    });
    session.setRootedFindings('src/root-b.ts', {
      'src/dependency.ts': [{
        ...location,
        title: 'Unhandled rejection',
        detail: 'The same call can reject without a handler.',
      }],
    }, {
      candidates: 1,
      confirmed: 1,
      dismissed: 0,
      unresolved: 0,
    });

    expect(session.findings('src/dependency.ts').map((finding) => finding.title))
      .toEqual(['Resource leak', 'Unhandled rejection']);
    session.dispose();
  });

  it('resolves duplicate finding references to the correct occurrence', async () => {
    const session = new ReviewSession(new RecordingStore(), 'repo');
    await session.start(reviewSet(), 'C:\\repo');
    const duplicate = {
      severity: 'conditional' as const,
      title: 'Repeated issue',
      detail: 'Same content at two locations.',
      anchor: 'same_call()',
    };
    session.setFindings('src/example.ts', [
      { ...duplicate, id: 'f0', line: 20 },
      { ...duplicate, id: 'f1', line: 10 },
    ]);
    const findings = session.findings('src/example.ts');
    const refs = findingContentSignatures(findings);

    expect(refs[0]).not.toBe(refs[1]);
    expect(session.findingByContentRef('src/example.ts', refs[0])?.line).toBe(20);
    expect(session.findingByContentRef('src/example.ts', refs[1])?.line).toBe(10);
    session.dispose();
  });

  it('uses the global spot line to disambiguate duplicate anchors', async () => {
    const session = new ReviewSession(new RecordingStore(), 'repo');
    await session.start(reviewSet(), 'C:\\repo');
    session.setFindings('src/example.ts', [{
      id: 'f0',
      line: 10,
      severity: 'bug',
      title: 'First occurrence',
      detail: 'First repeated call.',
      anchor: 'dangerousCall();',
    }, {
      id: 'f1',
      line: 20,
      severity: 'bug',
      title: 'Second occurrence',
      detail: 'Second repeated call.',
      anchor: 'dangerousCall();',
    }]);

    expect(
      session.resolveFixSpotFinding('src/example.ts', 20, 'dangerousCall();')?.title,
    ).toBe('Second occurrence');
    expect(
      session.resolveFixSpotFinding('src/example.ts', 15, 'dangerousCall();'),
    ).toBeUndefined();
    session.dispose();
  });

  it('migrates legacy positional global fix dispositions to stable spot ids', async () => {
    const session = new ReviewSession(new RecordingStore(), 'repo');
    await session.start(reviewSet(), 'C:\\repo');
    const legacySpot = {
      id: 'g0',
      file: 'src/other.ts',
      line: 8,
      anchor: 'dangerousCall()',
      severity: 'bug' as const,
      title: 'Dangerous call',
      detail: 'The call violates the cross-file contract.',
    };
    session.setGlobalReport({
      conclusion: 'Issue found.',
      recommendation: 'request_changes',
      evidence: [],
      verdicts: [],
      fixSpots: [legacySpot],
    });
    session.setGlobalFixDisposition(
      legacySpot.id,
      legacySpot.file,
      legacySpot.line,
      legacySpot.anchor,
      { kind: 'ignored', reason: 'accepted', at: 1 },
    );
    const stableSpot = { ...legacySpot, id: globalFixSpotSignature(legacySpot) };

    session.setGlobalReport({
      conclusion: 'Issue still present.',
      recommendation: 'request_changes',
      evidence: [],
      verdicts: [],
      fixSpots: [stableSpot],
    });

    expect(session.globalFixDisposition(
      stableSpot.id,
      stableSpot.file,
      stableSpot.line,
      stableSpot.anchor,
    )).toMatchObject({ kind: 'ignored', reason: 'accepted' });
    session.dispose();
  });

  it('adds confirmed related-file bugs to the review without marking that file analyzed', async () => {
    const store = new RecordingStore();
    const session = new ReviewSession(store, 'repo');
    await session.start(reviewSet(), 'C:\\repo');
    const relatedFinding = {
      id: 'temporary',
      line: 12,
      severity: 'bug' as const,
      title: 'Broken dependency contract',
      detail: 'The related implementation returns an incompatible value.',
      anchor: 'return incompatible;',
      analysisRoot: 'src/example.ts',
      verification: {
        status: 'repo-confirmed' as const,
        rationale: 'The reachable caller and implementation disagree.',
        evidence: [],
        source: 'file' as const,
      },
    };

    const update = session.setRootedFindings('src/example.ts', {
      'src/dependency.ts': [relatedFinding],
    }, {
      candidates: 1,
      confirmed: 1,
      dismissed: 0,
      unresolved: 0,
      contextFiles: 2,
      contextTruncated: false,
      contextLimitReasons: [],
    });

    expect(update.addedFiles).toEqual(['src/dependency.ts']);
    expect(update.updatedFiles).toEqual(expect.arrayContaining([
      'src/example.ts',
      'src/dependency.ts',
    ]));
    expect(session.reviewSet?.files.map((file) => file.path)).toContain('src/dependency.ts');
    expect(session.snapshot?.contextFiles).toContain('src/dependency.ts');
    expect(session.fileState('src/example.ts')?.analyzed).toBe(true);
    expect(session.fileState('src/dependency.ts')?.analyzed).toBe(false);
    expect(session.findings('src/dependency.ts')[0]).toMatchObject({
      id: 'f0',
      analysisRoot: 'src/example.ts',
    });
    expect(session.fileReady('src/dependency.ts')).toBe(false);

    session.setFindingDisposition('src/dependency.ts', 'f0', {
      kind: 'commented',
      at: 1,
    });
    session.setRootedFindings('src/example.ts', {
      'src/dependency.ts': [{ ...relatedFinding, id: 'another-temporary-id' }],
    }, {
      candidates: 1,
      confirmed: 1,
      dismissed: 0,
      unresolved: 0,
    });
    expect(session.findingDisposition('src/dependency.ts', 'f0')?.kind).toBe('commented');

    session.setRootedFindings('src/example.ts', {}, {
      candidates: 0,
      confirmed: 0,
      dismissed: 0,
      unresolved: 0,
    });
    expect(session.findings('src/dependency.ts')).toEqual([]);
    expect(session.reviewSet?.files.map((file) => file.path)).not.toContain('src/dependency.ts');
    expect(session.snapshot?.contextFiles).not.toContain('src/dependency.ts');
    expect(store.clearedFiles).toContain('src/dependency.ts');
    session.dispose();
  });

  it('restores automatically-added context files and removes legacy unresolved cards', async () => {
    const store = new RecordingStore();
    store.scopeSnapshot = {
      repo: 'repo',
      scopeId: 'files-1-test',
      headSha: 'live',
      perFile: {},
      contextFiles: ['src/dependency.ts', '..\\outside.ts'],
      globalDone: false,
      updatedAt: 1,
    };
    store.filesToLoad.set('src/dependency.ts', {
      seenLines: [],
      totalLines: 20,
      analyzed: false,
      findings: [{
        id: 'f0',
        line: 2,
        severity: 'conditional',
        title: 'Legacy unresolved candidate',
        detail: 'Old evidence-insufficient output.',
        verification: {
          status: 'unresolved',
          rationale: 'No evidence.',
          evidence: [],
        },
      }],
      confirmedFindings: [],
    });
    const session = new ReviewSession(store, 'repo');

    await session.start(reviewSet(), 'C:\\repo');

    expect(session.reviewSet?.files.map((file) => file.path)).toEqual([
      'src/example.ts',
      'src/dependency.ts',
    ]);
    expect(session.findings('src/dependency.ts')).toEqual([]);
    session.dispose();
  });
});

class RecordingStore implements ReviewStore {
  fileWrites = 0;
  bulkLoads = 0;
  lastFileState?: PerFileState;
  scopeSnapshot?: ReviewSnapshot;
  filesToLoad = new Map<string, PerFileState>();
  clearedFiles: string[] = [];

  async load(_key: ReviewKey): Promise<ReviewSnapshot | undefined> {
    return this.scopeSnapshot;
  }

  async save(_snapshot: ReviewSnapshot): Promise<void> {}

  async clear(_key: ReviewKey): Promise<void> {}

  async loadFile(_repo: string, _filePath: string): Promise<PerFileState | undefined> {
    return undefined;
  }

  async loadFiles(
    _repo: string,
    _activePaths: ReadonlySet<string>,
  ): Promise<Map<string, PerFileState>> {
    this.bulkLoads++;
    return new Map(
      [...this.filesToLoad].filter(([filePath]) => _activePaths.has(filePath)),
    );
  }

  async saveFile(_repo: string, _filePath: string, state: PerFileState): Promise<void> {
    this.fileWrites++;
    this.lastFileState = { ...state, seenLines: [...state.seenLines] };
  }

  async clearFile(_repo: string, filePath: string): Promise<void> {
    this.clearedFiles.push(filePath);
    this.filesToLoad.delete(filePath);
  }
}

function reviewSet(): ReviewSet {
  return {
    scopeId: 'files-1-test',
    label: 'Selected sources (1)',
    headSha: 'live',
    files: [{ path: 'src/example.ts' }],
  };
}