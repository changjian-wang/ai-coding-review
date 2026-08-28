/** Severity of a review finding, aligned with the prototype's vocabulary. */
export type FindingSeverity = 'bug' | 'conditional' | 'suggestion';

/** Repository evidence the verifier can request for a context-dependent candidate. */
export type EvidenceQueryKind =
  | 'definition'
  | 'references'
  | 'tests'
  | 'configuration'
  | 'contract';

export interface EvidenceQuery {
  kind: EvidenceQueryKind;
  /** Source identifier to resolve/search, e.g. `Config.to_public_dict`. */
  symbol: string;
  /** The exact contract question repository evidence must answer. */
  question: string;
}

export type FindingEvidenceKind =
  | 'root'
  | 'definition'
  | 'reference'
  | 'test'
  | 'configuration'
  | 'search';

/** Persisted, source-addressable evidence reference (source text itself is not persisted). */
export interface FindingEvidenceRef {
  kind: FindingEvidenceKind;
  file: string;
  line: number;
  endLine?: number;
}

export interface FileFindingVerification {
  status: 'repo-confirmed' | 'unresolved';
  rationale: string;
  evidence: FindingEvidenceRef[];
}

export interface FindingVerification {
  /**
   * `repo-confirmed` means repository evidence supports the finding.
   * `unresolved` is evidence-insufficient and therefore non-blocking.
   * `overturned` was disproved by later cross-file global analysis.
   */
  status: 'repo-confirmed' | 'unresolved' | 'overturned';
  rationale: string;
  evidence: FindingEvidenceRef[];
  /** File evidence is durable; global evidence is a replaceable overlay. */
  source?: 'file' | 'global';
  /** File-level verification restored when a later global run drops the overlay. */
  prior?: FileFindingVerification;
}

/** A single issue raised by file-level or global analysis. */
export interface Finding {
  /** Stable id within its file, used for confirmation tracking. */
  id: string;
  /** 1-based line where the issue starts. */
  line: number;
  /** 1-based line where the issue ends (defaults to `line`). */
  endLine?: number;
  /**
   * Verbatim source snippet (no line-number prefix) the finding refers to, used
   * to locate the issue by **content** instead of line number — robust against
   * line drift from edits/earlier fixes. Optional; callers fall back to `line`.
   */
  anchor?: string;
  severity: FindingSeverity;
  /** Short headline. */
  title: string;
  /** Full explanation / evidence. */
  detail: string;
  /** Optional concrete fix recommendation. */
  suggestion?: string;
  /** Present when repository-aware verification was required. */
  verification?: FindingVerification;
  /** Entry file whose rooted repository analysis produced this finding. */
  analysisRoot?: string;
  /** Every entry-file analysis that independently confirmed this same finding. */
  analysisRoots?: string[];
}

export function findingAnalysisRoots(finding: Finding): string[] {
  return finding.analysisRoots?.length
    ? finding.analysisRoots
    : finding.analysisRoot
      ? [finding.analysisRoot]
      : [];
}

export function findingHasAnalysisRoot(finding: Finding, root: string): boolean {
  return findingAnalysisRoots(finding).includes(root);
}

/** First-pass model output before repository-dependent claims are verified. */
export interface FileFindingCandidate extends Finding {
  candidateId: string;
  requiresRepoContext: boolean;
  evidenceQueries: EvidenceQuery[];
}

/** Source excerpt passed only to the verification model call. */
export interface RepositoryEvidenceSnippet extends FindingEvidenceRef {
  id: string;
  symbol: string;
  question: string;
  content: string;
}

export type RepositoryContextLimitReason =
  | 'depth'
  | 'files'
  | 'characters'
  | 'tokens'
  | 'provider-calls'
  | 'scan-characters'
  | 'scan-unavailable'
  | 'timeout';

/** Bounded repository graph rooted at the file whose analysis the user requested. */
export interface RepositoryAnalysisContext {
  rootPath: string;
  files: string[];
  lineCounts: Record<string, number>;
  /** Content fingerprint captured when each related file entered the graph. */
  fileHashes: Record<string, string>;
  snippets: RepositoryEvidenceSnippet[];
  truncated: boolean;
  limitReasons: RepositoryContextLimitReason[];
  providerCalls: number;
  totalCharacters: number;
}

/** A possible bug found from a rooted, multi-file repository context. */
export interface RootedFindingCandidate extends Finding {
  candidateId: string;
  file: string;
  evidenceIds: string[];
}

export interface CandidateEvidenceBundle {
  candidateId: string;
  snippets: RepositoryEvidenceSnippet[];
}

export type CandidateVerificationStatus = 'confirmed' | 'dismissed' | 'unresolved';

export interface CandidateVerification {
  candidateId: string;
  status: CandidateVerificationStatus;
  rationale: string;
  evidence: FindingEvidenceRef[];
}

/** Persisted aggregate from the latest file analysis, including auto-dismissed candidates. */
export interface FileAnalysisSummary {
  candidates: number;
  confirmed: number;
  dismissed: number;
  unresolved: number;
  contextFiles?: number;
  contextTruncated?: boolean;
  contextLimitReasons?: RepositoryContextLimitReason[];
}

export interface FileAnalysisResult {
  findings: Finding[];
  summary: FileAnalysisSummary;
}

export interface RootedFileAnalysisResult {
  findingsByFile: Record<string, Finding[]>;
  summary: FileAnalysisSummary;
}

/** Whether a finding must be disposed before the review gate can pass. */
export function isActionableFinding(finding: Finding): boolean {
  return finding.verification?.status !== 'unresolved'
    && finding.verification?.status !== 'overturned';
}

function identityHash(prefix: string, value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

function findingIdentityBase(finding: Finding): string {
  const body = (finding.anchor ?? finding.detail ?? '').trim();
  return `${finding.severity}\u0000${finding.title.trim()}\u0000${body}`;
}

/** Stable content identity plus occurrence rank for duplicate findings in one file. */
export function findingContentSignature(finding: Finding, occurrence = 0): string {
  return identityHash('finding', `${findingIdentityBase(finding)}\u0000${occurrence}`);
}

export function findingContentSignatures(findings: readonly Finding[]): string[] {
  const occurrences = new Array<number>(findings.length).fill(0);
  const groups = new Map<string, number[]>();
  findings.forEach((finding, index) => {
    const base = findingIdentityBase(finding);
    const group = groups.get(base) ?? [];
    group.push(index);
    groups.set(base, group);
  });
  for (const indexes of groups.values()) {
    indexes
      .sort((a, b) => findings[a].line - findings[b].line || a - b)
      .forEach((index, occurrence) => {
        occurrences[index] = occurrence;
      });
  }
  return findings.map((finding, index) =>
    findingContentSignature(finding, occurrences[index]),
  );
}

/** One fix spot in the global report — a finding tied to a specific file. */
export interface GlobalFixSpot extends Finding {
  /** Repository-relative file path this fix lands in. */
  file: string;
}

function globalFixSpotIdentityBase(
  spot: Pick<GlobalFixSpot, 'file' | 'line' | 'anchor' | 'severity' | 'title' | 'detail'>,
): string {
  return spot.anchor?.trim()
    ? [
        spot.file,
        spot.anchor.trim(),
        spot.severity,
        spot.title.trim().replace(/\s+/g, ' ').toLowerCase(),
        spot.detail.trim().replace(/\s+/g, ' ').toLowerCase(),
      ].join('\u0000')
    : [
        spot.file,
        spot.severity,
        spot.title.trim(),
        spot.detail.trim(),
      ].join('\u0000');
}

/** Stable content identity plus occurrence rank for duplicate global fix spots. */
export function globalFixSpotSignature(
  spot: Pick<GlobalFixSpot, 'file' | 'line' | 'anchor' | 'severity' | 'title' | 'detail'>,
  occurrence = 0,
): string {
  return identityHash(
    'global',
    `${globalFixSpotIdentityBase(spot)}\u0000${occurrence}`,
  );
}

export function globalFixSpotSignatures(
  spots: readonly Pick<
    GlobalFixSpot,
    'file' | 'line' | 'anchor' | 'severity' | 'title' | 'detail'
  >[],
): string[] {
  const occurrences = new Array<number>(spots.length).fill(0);
  const groups = new Map<string, number[]>();
  spots.forEach((spot, index) => {
    const base = globalFixSpotIdentityBase(spot);
    const group = groups.get(base) ?? [];
    group.push(index);
    groups.set(base, group);
  });
  for (const indexes of groups.values()) {
    indexes
      .sort((a, b) => spots[a].line - spots[b].line || a - b)
      .forEach((index, occurrence) => {
        occurrences[index] = occurrence;
      });
  }
  return spots.map((spot, index) =>
    globalFixSpotSignature(spot, occurrences[index]),
  );
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
  /** Stable content signature of the file-level finding being confirmed/flipped. */
  findingRef?: string;
}

/** Recommended overall outcome from the global analysis. */
export type GlobalRecommendation = 'approve' | 'request_changes' | 'comment';

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
}
