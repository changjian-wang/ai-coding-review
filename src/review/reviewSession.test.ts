import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewSet } from '../scope/types';
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
});

class RecordingStore implements ReviewStore {
  fileWrites = 0;
  bulkLoads = 0;
  lastFileState?: PerFileState;

  async load(_key: ReviewKey): Promise<ReviewSnapshot | undefined> {
    return undefined;
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
    return new Map();
  }

  async saveFile(_repo: string, _filePath: string, state: PerFileState): Promise<void> {
    this.fileWrites++;
    this.lastFileState = { ...state, seenLines: [...state.seenLines] };
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