import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { resetVscodeMock } from '../test/vscodeMock';
import {
  analyzeFile,
  analyzeGlobal,
  analyzeRootedRepository,
  fitRepositoryContextToTokenBudget,
  finalizeFileAnalysis,
  finalizeRootedRepositoryAnalysis,
  verifyFileFindings,
  verifyRootedRepositoryFindings,
} from './analyzer';
import type {
  CandidateEvidenceBundle,
  FileFindingCandidate,
  RepositoryAnalysisContext,
} from './types';
import {
  findingContentSignature,
  findingContentSignatures,
  globalFixSpotSignature,
  globalFixSpotSignatures,
} from './types';

describe('repository-aware file analysis', () => {
  afterEach(() => resetVscodeMock());

  it('marks external-contract claims for repository evidence', async () => {
    const model = modelReturning({
      findings: [{
        line: 2,
        anchor: 'value = public.pop("default_analyzer")',
        severity: 'conditional',
        title: 'Possible KeyError',
        detail: 'The key contract is defined by Config.to_public_dict.',
        requiresRepoContext: true,
        evidenceQueries: [{
          kind: 'definition',
          symbol: 'Config.to_public_dict',
          question: 'Does the returned dictionary always contain default_analyzer?',
        }],
      }],
    });
    const document = textDocument(
      'C:\\repo\\config_cmd.py',
      'public = cfg.to_public_dict()\nvalue = public.pop("default_analyzer")',
    );

    const candidates = await analyzeFile(
      model,
      document,
      { isCancellationRequested: false } as vscode.CancellationToken,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      candidateId: 'c0',
      requiresRepoContext: true,
      evidenceQueries: [{
        kind: 'definition',
        symbol: 'Config.to_public_dict',
      }],
    });
  });

  it('dismisses the KeyError candidate when cited repository evidence disproves it', async () => {
    const candidate = externalCandidate();
    const evidence: CandidateEvidenceBundle[] = [{
      candidateId: 'c0',
      snippets: [{
        id: 'c0-e0',
        kind: 'definition',
        file: 'config.py',
        line: 20,
        endLine: 28,
        symbol: 'Config.to_public_dict',
        question: 'Does the returned dictionary always contain default_analyzer?',
        content: '20\tdef to_public_dict(self):\n21\t    return {"default_analyzer": self.default_analyzer}',
      }],
    }];
    const model = modelReturning({
      results: [{
        candidateId: 'c0',
        status: 'dismissed',
        rationale: 'The method always returns the key.',
        evidenceIds: ['c0-e0'],
      }],
    });

    const results = await verifyFileFindings(
      model,
      [candidate],
      evidence,
      { isCancellationRequested: false } as vscode.CancellationToken,
    );

    expect(results).toEqual([{
      candidateId: 'c0',
      status: 'dismissed',
      rationale: 'The method always returns the key.',
      evidence: [{
        kind: 'definition',
        file: 'config.py',
        line: 20,
        endLine: 28,
      }],
    }]);
  });

  it('does not call the verifier when no repository evidence exists', async () => {
    const sendRequest = vi.fn();
    const model = {
      sendRequest,
      countTokens: async () => 0,
    } as unknown as vscode.LanguageModelChat;

    const results = await verifyFileFindings(
      model,
      [externalCandidate()],
      [{ candidateId: 'c0', snippets: [] }],
      { isCancellationRequested: false } as vscode.CancellationToken,
    );

    expect(sendRequest).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      candidateId: 'c0',
      status: 'unresolved',
      evidence: [],
    });
  });

  it('downgrades a verdict that does not cite supplied evidence', async () => {
    const model = modelReturning({
      results: [{
        candidateId: 'c0',
        status: 'confirmed',
        rationale: 'Claimed without a citation.',
        evidenceIds: [],
      }],
    });
    const evidence: CandidateEvidenceBundle[] = [{
      candidateId: 'c0',
      snippets: [{
        id: 'c0-e0',
        kind: 'definition',
        file: 'config.py',
        line: 1,
        symbol: 'Config.to_public_dict',
        question: 'contract',
        content: '1\tdef to_public_dict(self): ...',
      }],
    }];

    const results = await verifyFileFindings(
      model,
      [externalCandidate()],
      evidence,
      { isCancellationRequested: false } as vscode.CancellationToken,
    );

    expect(results[0].status).toBe('unresolved');
    expect(results[0].evidence).toEqual([]);
  });

  it('persists confirmed and unresolved findings while dropping dismissed candidates', () => {
    const local: FileFindingCandidate = {
      ...externalCandidate(),
      id: 'c-local',
      candidateId: 'c-local',
      title: 'Local bug',
      requiresRepoContext: false,
      evidenceQueries: [],
    };
    const dismissed = { ...externalCandidate(), id: 'c1', candidateId: 'c1' };
    const unresolved = { ...externalCandidate(), id: 'c2', candidateId: 'c2' };

    const result = finalizeFileAnalysis(
      [local, dismissed, unresolved],
      [
        {
          candidateId: 'c1',
          status: 'dismissed',
          rationale: 'Disproved.',
          evidence: [{ kind: 'definition', file: 'config.py', line: 1 }],
        },
        {
          candidateId: 'c2',
          status: 'unresolved',
          rationale: 'Insufficient evidence.',
          evidence: [],
        },
      ],
      true,
    );

    expect(result.summary).toEqual({
      candidates: 3,
      confirmed: 1,
      dismissed: 1,
      unresolved: 1,
    });
    expect(result.findings.map((finding) => finding.id)).toEqual(['f0', 'f1']);
    expect(result.findings[1].verification?.status).toBe('unresolved');
  });

  it('preserves stable finding references returned by global analysis', async () => {
    const finding = {
      id: 'f9',
      line: 2,
      severity: 'conditional' as const,
      title: 'Possible KeyError',
      detail: 'The return contract is external.',
    };
    const findingRef = findingContentSignature(finding);
    const report = await analyzeGlobal(
      modelReturning({
        conclusion: 'The file-level claim is false.',
        recommendation: 'approve',
        evidence: ['Config.to_public_dict always returns the key.'],
        verdicts: [{
          kind: 'flip',
          title: 'Key is guaranteed',
          before: 'pop may fail',
          after: 'the key is always present',
          file: 'config_cmd.py',
          line: 2,
          findingRef,
        }],
        fixSpots: [],
      }),
      [{ path: 'config_cmd.py', findings: [finding], content: 'value = public.pop("default_analyzer")' }],
      { isCancellationRequested: false } as vscode.CancellationToken,
    );

    expect(report.verdicts[0].findingRef).toBe(findingRef);
  });

  it('derives global fix spot ids from content instead of array order', async () => {
    const response = {
      conclusion: 'A cross-file issue exists.',
      recommendation: 'request_changes',
      evidence: [],
      verdicts: [],
      fixSpots: [{
        file: 'config.py',
        line: 12,
        severity: 'bug',
        title: 'Missing key',
        detail: 'The producer omits the required key.',
      }],
    };
    const first = await analyzeGlobal(
      modelReturning(response),
      [],
      { isCancellationRequested: false } as vscode.CancellationToken,
    );
    const second = await analyzeGlobal(
      modelReturning({ ...response, fixSpots: [{ ...response.fixSpots[0] }] }),
      [],
      { isCancellationRequested: false } as vscode.CancellationToken,
    );

    expect(first.fixSpots[0].id).toBe(second.fixSpots[0].id);
    expect(first.fixSpots[0].id).toBe(globalFixSpotSignature(first.fixSpots[0]));
  });

  it('distinguishes duplicate findings and spots by source occurrence order', () => {
    const duplicateFindings = [
      { ...externalCandidate(), id: 'a', line: 20 },
      { ...externalCandidate(), id: 'b', line: 10 },
    ];
    const findingRefs = findingContentSignatures(duplicateFindings);
    expect(new Set(findingRefs).size).toBe(2);
    const reversedFindingRefs = findingContentSignatures([...duplicateFindings].reverse());
    expect(new Map([
      [duplicateFindings[0].line, findingRefs[0]],
      [duplicateFindings[1].line, findingRefs[1]],
    ])).toEqual(new Map([
      [duplicateFindings[1].line, reversedFindingRefs[0]],
      [duplicateFindings[0].line, reversedFindingRefs[1]],
    ]));

    const duplicateSpots = [
      {
        id: '',
        file: 'config.py',
        line: 20,
        anchor: 'dangerous_call()',
        severity: 'bug' as const,
        title: 'Dangerous call',
        detail: 'Repeated call.',
      },
      {
        id: '',
        file: 'config.py',
        line: 10,
        anchor: 'dangerous_call()',
        severity: 'bug' as const,
        title: 'Dangerous call',
        detail: 'Repeated call.',
      },
    ];
    const spotRefs = globalFixSpotSignatures(duplicateSpots);
    expect(new Set(spotRefs).size).toBe(2);

    const sameLine = [
      duplicateSpots[0],
      {
        ...duplicateSpots[0],
        title: 'Different issue at the same statement',
        detail: 'A distinct contract violation.',
      },
    ];
    const sameLineRefs = globalFixSpotSignatures(sameLine);
    const reversedSameLineRefs = globalFixSpotSignatures([...sameLine].reverse());
    expect(new Set(sameLineRefs).size).toBe(2);
    expect(new Map([
      [sameLine[0].title, sameLineRefs[0]],
      [sameLine[1].title, sameLineRefs[1]],
    ])).toEqual(new Map([
      [sameLine[1].title, reversedSameLineRefs[0]],
      [sameLine[0].title, reversedSameLineRefs[1]],
    ]));
  });

  it('finds a bug in a related file and independently confirms it', async () => {
    const context = rootedContext();
    const candidates = await analyzeRootedRepository(
      modelReturning({
        findings: [{
          file: 'src/dependency.ts',
          line: 99,
          anchor: 'return value.missing;',
          severity: 'bug',
          title: 'Dereferences missing property',
          detail: 'The root calls dependency, which reads a property absent from the producer.',
          evidenceIds: ['ctx-0', 'ctx-1'],
        }],
      }),
      context,
      { isCancellationRequested: false } as vscode.CancellationToken,
    );
    expect(candidates).toMatchObject([{
      candidateId: 'c0',
      file: 'src/dependency.ts',
      line: 2,
      severity: 'bug',
    }]);

    const verifications = await verifyRootedRepositoryFindings(
      modelReturning({
        results: [{
          candidateId: 'c0',
          status: 'confirmed',
          rationale: 'The producer omits missing and the reachable dependency reads it.',
          evidenceIds: ['ctx-0', 'ctx-1'],
        }],
      }),
      context,
      candidates,
      { isCancellationRequested: false } as vscode.CancellationToken,
    );
    const result = finalizeRootedRepositoryAnalysis(
      context,
      candidates,
      verifications,
    );

    expect(result.summary).toMatchObject({
      candidates: 1,
      confirmed: 1,
      dismissed: 0,
      unresolved: 0,
      contextFiles: 2,
    });
    expect(result.findingsByFile['src/dependency.ts'][0]).toMatchObject({
      analysisRoot: 'src/root.ts',
      verification: {
        status: 'repo-confirmed',
      },
    });
  });

  it('rejects a candidate whose quoted anchor is ambiguous in its file evidence', async () => {
    const context = rootedContext();
    context.snippets[1].content = [
      '1\tfunction dependency(value) {',
      '2\treturn value.missing;',
      '3\treturn value.missing;',
      '4\t}',
    ].join('\n');
    context.lineCounts['src/dependency.ts'] = 4;

    const candidates = await analyzeRootedRepository(
      modelReturning({
        findings: [{
          file: 'src/dependency.ts',
          line: 2,
          anchor: 'return value.missing;',
          severity: 'bug',
          title: 'Missing property',
          detail: 'Ambiguous quoted location.',
          evidenceIds: ['ctx-1'],
        }],
      }),
      context,
      { isCancellationRequested: false } as vscode.CancellationToken,
    );

    expect(candidates).toEqual([]);
  });

  it('does not surface candidates that self-review cannot confirm', () => {
    const context = rootedContext();
    const candidate = {
      id: 'c0',
      candidateId: 'c0',
      file: 'src/dependency.ts',
      line: 2,
      anchor: 'return value.missing;',
      severity: 'conditional' as const,
      title: 'Possible missing property',
      detail: 'The property may be absent.',
      evidenceIds: ['ctx-1'],
    };

    const result = finalizeRootedRepositoryAnalysis(context, [candidate], [{
      candidateId: 'c0',
      status: 'unresolved',
      rationale: 'The producer contract is truncated.',
      evidence: [],
    }]);

    expect(result.findingsByFile).toEqual({});
    expect(result.summary).toMatchObject({
      confirmed: 0,
      unresolved: 1,
    });
  });

  it('rejects self-review confirmation that cites unrelated same-file evidence', async () => {
    const context = rootedContext();
    context.snippets.push({
      id: 'ctx-unrelated',
      kind: 'definition',
      file: 'src/dependency.ts',
      line: 20,
      endLine: 20,
      symbol: 'unrelated',
      question: 'Unrelated code.',
      content: '20\treturn safe;',
    });
    const candidate = {
      id: 'c0',
      candidateId: 'c0',
      file: 'src/dependency.ts',
      line: 2,
      endLine: 2,
      anchor: 'return value.missing;',
      severity: 'bug' as const,
      title: 'Missing property',
      detail: 'Reachable property access fails.',
      evidenceIds: ['ctx-1'],
    };

    const verifications = await verifyRootedRepositoryFindings(
      modelReturning({
        results: [{
          candidateId: 'c0',
          status: 'confirmed',
          rationale: 'Cited the wrong block.',
          evidenceIds: ['ctx-unrelated'],
        }],
      }),
      context,
      [candidate],
      { isCancellationRequested: false } as vscode.CancellationToken,
    );

    expect(verifications[0].status).toBe('unresolved');
  });

  it('drops candidates that cannot fit in the self-review token budget', async () => {
    const sendRequest = vi.fn();
    const model = {
      countTokens: async (text: string) => text.startsWith('{') ? text.length : 0,
      sendRequest,
    } as unknown as vscode.LanguageModelChat;
    const candidate = {
      id: 'c0',
      candidateId: 'c0',
      file: 'src/dependency.ts',
      line: 2,
      anchor: 'return value.missing;',
      severity: 'bug' as const,
      title: 'Missing property',
      detail: 'Reachable property access fails.',
      evidenceIds: ['ctx-1'],
    };

    const verifications = await verifyRootedRepositoryFindings(
      model,
      rootedContext(),
      [candidate],
      { isCancellationRequested: false } as vscode.CancellationToken,
      10,
    );

    expect(sendRequest).not.toHaveBeenCalled();
    expect(verifications[0]).toMatchObject({
      candidateId: 'c0',
      status: 'unresolved',
    });
  });

  it('trims lower-value repository evidence to the model token budget', async () => {
    const context = rootedContext();
    context.snippets.push({
      id: 'ctx-2',
      kind: 'reference',
      file: 'src/caller.ts',
      line: 1,
      symbol: 'dependency',
      question: 'Related caller.',
      content: `1\t${'x'.repeat(5_000)}`,
    }, {
      id: 'ctx-3',
      kind: 'test',
      file: 'src/root.test.ts',
      line: 1,
      symbol: 'dependency',
      question: 'Related test.',
      content: `1\t${'t'.repeat(100)}`,
    });
    context.files.push('src/caller.ts', 'src/root.test.ts');
    const model = {
      countTokens: async (text: string) => text.startsWith('{') ? text.length : 0,
    } as unknown as vscode.LanguageModelChat;

    const fitted = await fitRepositoryContextToTokenBudget(
      model,
      context,
      { isCancellationRequested: false } as vscode.CancellationToken,
      8_000,
    );

    expect(fitted.limitReasons).toContain('tokens');
    expect(fitted.snippets.some((snippet) => snippet.kind === 'root')).toBe(true);
    expect(fitted.snippets.some((snippet) => snippet.kind === 'test')).toBe(true);
    expect(fitted.snippets.some((snippet) => snippet.kind === 'reference')).toBe(false);
  });
});

function rootedContext(): RepositoryAnalysisContext {
  return {
    rootPath: 'src/root.ts',
    files: ['src/root.ts', 'src/dependency.ts'],
    lineCounts: {
      'src/root.ts': 2,
      'src/dependency.ts': 2,
    },
    fileHashes: {
      'src/root.ts': 'root-hash',
      'src/dependency.ts': 'dependency-hash',
    },
    snippets: [{
      id: 'ctx-0',
      kind: 'root',
      file: 'src/root.ts',
      line: 1,
      endLine: 2,
      symbol: 'src/root.ts',
      question: 'Analyze behavior rooted at this file.',
      content: '1\tconst value = {};\n2\tdependency(value);',
    }, {
      id: 'ctx-1',
      kind: 'definition',
      file: 'src/dependency.ts',
      line: 1,
      endLine: 2,
      symbol: 'dependency',
      question: 'Related implementation.',
      content: '1\tfunction dependency(value) {\n2\treturn value.missing;\n}',
    }],
    truncated: false,
    limitReasons: [],
    providerCalls: 1,
    totalCharacters: 100,
  };
}

function externalCandidate(): FileFindingCandidate {
  return {
    id: 'c0',
    candidateId: 'c0',
    line: 2,
    severity: 'conditional',
    title: 'Possible KeyError',
    detail: 'The key contract is external.',
    requiresRepoContext: true,
    evidenceQueries: [{
      kind: 'definition',
      symbol: 'Config.to_public_dict',
      question: 'Does the returned dictionary always contain default_analyzer?',
    }],
  };
}

function modelReturning(value: unknown): vscode.LanguageModelChat {
  return {
    sendRequest: async () => ({
      text: (async function* () {
        yield JSON.stringify(value);
      })(),
    }),
    countTokens: async () => 0,
  } as unknown as vscode.LanguageModelChat;
}

function textDocument(fsPath: string, content: string): vscode.TextDocument {
  return {
    uri: { fsPath, scheme: 'file' },
    languageId: 'python',
    lineCount: content.split(/\r?\n/).length,
    getText: () => content,
  } as unknown as vscode.TextDocument;
}
