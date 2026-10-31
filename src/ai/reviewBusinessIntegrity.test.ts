import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { analyzeGlobal, finalizeFileAnalysis, finalizeRootedRepositoryAnalysis } from './analyzer';
import { findingContentSignature, globalFixSpotSignature, type Finding, type GlobalFixSpot, type RepositoryAnalysisContext } from './types';
import { parseBusinessReview, parseGlobalCandidateResults } from './reviewRequirements';
import { beginWorkflowRun, createReviewWorkflow, finishWorkflowRun, recordWorkflowFile } from '../review/reviewWorkflow';

const source = 'export function identity(value: number) { return value; }';
const path = 'src/identity.ts';
const visible = new Map([[path, source]]);
const proof = { kind: 'root', file: path, line: 1, quote: 'return value;' };
const finding: Finding = {
  id: 'f0', line: 1, anchor: 'return value;', severity: 'conditional', title: 'Unverified contract',
  detail: 'The external value contract has not been supplied.',
  verification: { status: 'unresolved', rationale: 'Caller contract unavailable.', evidence: [] },
};
const empty = { chains: [], requirements: [], concerns: [], limitations: [] };
const candidate: GlobalFixSpot = { ...finding, verification: undefined, id: '', file: path };
candidate.id = globalFixSpotSignature(candidate);

describe('evidenced final business adjudication', () => {
  it('does not turn a missing external contract into confirmation when repository context is disabled', () => {
    const result = finalizeFileAnalysis([{
      ...finding, candidateId: 'c0', requiresRepoContext: true, evidenceQueries: [],
    }], [], false, true);
    expect(result.summary.confirmed).toBe(0);
    expect(result.findings[0].verification?.status).toBe('unresolved');
  });
  it('requires an explicit criticality decision for every unresolved root candidate', () => {
    const state = createReviewWorkflow('scope', 'repo');
    const files = [{ path, findings: [finding] }];
    expect(() => parseBusinessReview(empty, state, files, visible, [], [], true)).toThrow('unclassified premise');
    const concern = {
      id: 'Q1', kind: 'question', status: 'open', title: 'External value contract',
      detail: 'No dependency on the missing contract was established.', impact: 'Does not affect the current bounded conclusion.',
      critical: false, requirementIds: [], evidence: [], findingRef: `file:${path}#${findingContentSignature(finding)}`,
    };
    const parsed = parseBusinessReview({ ...empty, concerns: [concern] }, state, files, visible, [], [], true);
    expect(parsed.concerns[0].critical).toBe(false);
  });

  it('does not silently drop, duplicate or confirm a global candidate without source evidence', () => {
    expect(() => parseGlobalCandidateResults([], [candidate], visible)).toThrow();
    const result = { candidateId: candidate.id, status: 'confirmed', rationale: 'Claimed.', evidence: [] };
    expect(() => parseGlobalCandidateResults([result], [candidate], visible)).toThrow('invalidReference');
    const dismissed = parseGlobalCandidateResults([{ ...result, status: 'dismissed', evidence: [proof] }], [candidate], visible);
    expect(dismissed[0].verification?.status).toBe('overturned');
  });

  it('does not interpret an omitted previously confirmed issue as a repaired implementation', () => {
    const state = createReviewWorkflow('scope', 'repo');
    beginWorkflowRun(state, false, 'unit');
    state.run.priorFindings = [{ id: 'previous-confirmed', path, finding }];
    recordWorkflowFile(state, state.run.id, path, { [path]: 'source' });
    finishWorkflowRun(state, state.run.id, [path], empty);
    expect(state.run.status).toBe('partial');
    expect(state.run.unreviewedFindings).toEqual(['previous-confirmed']);
    expect(() => parseBusinessReview(empty, state, [], visible, [], [], true)).toThrow();
    const current = parseBusinessReview({
      ...empty, priorFindings: [{ id: 'previous-confirmed', status: 'dismissed', rationale: 'Current implementation returns the supplied value.', evidence: [proof] }],
    }, state, [], visible, [], [], true);
    expect(current.priorFindings?.[0].status).toBe('dismissed');
  });

  it('keeps critical concerns critical until decisive current evidence resolves them', () => {
    const state = createReviewWorkflow('scope', 'repo');
    const concern = {
      id: 'Q1', kind: 'question' as const, status: 'open' as const, title: 'Necessary premise',
      detail: 'Missing contract.', impact: 'The current outcome depends on it.', critical: true,
      requirementIds: [], evidence: [{ kind: 'root' as const, file: path, line: 1 }],
    };
    state.run.business = { ...empty, concerns: [concern] };
    beginWorkflowRun(state, false, 'unit');
    recordWorkflowFile(state, state.run.id, path, { [path]: 'source' });
    finishWorkflowRun(state, state.run.id, [path], { ...empty, concerns: [{ ...concern, critical: false }] });
    expect(state.run.business?.concerns[0].critical).toBe(true);
    beginWorkflowRun(state, false, 'unit');
    recordWorkflowFile(state, state.run.id, path, { [path]: 'source' });
    expect(() => finishWorkflowRun(state, state.run.id, [path], {
      ...empty, concerns: [{ ...concern, critical: false, status: 'resolved', evidence: [] }],
    })).toThrow('invalidBusinessReview');
  });

  it('retains unresolved and disproved root judgments without making them defects', () => {
    const context: RepositoryAnalysisContext = {
      rootPath: path, files: [path], lineCounts: { [path]: 1 }, fileHashes: { [path]: 'source' },
      snippets: [], truncated: false, limitReasons: [], providerCalls: 0, totalCharacters: source.length,
    };
    const result = finalizeRootedRepositoryAnalysis(context, [{
      ...finding, candidateId: 'c0', file: path, evidenceIds: [],
    }], [{ candidateId: 'c0', status: 'dismissed', rationale: 'The source directly returns the input.', evidence: [{ kind: 'root', file: path, line: 1 }] }], true);
    expect(result.summary.confirmed).toBe(0);
    expect(result.summary.dismissed).toBe(1);
    expect(result.findingsByFile[path][0].verification?.status).toBe('overturned');
  });

  it('performs a real second model call and accepts counter-evidence rather than the discovery opinion', async () => {
    const proposal = {
      conclusion: 'Provisional hypothesis', recommendation: 'request_changes', evidence: [], verdicts: [],
      fixSpots: [candidate], business: empty,
    };
    const final = {
      conclusion: 'The source disproves the hypothesis.', recommendation: 'comment', evidence: [], verdicts: [],
      results: [{ candidateId: candidate.id, status: 'dismissed', rationale: 'The function returns the input unchanged.', evidence: [proof] }],
      business: empty,
    };
    const responses = [proposal, final];
    const sendRequest = vi.fn(async () => ({
      text: (async function* () { yield JSON.stringify(responses.shift()); })(),
    }));
    const model = { id: 'unit', maxInputTokens: 200000, countTokens: async () => 1, sendRequest } as unknown as vscode.LanguageModelChat;
    const result = await analyzeGlobal(model, [{ path, content: source, findings: [] }], {
      isCancellationRequested: false,
    } as vscode.CancellationToken, createReviewWorkflow('scope', 'repo'));
    expect(sendRequest).toHaveBeenCalledTimes(2);
    expect(result.fixSpots[0].verification?.status).toBe('overturned');
    expect(result.conclusion).toBe(final.conclusion);
  });
});
