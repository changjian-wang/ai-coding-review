import { businessHash, type BusinessReviewRun } from './businessReview';
import { m } from '../i18n';
import type { ReviewSession } from './reviewSession';

export type ReviewStage = 'prepare' | 'review' | 'conclusion';
export type ReviewNavigator = 'findings' | 'files';
export type ReviewInspectorTab = 'judgment' | 'evidence' | 'handling';
export type ReviewSelection =
  | { kind: 'overview' }
  | { kind: 'finding' | 'critical' | 'legacy'; id: string };
export type ReviewSourceSelection =
  | { kind: 'file'; path: string }
  | { kind: 'reference'; id: string };

export interface ReviewWorkspaceView {
  version: 1;
  layout?: 'issues-first';
  scopeKey: string;
  runId?: string;
  stage: ReviewStage;
  navigator: ReviewNavigator;
  selection: ReviewSelection;
  source?: ReviewSourceSelection;
  inspector: ReviewInspectorTab;
  focus: boolean;
}

export class ReviewWorkspaceDataError extends Error {
  constructor() { super(m().reviewCenter.invalidView); }
}

export function createWorkspaceView(scopeKey: string): ReviewWorkspaceView {
  return { version: 1, layout: 'issues-first', scopeKey, stage: 'review', navigator: 'findings', selection: { kind: 'overview' }, inspector: 'judgment', focus: false };
}

export function restoreWorkspaceView(value: unknown, scopeKey: string): ReviewWorkspaceView {
  if (value === undefined) return createWorkspaceView(scopeKey);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReviewWorkspaceDataError();
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.scopeKey !== 'string' || v.scopeKey !== scopeKey
    || !['prepare', 'review', 'conclusion'].includes(String(v.stage))
    || !['business', 'findings', 'feedback', 'files'].includes(String(v.navigator))
    || !['judgment', 'evidence', 'handling'].includes(String(v.inspector))
    || typeof v.focus !== 'boolean' || v.runId !== undefined && typeof v.runId !== 'string'
    || v.layout !== undefined && v.layout !== 'issues-first') throw new ReviewWorkspaceDataError();
  if (!v.selection || typeof v.selection !== 'object' || Array.isArray(v.selection)) throw new ReviewWorkspaceDataError();
  const selection = v.selection as Record<string, unknown>;
  if (!['overview', 'unit', 'finding', 'critical', 'legacy'].includes(String(selection.kind))
    || selection.kind !== 'overview' && (typeof selection.id !== 'string' || !selection.id)) throw new ReviewWorkspaceDataError();
  if (v.source !== undefined) {
    if (!v.source || typeof v.source !== 'object' || Array.isArray(v.source)) throw new ReviewWorkspaceDataError();
    const source = v.source as Record<string, unknown>;
    if (source.kind !== 'file' && source.kind !== 'reference'
      || source.kind === 'file' && (typeof source.path !== 'string' || !source.path)
      || source.kind === 'reference' && (typeof source.id !== 'string' || !source.id)) throw new ReviewWorkspaceDataError();
  }
  const restored = structuredClone(value) as ReviewWorkspaceView;
  if (v.navigator === 'business' || v.navigator === 'feedback') restored.navigator = 'findings';
  if (selection.kind === 'unit') {
    restored.selection = { kind: 'overview' };
    restored.source = undefined;
  }
  if (!restored.layout) {
    restored.layout = 'issues-first';
    restored.navigator = 'findings';
    restored.focus = false;
  }
  return restored;
}

export function reconcileWorkspaceView(view: ReviewWorkspaceView, run: BusinessReviewRun | undefined): ReviewWorkspaceView {
  const next = structuredClone(view);
  if (next.runId !== run?.id) {
    if (next.selection.kind !== 'legacy') next.selection = { kind: 'overview' };
    next.navigator = 'findings';
    if (next.source?.kind === 'reference') next.source = undefined;
    next.runId = run?.id;
  }
  return next;
}

export function openReviewProblems(run: BusinessReviewRun | undefined): { kind: 'finding' | 'critical'; id: string }[] {
  if (!run) return [];
  const severity = { high: 0, medium: 1, low: 2 };
  return [
    ...run.priorCritical.filter((item) => !run.priorCriticalVerdicts.some((verdict) => verdict.id === item.id && verdict.status === 'cleared'))
      .map((item) => ({ kind: 'critical' as const, id: item.id })),
    ...run.findings.filter((finding) => finding.status !== 'dismissed')
      .sort((a, b) => Number(a.status === 'unresolved') - Number(b.status === 'unresolved') || severity[a.severity] - severity[b.severity])
      .map((finding) => ({ kind: 'finding' as const, id: finding.id })),
  ];
}

export function legacySelectionId(path: string, signature: string): string {
  return `legacy-${businessHash(JSON.stringify([path, signature])).slice(0, 24)}`;
}

export function captureReviewFileAction(
  session: ReviewSession, path: string, sourceHash: string, read: () => Promise<string>,
): (apply: () => void) => Promise<void> {
  const snapshot = session.snapshot;
  const set = session.reviewSet;
  const same = () => !!snapshot && !!set && session.snapshot === snapshot && session.reviewSet === set && session.hasReviewFile(path);
  if (!same()) throw new Error(m().reviewCenter.staleDocument);
  return async (apply) => {
    if (!same()) throw new Error(m().reviewCenter.staleDocument);
    const text = await read();
    if (!same() || businessHash(text) !== sourceHash) throw new Error(m().reviewCenter.staleDocument);
    apply();
  };
}
