import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { FileFindingCandidate } from '../ai/types';
import {
  collectRelatedRepositoryContext,
  collectRepositoryEvidence,
  extractRelationshipSymbols,
  excerptAroundLine,
  findSymbolOffsets,
  validateRepositoryAnalysisContext,
  type RepositoryEvidenceServices,
} from './repositoryEvidence';

describe('repository evidence collection', () => {
  it('collects language-service definitions and fallback test evidence', async () => {
    const texts = new Map([
      ['C:\\repo\\config.py', [
        'class Config:',
        '    def to_public_dict(self):',
        '        return {"default_analyzer": self.default_analyzer}',
      ].join('\n')],
      ['C:\\repo\\tests\\test_config.py', [
        'def test_public_dict_has_default_analyzer():',
        '    assert "default_analyzer" in Config().to_public_dict()',
      ].join('\n')],
    ]);
    const services: RepositoryEvidenceServices = {
      definitions: async () => [{
        uri: fileUri('C:\\repo\\config.py'),
        startLine: 2,
        endLine: 3,
      }],
      references: async () => [],
      readText: async (uri) => texts.get(uri.fsPath) ?? '',
      listReviewablePaths: async () => ['config.py', 'tests/test_config.py'],
      uriForPath: (cwd, relative) => fileUri(`${cwd}\\${relative.replaceAll('/', '\\')}`),
      now: () => 100,
    };

    const bundles = await collectRepositoryEvidence({
      cwd: 'C:\\repo',
      sourcePath: 'config_cmd.py',
      sourceDocument: sourceDocument(),
      candidates: [candidate()],
      preferredPaths: ['config.py'],
      token: { isCancellationRequested: false } as vscode.CancellationToken,
    }, services);

    expect(bundles).toHaveLength(1);
    expect(bundles[0].snippets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'c0-e0',
        kind: 'definition',
        file: 'config.py',
        line: 2,
      }),
      expect.objectContaining({
        kind: 'test',
        file: 'tests/test_config.py',
      }),
    ]));
    expect(bundles[0].snippets.every((snippet) => snippet.id.startsWith('c0-e'))).toBe(true);
  });

  it('returns an empty bundle when providers and fallback have no matching symbol', async () => {
    const services: RepositoryEvidenceServices = {
      definitions: async () => [],
      references: async () => [],
      readText: async () => 'unrelated content',
      listReviewablePaths: async () => ['other.py'],
      uriForPath: (cwd, relative) => fileUri(`${cwd}\\${relative}`),
      now: () => 100,
    };

    const bundles = await collectRepositoryEvidence({
      cwd: 'C:\\repo',
      sourcePath: 'config_cmd.py',
      sourceDocument: sourceDocument(),
      candidates: [candidate()],
      token: { isCancellationRequested: false } as vscode.CancellationToken,
    }, services);

    expect(bundles).toEqual([{ candidateId: 'c0', snippets: [] }]);
  });

  it('falls back to tracked-file search when language services fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const services: RepositoryEvidenceServices = {
      definitions: async () => { throw new Error('provider unavailable'); },
      references: async () => { throw new Error('provider unavailable'); },
      readText: async () => 'def to_public_dict(self):\n    return {"default_analyzer": None}',
      listReviewablePaths: async () => ['config.py'],
      uriForPath: (cwd, relative) => fileUri(`${cwd}\\${relative}`),
      now: () => 100,
    };

    try {
      const bundles = await collectRepositoryEvidence({
        cwd: 'C:\\repo',
        sourcePath: 'config_cmd.py',
        sourceDocument: sourceDocument(),
        candidates: [candidate()],
        token: { isCancellationRequested: false } as vscode.CancellationToken,
      }, services);

      expect(bundles[0].snippets[0]).toMatchObject({
        kind: 'search',
        file: 'config.py',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('does no repository work after cancellation', async () => {
    const definitions = vi.fn(async () => []);
    const services: RepositoryEvidenceServices = {
      definitions,
      references: async () => [],
      readText: async () => '',
      listReviewablePaths: async () => [],
      uriForPath: (cwd, relative) => fileUri(`${cwd}\\${relative}`),
      now: () => 100,
    };

    const bundles = await collectRepositoryEvidence({
      cwd: 'C:\\repo',
      sourcePath: 'config_cmd.py',
      sourceDocument: sourceDocument(),
      candidates: [candidate()],
      token: { isCancellationRequested: true } as vscode.CancellationToken,
    }, services);

    expect(bundles).toEqual([]);
    expect(definitions).not.toHaveBeenCalled();
  });

  it('stops before provider work once the evidence deadline is exhausted', async () => {
    const definitions = vi.fn(async () => []);
    let clock = 0;
    const services: RepositoryEvidenceServices = {
      definitions,
      references: async () => [],
      readText: async () => '',
      listReviewablePaths: async () => [],
      uriForPath: (cwd, relative) => fileUri(`${cwd}\\${relative}`),
      now: () => {
        const current = clock;
        clock = 4_000;
        return current;
      },
    };

    const bundles = await collectRepositoryEvidence({
      cwd: 'C:\\repo',
      sourcePath: 'config_cmd.py',
      sourceDocument: sourceDocument(),
      candidates: [candidate()],
      token: { isCancellationRequested: false } as vscode.CancellationToken,
    }, services);

    expect(bundles).toEqual([]);
    expect(definitions).not.toHaveBeenCalled();
  });

  it('skips language-service lookup when a symbol cannot be tied uniquely to the candidate', async () => {
    const definitions = vi.fn(async () => []);
    const references = vi.fn(async () => []);
    const services: RepositoryEvidenceServices = {
      definitions,
      references,
      readText: async () => '',
      listReviewablePaths: async () => [],
      uriForPath: (cwd, relative) => fileUri(`${cwd}\\${relative}`),
      now: () => 100,
    };
    const ambiguous = {
      ...candidate(),
      line: 2,
      anchor: 'value = public.pop("default_analyzer")',
    };

    await collectRepositoryEvidence({
      cwd: 'C:\\repo',
      sourcePath: 'config_cmd.py',
      sourceDocument: sourceDocument([
        'left = cfg.to_public_dict()',
        'value = public.pop("default_analyzer")',
        'right = other.to_public_dict()',
      ].join('\n')),
      candidates: [ambiguous],
      token: { isCancellationRequested: false } as vscode.CancellationToken,
    }, services);

    expect(definitions).not.toHaveBeenCalled();
    expect(references).not.toHaveBeenCalled();
  });

  it('finds only identifier-boundary matches and returns numbered excerpts', () => {
    expect(findSymbolOffsets('to_public_dict x_to_public_dict to_public_dict()', 'to_public_dict'))
      .toEqual([0, 32]);
    expect(excerptAroundLine('one\ntwo\nthree\nfour', 3, 3, 1)).toEqual({
      line: 2,
      endLine: 4,
      content: '2\ttwo\n3\tthree\n4\tfour',
    });
    expect(
      extractRelationshipSymbols(
        'import { Client } from "./client";\nClient.create().send()',
        3,
      ).map((item) => item.symbol),
    ).toEqual(expect.arrayContaining(['Client', 'create']));
  });

  it('builds a recursive context graph and enriches it with related tests', async () => {
    const texts = new Map([
      ['C:\\repo\\root.ts', 'export function root() { return dependency(); }'],
      ['C:\\repo\\dependency.ts', 'export function dependency() { return leaf(); }'],
      ['C:\\repo\\leaf.ts', 'export function leaf() { return 42; }'],
      ['C:\\repo\\root.test.ts', 'it("uses dependency", () => expect(dependency()).toBe(42));'],
    ]);
    const services: RepositoryEvidenceServices = {
      definitions: async (uri) => {
        if (uri.fsPath.endsWith('root.ts')) {
          return [{ uri: fileUri('C:\\repo\\dependency.ts'), startLine: 1, endLine: 1 }];
        }
        if (uri.fsPath.endsWith('dependency.ts')) {
          return [{ uri: fileUri('C:\\repo\\leaf.ts'), startLine: 1, endLine: 1 }];
        }
        return [];
      },
      references: async () => [],
      readText: async (uri) => texts.get(uri.fsPath) ?? '',
      listReviewablePaths: async () => [
        'root.ts',
        'dependency.ts',
        'leaf.ts',
        'root.test.ts',
      ],
      uriForPath: (cwd, relative) => fileUri(`${cwd}\\${relative.replaceAll('/', '\\')}`),
      now: () => 100,
    };

    const context = await collectRelatedRepositoryContext({
      cwd: 'C:\\repo',
      sourcePath: 'root.ts',
      sourceDocument: sourceDocument(
        texts.get('C:\\repo\\root.ts') ?? '',
        'C:\\repo\\root.ts',
      ),
      preferredPaths: ['root.ts'],
      token: { isCancellationRequested: false } as vscode.CancellationToken,
    }, services);

    expect(context.files).toEqual(expect.arrayContaining([
      'root.ts',
      'dependency.ts',
      'leaf.ts',
      'root.test.ts',
    ]));
    expect(context.snippets.find((item) => item.file === 'root.ts')?.kind).toBe('root');
    expect(context.snippets.find((item) => item.file === 'root.test.ts')?.kind).toBe('test');
    expect(context.truncated).toBe(false);
  });

  it('reports the file budget when graph expansion exceeds its cap', async () => {
    const dependencies = Array.from({ length: 30 }, (_, index) => ({
      uri: fileUri(`C:\\repo\\dep${index}.ts`),
      startLine: 1,
      endLine: 1,
    }));
    const services: RepositoryEvidenceServices = {
      definitions: async (uri) => uri.fsPath.endsWith('root.ts') ? dependencies : [],
      references: async () => [],
      readText: async () => 'export const dependency = 1;',
      listReviewablePaths: async () => [
        'root.ts',
        ...dependencies.map((_, index) => `dep${index}.ts`),
      ],
      uriForPath: (cwd, relative) => fileUri(`${cwd}\\${relative}`),
      now: () => 100,
    };

    const context = await collectRelatedRepositoryContext({
      cwd: 'C:\\repo',
      sourcePath: 'root.ts',
      sourceDocument: sourceDocument(
        'export function root() { return dependency(); }',
        'C:\\repo\\root.ts',
      ),
      token: { isCancellationRequested: false } as vscode.CancellationToken,
    }, services);

    expect(context.files.length).toBeLessThanOrEqual(24);
    expect(context.limitReasons).toContain('files');
    expect(context.truncated).toBe(true);
  });

  it('keeps provider-resolved repository files when the allowlist scan fails', async () => {
    const services: RepositoryEvidenceServices = {
      definitions: async (uri) => uri.fsPath.endsWith('root.ts')
        ? [{ uri: fileUri('C:\\repo\\dependency.ts'), startLine: 1, endLine: 1 }]
        : [],
      references: async () => [],
      readText: async (uri) => uri.fsPath.endsWith('dependency.ts')
        ? 'export function dependency() { return 1; }'
        : '',
      listReviewablePaths: async () => { throw new Error('scan unavailable'); },
      uriForPath: (cwd, relative) => fileUri(`${cwd}\\${relative}`),
      now: () => 100,
    };

    const context = await collectRelatedRepositoryContext({
      cwd: 'C:\\repo',
      sourcePath: 'root.ts',
      sourceDocument: sourceDocument(
        'export function root() { return dependency(); }',
        'C:\\repo\\root.ts',
      ),
      token: { isCancellationRequested: false } as vscode.CancellationToken,
    }, services);

    expect(context.files).toContain('dependency.ts');
    expect(context.limitReasons).toContain('scan-unavailable');
  });

  it('rejects a repository context when a related file changes before persistence', async () => {
    const texts = new Map([
      ['C:\\repo\\root.ts', 'export function root() { return dependency(); }'],
      ['C:\\repo\\dependency.ts', 'export function dependency() { return 1; }'],
    ]);
    const services: RepositoryEvidenceServices = {
      definitions: async (uri) => uri.fsPath.endsWith('root.ts')
        ? [{ uri: fileUri('C:\\repo\\dependency.ts'), startLine: 1, endLine: 1 }]
        : [],
      references: async () => [],
      readText: async (uri) => texts.get(uri.fsPath) ?? '',
      listReviewablePaths: async () => ['root.ts', 'dependency.ts'],
      uriForPath: (cwd, relative) => fileUri(`${cwd}\\${relative}`),
      now: () => 100,
    };
    const token = { isCancellationRequested: false } as vscode.CancellationToken;
    const context = await collectRelatedRepositoryContext({
      cwd: 'C:\\repo',
      sourcePath: 'root.ts',
      sourceDocument: sourceDocument(
        texts.get('C:\\repo\\root.ts') ?? '',
        'C:\\repo\\root.ts',
      ),
      token,
    }, services);

    expect(await validateRepositoryAnalysisContext(
      context,
      'C:\\repo',
      token,
      services,
    )).toBe(true);

    texts.set('C:\\repo\\dependency.ts', 'export function dependency() { return 2; }');
    expect(await validateRepositoryAnalysisContext(
      context,
      'C:\\repo',
      token,
      services,
    )).toBe(false);
  });
});

function candidate(): FileFindingCandidate {
  return {
    id: 'c0',
    candidateId: 'c0',
    line: 1,
    severity: 'conditional',
    title: 'Possible KeyError',
    detail: 'The return contract is external.',
    requiresRepoContext: true,
    evidenceQueries: [{
      kind: 'contract',
      symbol: 'Config.to_public_dict',
      question: 'Does the returned dictionary always contain default_analyzer?',
    }],
  };
}

function sourceDocument(
  content = 'public = cfg.to_public_dict()',
  fsPath = 'C:\\repo\\config_cmd.py',
): vscode.TextDocument {
  const lines = content.split(/\r?\n/);
  return {
    uri: fileUri(fsPath),
    lineCount: lines.length,
    getText: () => content,
    lineAt: (line: number) => ({ text: lines[line] ?? '' }),
    positionAt: (offset: number) => {
      const before = content.slice(0, offset).split(/\r?\n/);
      return {
        line: before.length - 1,
        character: before.at(-1)?.length ?? 0,
      };
    },
  } as unknown as vscode.TextDocument;
}

function fileUri(fsPath: string): vscode.Uri {
  return { scheme: 'file', fsPath } as vscode.Uri;
}
