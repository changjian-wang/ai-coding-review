import type { ReviewFile } from '../scope/types';

export type { ReviewFile as ChangedFile };

/** Minimal pull-request shape AI Coding Review needs from the GitHub CLI. */
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  /** HEAD commit SHA — review progress is bound to this. */
  headRefOid: string;
  files: ReviewFile[];
}

/**
 * A pull-request list item for the PR picker — summary only, no file list, so
 * the listing stays a single fast gh call. Open PRs include drafts.
 */
export interface PrSummary {
  number: number;
  title: string;
  url: string;
  /** Author login (may be empty if gh omits it). */
  author: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  /** ISO timestamp of the last update, for "x ago" display. */
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}
