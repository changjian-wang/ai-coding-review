/** A single file in a review set. */
export interface ReviewFile {
  /** Repository-relative path, e.g. "src/foo/bar.ts". */
  path: string;
  /** Repository-relative path before a rename; absent for non-renamed files. */
  previousPath?: string;
  /** Added lines, when the scope was defined by a diff. Absent for pure source review. */
  additions?: number;
  /** Deleted lines, when the scope was defined by a diff. */
  deletions?: number;
  status?: 'added' | 'modified' | 'deleted' | 'renamed';
}

/** The immutable endpoints used to render a full-file diff. */
export interface ReviewComparison {
  /** Commit containing the old side of the comparison. */
  baseSha: string;
  /** Commit containing the new side of the comparison. */
  headSha: string;
}

/**
 * A reviewable set of source files. The review subject is always the source
 * itself (the whole file's logic); the scope only decides WHICH files are in.
 */
export interface ReviewSet {
  /** Stable id for this scope; part of the persistence key. */
  scopeId: string;
  /** Human label shown in the UI, e.g. "PR #42" or "选定的源码 (3)". */
  label: string;
  /**
   * Commit SHA review progress is bound to, when meaningful. "live" means the
   * scope is not pinned to a commit (e.g. directly-selected source files).
   */
  headSha: string;
  files: ReviewFile[];
  /** Present only for scopes whose files came from a diff. */
  comparison?: ReviewComparison;
}

/**
 * Anything that can define a ReviewSet — a way to scope which source files are
 * under review. A PR / branch comparison / working tree merely *lists* files;
 * a file-system selection picks them directly with no diff at all.
 */
export interface ReviewScope {
  /** Loads the review set, or throws an Error with a user-facing message. */
  load(cwd: string): Promise<ReviewSet>;
}
