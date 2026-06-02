/** Severity of a review finding, aligned with the prototype's vocabulary. */
export type FindingSeverity = 'bug' | 'conditional' | 'suggestion';

/** A single issue raised by file-level or global analysis. */
export interface Finding {
  /** Stable id within its file, used for confirmation tracking. */
  id: string;
  /** 1-based line where the issue starts. */
  line: number;
  /** 1-based line where the issue ends (defaults to `line`). */
  endLine?: number;
  severity: FindingSeverity;
  /** Short headline. */
  title: string;
  /** Full explanation / evidence. */
  detail: string;
  /** Optional concrete fix recommendation. */
  suggestion?: string;
}

/** One fix spot in the global report — a finding tied to a specific file. */
export interface GlobalFixSpot extends Finding {
  /** Repository-relative file path this fix lands in. */
  file: string;
}

/**
 * How a cross-file fact relates to the file-level reading:
 * - `flip`: a file-level assumption was overturned (false positive).
 * - `found`: a real bug only visible across files (file-level missed it).
 * - `confirmed`: global facts confirm the file-level reading stands.
 */
export type VerdictKind = 'flip' | 'found' | 'confirmed';

/** One before→after judgement in the evidence chain. */
export interface GlobalVerdict {
  kind: VerdictKind;
  title: string;
  /** What the file-level reading claimed (the "before"). */
  before: string;
  /** What cross-file facts establish (the "after"). */
  after: string;
  /** Concrete code/file evidence backing the after. */
  evidence?: string;
  /** Repository-relative file the verdict points at, for "locate". */
  file?: string;
  /** 1-based line the verdict points at. */
  line?: number;
}

/** Recommended overall outcome from the global analysis. */
export type GlobalRecommendation = 'approve' | 'request_changes' | 'comment';

/** One edge in the call graph backing the analysis. */
export interface CallGraphNode {
  /** Display name (symbol / service). */
  name: string;
  /** Short role label, e.g. "Authentication 层 · 唯一调用方". */
  role?: string;
  /** Lifetime / scope label, e.g. "Scoped". */
  lifetime?: string;
  /** Whether this node is part of the change set under review. */
  changed?: boolean;
}

/** A single architecture / intent conformance check. */
export interface ArchitectureCheck {
  /** ok = passes, warn = needs attention, info = note. */
  status: 'ok' | 'warn' | 'info';
  /** Short label, e.g. "分层合规" / "意图覆盖". */
  label: string;
  /** Detail / evidence. */
  detail: string;
}

/** Cross-file analysis report shown in the (single) rich webview. */
export interface GlobalReport {
  /** One-paragraph cross-file conclusion. */
  conclusion: string;
  /** Recommended outcome that the decision panel headlines. */
  recommendation: GlobalRecommendation;
  /** Ordered evidence chain backing the conclusion. */
  evidence: string[];
  /** Before→after verdicts: confirmed / overturned / newly found. */
  verdicts: GlobalVerdict[];
  /** Concrete fix spots, grouped by severity in the UI. */
  fixSpots: GlobalFixSpot[];
  /** Ordered call graph (caller → callee) backing the analysis. */
  callGraph: CallGraphNode[];
  /** Architecture-layer and PR-intent conformance checks. */
  architectureChecks: ArchitectureCheck[];
}
