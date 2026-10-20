import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  CandidateEvidenceBundle,
  EvidenceQuery,
  FileFindingCandidate,
  FindingEvidenceKind,
  RepositoryAnalysisContext,
  RepositoryContextLimitReason,
  RepositoryEvidenceSnippet,
} from '../ai/types';
import { scanReviewablePaths } from '../scope/scopePicker';

export const REPOSITORY_EVIDENCE_LIMITS = {
  candidates: 8,
  queriesPerCandidate: 4,
  snippetsPerCandidate: 6,
  snippetsPerQuery: 3,
  snippetChars: 2_000,
  totalChars: 24_000,
  fallbackFiles: 400,
  fallbackScanChars: 4_000_000,
  timeoutMs: 3_000,
} as const;

export const RELATED_CONTEXT_LIMITS = {
  depth: 2,
  files: 24,
  rootChars: 48_000,
  relatedFileChars: 12_000,
  totalChars: 120_000,
  providerCalls: 80,
  symbolsPerRoot: 36,
  symbolsPerRelatedFile: 16,
  enrichmentFiles: 200,
  scanChars: 4_000_000,
  timeoutMs: 6_000,
} as const;

interface EvidenceLocation {
  uri: vscode.Uri;
  startLine: number;
  endLine: number;
}

export interface RepositoryEvidenceServices {
  definitions(uri: vscode.Uri, position: vscode.Position): Promise<EvidenceLocation[]>;
  references(uri: vscode.Uri, position: vscode.Position): Promise<EvidenceLocation[]>;
  readText(uri: vscode.Uri): Promise<string>;
  listReviewablePaths(cwd: string): Promise<string[]>;
  uriForPath(cwd: string, relativePath: string): vscode.Uri;
  now(): number;
}

export interface RepositoryEvidenceRequest {
  cwd: string;
  sourcePath: string;
  sourceDocument: vscode.TextDocument;
  candidates: FileFindingCandidate[];
  /** Review-set files are searched before the wider repository fallback. */
  preferredPaths?: readonly string[];
  token: vscode.CancellationToken;
}

export interface RelatedRepositoryContextRequest {
  cwd: string;
  sourcePath: string;
  sourceDocument: vscode.TextDocument;
  preferredPaths?: readonly string[];
  token: vscode.CancellationToken;
}

function providerLocations(
  values: readonly (vscode.Location | vscode.LocationLink)[] | undefined,
): EvidenceLocation[] {
  return (values ?? []).map((value) => {
    if ('targetUri' in value) {
      const range = value.targetSelectionRange ?? value.targetRange;
      return {
        uri: value.targetUri,
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
      };
    }
    return {
      uri: value.uri,
      startLine: value.range.start.line + 1,
      endLine: value.range.end.line + 1,
    };
  });
}

const defaultServices: RepositoryEvidenceServices = {
  definitions: async (uri, position) => providerLocations(
    await vscode.commands.executeCommand<readonly (vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeDefinitionProvider',
      uri,
      position,
    ),
  ),
  references: async (uri, position) => providerLocations(
    await vscode.commands.executeCommand<readonly (vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeReferenceProvider',
      uri,
      position,
    ),
  ),
  readText: async (uri) => (await vscode.workspace.openTextDocument(uri)).getText(),
  listReviewablePaths: async (cwd) => scanReviewablePaths([vscode.Uri.file(cwd)], cwd),
  uriForPath: (cwd, relativePath) =>
    vscode.Uri.joinPath(vscode.Uri.file(cwd), ...relativePath.split('/')),
  now: () => Date.now(),
};

function simpleSymbol(symbol: string): string {
  const parts = symbol.trim().replace(/\(\s*\)$/, '').split(/[.:#/\\]/);
  return parts.at(-1)?.trim() ?? '';
}

function isIdentifierChar(value: string | undefined): boolean {
  return !!value && /[A-Za-z0-9_$]/.test(value);
}

export function findSymbolOffsets(text: string, symbol: string, limit = 2): number[] {
  const needle = simpleSymbol(symbol);
  if (!needle) {
    return [];
  }
  const offsets: number[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    if (!isIdentifierChar(text[at - 1]) && !isIdentifierChar(text[at + needle.length])) {
      offsets.push(at);
      if (offsets.length >= limit) {
        break;
      }
    }
  }
  return offsets;
}

function lineAtOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
    }
  }
  return line;
}

export function excerptAroundLine(
  text: string,
  line: number,
  endLine = line,
  contextLines = 4,
): { line: number; endLine: number; content: string } {
  const lines = text.split(/\r?\n/);
  const startIndex = Math.max(0, line - 1 - contextLines);
  const endIndex = Math.min(lines.length, Math.max(line, endLine) + contextLines);
  return {
    line: startIndex + 1,
    endLine: Math.max(startIndex + 1, endIndex),
    content: lines
      .slice(startIndex, endIndex)
      .map((value, index) => `${startIndex + index + 1}\t${value}`)
      .join('\n'),
  };
}

function relativePath(cwd: string, uri: vscode.Uri): string | undefined {
  if (uri.scheme !== 'file') {
    return undefined;
  }
  const relative = path.relative(cwd, uri.fsPath).split(path.sep).join('/');
  return !relative || relative === '..' || relative.startsWith('../')
    ? undefined
    : relative;
}

function isTestPath(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?|specs?)(\/|$)|[._-](test|spec)\.[^/]+$/i.test(filePath);
}

function isConfigurationPath(filePath: string): boolean {
  return /(^|\/)(config|configuration|settings|schema|defaults?)([._/-]|$)/i.test(filePath)
    || /\.(json|jsonc|ya?ml|toml|ini)$/i.test(filePath);
}

const PROVIDER_SKIP_DIRS = new Set([
  'node_modules', 'bower_components', 'vendor', 'Pods',
  'dist', 'out', 'build', 'target', 'bin', 'obj',
  '__pycache__', 'venv', 'env', 'coverage', '.nyc_output',
]);

function isSafeProviderPath(filePath: string): boolean {
  return filePath
    .split('/')
    .every((segment) => !segment.startsWith('.') && !PROVIDER_SKIP_DIRS.has(segment));
}

function rankPaths(
  paths: readonly string[],
  sourcePath: string,
  query: EvidenceQuery,
  preferred: ReadonlySet<string>,
): string[] {
  const sourceDir = path.posix.dirname(sourcePath);
  const sourceExt = path.posix.extname(sourcePath);
  const needle = simpleSymbol(query.symbol).toLowerCase();
  return [...paths]
    .filter((filePath) => filePath !== sourcePath)
    .map((filePath) => {
      const lower = filePath.toLowerCase();
      let score = 0;
      if (preferred.has(filePath)) score += 120;
      if (path.posix.dirname(filePath) === sourceDir) score += 90;
      if (needle && lower.includes(needle)) score += 70;
      if (isTestPath(filePath)) score += query.kind === 'tests' ? 100 : 35;
      if (/config|settings|schema|defaults?/i.test(filePath)) {
        score += query.kind === 'configuration' ? 90 : 20;
      }
      if (sourceExt && path.posix.extname(filePath) === sourceExt) score += 15;
      return { filePath, score };
    })
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .map((entry) => entry.filePath);
}

function queryPosition(
  document: vscode.TextDocument,
  candidate: FileFindingCandidate,
  query: EvidenceQuery,
): vscode.Position | undefined {
  const needle = simpleSymbol(query.symbol);
  const lineIndex = Math.min(
    Math.max(0, candidate.line - 1),
    Math.max(0, document.lineCount - 1),
  );
  const line = document.lineAt(lineIndex);
  const onLine = needle ? line.text.indexOf(needle) : -1;
  if (onLine >= 0) {
    return new vscode.Position(lineIndex, onLine);
  }
  const text = document.getText();
  if (candidate.anchor) {
    const anchorAt = text.indexOf(candidate.anchor);
    if (anchorAt >= 0 && text.indexOf(candidate.anchor, anchorAt + candidate.anchor.length) < 0) {
      const inAnchor = candidate.anchor.indexOf(needle);
      if (inAnchor >= 0) {
        return document.positionAt(anchorAt + inAnchor);
      }
    }
  }

  const lines = text.split(/\r?\n/);
  const startLine = Math.max(0, lineIndex - 8);
  const stopLine = Math.min(lines.length, Math.max(lineIndex + 9, candidate.endLine ?? 0));
  const windowText = lines.slice(startLine, stopLine).join('\n');
  const matches = findSymbolOffsets(windowText, needle, 3);
  if (matches.length !== 1) {
    return undefined;
  }
  let windowOffset = 0;
  for (let index = 0; index < startLine; index++) {
    windowOffset += lines[index].length + 1;
  }
  return document.positionAt(windowOffset + matches[0]);
}

interface EvidenceBudget {
  usedChars: number;
  deadline: number;
}

async function beforeDeadline<T>(
  operation: Promise<T>,
  budget: EvidenceBudget,
  services: RepositoryEvidenceServices,
): Promise<T> {
  const remaining = budget.deadline - services.now();
  if (remaining <= 0) {
    throw new Error('repository evidence deadline exceeded');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('repository evidence deadline exceeded')),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function addSnippet(
  snippets: RepositoryEvidenceSnippet[],
  seen: Set<string>,
  budget: EvidenceBudget,
  data: Omit<RepositoryEvidenceSnippet, 'id' | 'content'> & {
    candidateId: string;
    content: string;
  },
): boolean {
  if (
    snippets.length >= REPOSITORY_EVIDENCE_LIMITS.snippetsPerCandidate
    || budget.usedChars >= REPOSITORY_EVIDENCE_LIMITS.totalChars
  ) {
    return false;
  }
  const key = `${data.file}\0${data.line}\0${data.endLine ?? data.line}`;
  if (seen.has(key)) {
    return true;
  }
  const remaining = REPOSITORY_EVIDENCE_LIMITS.totalChars - budget.usedChars;
  const content = data.content.slice(
    0,
    Math.min(REPOSITORY_EVIDENCE_LIMITS.snippetChars, remaining),
  );
  if (!content) {
    return false;
  }
  seen.add(key);
  const { candidateId, ...snippet } = data;
  snippets.push({
    ...snippet,
    id: `${candidateId}-e${snippets.length}`,
    content,
  });
  budget.usedChars += content.length;
  return true;
}

async function collectProviderEvidence(
  kind: 'definition' | 'reference',
  candidateId: string,
  locations: EvidenceLocation[],
  request: RepositoryEvidenceRequest,
  query: EvidenceQuery,
  snippets: RepositoryEvidenceSnippet[],
  seen: Set<string>,
  budget: EvidenceBudget,
  queryLimit: number,
  services: RepositoryEvidenceServices,
): Promise<void> {
  for (const location of locations) {
    if (
      request.token.isCancellationRequested
      || services.now() >= budget.deadline
      || snippets.length >= queryLimit
    ) {
      return;
    }
    const file = relativePath(request.cwd, location.uri);
    if (!file) {
      continue;
    }
    try {
      const text = await beforeDeadline(services.readText(location.uri), budget, services);
      const excerpt = excerptAroundLine(text, location.startLine, location.endLine);
      if (!addSnippet(snippets, seen, budget, {
        candidateId,
        kind,
        file,
        line: location.startLine,
        endLine: location.endLine,
        symbol: query.symbol,
        question: query.question,
        content: excerpt.content,
      })) {
        return;
      }
    } catch (err) {
      console.warn(`[codereview] unable to read ${kind} evidence:`, err);
    }
  }
}

async function collectFallbackEvidence(
  paths: readonly string[],
  request: RepositoryEvidenceRequest,
  candidate: FileFindingCandidate,
  query: EvidenceQuery,
  snippets: RepositoryEvidenceSnippet[],
  seen: Set<string>,
  budget: EvidenceBudget,
  queryLimit: number,
  services: RepositoryEvidenceServices,
): Promise<void> {
  const preferred = new Set(request.preferredPaths ?? []);
  const ranked = rankPaths(paths, request.sourcePath, query, preferred)
    .slice(0, REPOSITORY_EVIDENCE_LIMITS.fallbackFiles);
  let scannedChars = 0;
  for (const file of ranked) {
    if (
      request.token.isCancellationRequested
      || services.now() >= budget.deadline
      || snippets.length >= queryLimit
      || scannedChars >= REPOSITORY_EVIDENCE_LIMITS.fallbackScanChars
    ) {
      return;
    }
    try {
      const text = await beforeDeadline(
        services.readText(services.uriForPath(request.cwd, file)),
        budget,
        services,
      );
      scannedChars += text.length;
      for (const offset of findSymbolOffsets(text, query.symbol)) {
        const hitLine = lineAtOffset(text, offset);
        const excerpt = excerptAroundLine(text, hitLine);
        if (!addSnippet(snippets, seen, budget, {
          candidateId: candidate.candidateId,
          kind: isTestPath(file) ? 'test' : 'search',
          file,
          line: hitLine,
          endLine: hitLine,
          symbol: query.symbol,
          question: query.question,
          content: excerpt.content,
        })) {
          return;
        }
      }
    } catch (err) {
      console.warn('[codereview] unable to read fallback evidence:', file, err);
    }
  }
}

/**
 * Collects bounded repository excerpts for context-dependent candidates.
 * Definition/reference providers are preferred; exact tracked-file search is
 * the deterministic fallback when language services are absent or incomplete.
 */
export async function collectRepositoryEvidence(
  request: RepositoryEvidenceRequest,
  services: RepositoryEvidenceServices = defaultServices,
): Promise<CandidateEvidenceBundle[]> {
  const candidates = request.candidates
    .filter((candidate) => candidate.requiresRepoContext)
    .slice(0, REPOSITORY_EVIDENCE_LIMITS.candidates);
  if (candidates.length === 0) {
    return [];
  }
  const budget: EvidenceBudget = {
    usedChars: 0,
    deadline: services.now() + REPOSITORY_EVIDENCE_LIMITS.timeoutMs,
  };
  let reviewablePaths: string[] | undefined;
  const bundles: CandidateEvidenceBundle[] = [];
  for (const candidate of candidates) {
    if (request.token.isCancellationRequested || services.now() >= budget.deadline) {
      break;
    }
    const snippets: RepositoryEvidenceSnippet[] = [];
    const seen = new Set<string>();
    for (const query of candidate.evidenceQueries.slice(
      0,
      REPOSITORY_EVIDENCE_LIMITS.queriesPerCandidate,
    )) {
      if (
        request.token.isCancellationRequested
        || services.now() >= budget.deadline
        || snippets.length >= REPOSITORY_EVIDENCE_LIMITS.snippetsPerCandidate
      ) {
        break;
      }
      const position = queryPosition(request.sourceDocument, candidate, query);
      const queryLimit = Math.min(
        REPOSITORY_EVIDENCE_LIMITS.snippetsPerCandidate,
        snippets.length + REPOSITORY_EVIDENCE_LIMITS.snippetsPerQuery,
      );
      if (position) {
        try {
          const definitions = await beforeDeadline(
            services.definitions(request.sourceDocument.uri, position),
            budget,
            services,
          );
          await collectProviderEvidence(
            'definition',
            candidate.candidateId,
            definitions,
            request,
            query,
            snippets,
            seen,
            budget,
            queryLimit,
            services,
          );
        } catch (err) {
          console.warn('[codereview] definition provider failed:', err);
        }
        if (query.kind === 'references' || query.kind === 'contract') {
          try {
            const references = await beforeDeadline(
              services.references(request.sourceDocument.uri, position),
              budget,
              services,
            );
            await collectProviderEvidence(
              'reference',
              candidate.candidateId,
              references,
              request,
              query,
              snippets,
              seen,
              budget,
              queryLimit,
              services,
            );
          } catch (err) {
            console.warn('[codereview] reference provider failed:', err);
          }
        }
      }
      if (
        snippets.length < REPOSITORY_EVIDENCE_LIMITS.snippetsPerCandidate
        && services.now() < budget.deadline
      ) {
        try {
          reviewablePaths ??= await beforeDeadline(
            services.listReviewablePaths(request.cwd),
            budget,
            services,
          );
          await collectFallbackEvidence(
            reviewablePaths,
            request,
            candidate,
            query,
            snippets,
            seen,
            budget,
            queryLimit,
            services,
          );
        } catch (err) {
          console.warn('[codereview] repository evidence fallback failed:', err);
        }
      }
    }
    bundles.push({ candidateId: candidate.candidateId, snippets });
  }
  return bundles;
}

const CODE_KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'def', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'for', 'from', 'function', 'if', 'implements',
  'import', 'in', 'instanceof', 'interface', 'let', 'new', 'none', 'null',
  'package', 'private', 'protected', 'public', 'raise', 'return', 'static',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined',
  'var', 'void', 'while', 'with', 'yield',
]);

interface RelationshipSymbol {
  symbol: string;
  position: vscode.Position;
  score: number;
}

/** Language-agnostic high-value symbol uses for definition/reference expansion. */
export function extractRelationshipSymbols(
  text: string,
  limit: number,
): RelationshipSymbol[] {
  const lines = text.split(/\r?\n/);
  const best = new Map<string, RelationshipSymbol>();
  for (let line = 0; line < lines.length; line++) {
    const value = lines[line];
    const importLike = /^\s*(?:import|from|require|using|#include)\b/.test(value);
    const expression = /[A-Za-z_$][A-Za-z0-9_$]*/g;
    for (let match = expression.exec(value); match; match = expression.exec(value)) {
      const symbol = match[0];
      if (symbol.length < 3 || CODE_KEYWORDS.has(symbol.toLowerCase())) {
        continue;
      }
      const at = match.index;
      const before = value.slice(Math.max(0, at - 2), at);
      const after = value.slice(at + symbol.length);
      let score = 0;
      if (importLike) score += 8;
      if (before.endsWith('.')) score += 6;
      if (/^\s*\(/.test(after)) score += 5;
      if (/^[A-Z]/.test(symbol)) score += 3;
      if (before.endsWith('@')) score += 2;
      const current = best.get(symbol);
      if (!current || score > current.score) {
        best.set(symbol, {
          symbol,
          position: new vscode.Position(line, at),
          score,
        });
      }
    }
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.position.line - b.position.line)
    .slice(0, limit);
}

interface RelatedFileNode {
  path: string;
  uri: vscode.Uri;
  text?: string;
  depth: number;
  relationKind: FindingEvidenceKind;
  relationSymbol: string;
  lines: Set<number>;
}

function numberedText(text: string, startLine = 1): string {
  return text
    .split(/\r?\n/)
    .map((line, index) => `${startLine + index}\t${line}`)
    .join('\n');
}

function contentFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function sampleRootText(text: string, charLimit: number): string {
  const lines = text.split(/\r?\n/);
  const segments = 4;
  const segmentBudget = Math.max(1, Math.floor(charLimit / segments));
  const chunks: string[] = [];
  for (let segment = 0; segment < segments; segment++) {
    const start = Math.floor(
      (Math.max(0, lines.length - 1) * segment) / Math.max(1, segments - 1),
    );
    const chunk: string[] = [];
    let used = 0;
    for (let index = start; index < lines.length; index++) {
      const numbered = `${index + 1}\t${lines[index]}`;
      if (chunk.length > 0 && used + numbered.length + 1 > segmentBudget) {
        break;
      }
      chunk.push(numbered);
      used += numbered.length + 1;
    }
    if (chunk.length > 0) {
      chunks.push(chunk.join('\n'));
    }
  }
  return chunks.join('\n...\n').slice(0, charLimit);
}

function addLimitReason(
  reasons: Set<RepositoryContextLimitReason>,
  reason: RepositoryContextLimitReason,
): void {
  reasons.add(reason);
}

function contextSnippet(
  node: RelatedFileNode,
  rootPath: string,
  limitReasons: Set<RepositoryContextLimitReason>,
): Omit<RepositoryEvidenceSnippet, 'id'> {
  const text = node.text ?? '';
  const lineCount = text.split(/\r?\n/).length;
  const charLimit = node.path === rootPath
    ? RELATED_CONTEXT_LIMITS.rootChars
    : RELATED_CONTEXT_LIMITS.relatedFileChars;
  if (text.length <= charLimit) {
    return {
      kind: node.path === rootPath
        ? 'root'
        : isTestPath(node.path)
          ? 'test'
          : isConfigurationPath(node.path)
            ? 'configuration'
            : node.relationKind,
      file: node.path,
      line: 1,
      endLine: lineCount,
      symbol: node.relationSymbol,
      question: node.path === rootPath
        ? 'Analyze behavior rooted at this file.'
        : `Related at graph depth ${node.depth}.`,
      content: numberedText(text),
    };
  }

  addLimitReason(limitReasons, 'characters');
  if (node.path === rootPath) {
    return {
      kind: 'root',
      file: node.path,
      line: 1,
      endLine: lineCount,
      symbol: node.relationSymbol,
      question: 'Analyze behavior rooted at this file.',
      content: sampleRootText(text, charLimit),
    };
  }
  const excerpts = [...node.lines]
    .sort((a, b) => a - b)
    .slice(0, 6)
    .map((line) => excerptAroundLine(text, line, line, 12));
  const content = excerpts.length > 0
    ? excerpts.map((excerpt) => excerpt.content).join('\n...\n').slice(0, charLimit)
    : numberedText(text).slice(0, charLimit);
  const firstLine = excerpts[0]?.line ?? 1;
  const lastLine = excerpts.at(-1)?.endLine ?? Math.min(lineCount, 1);
  return {
    kind: node.path === rootPath
      ? 'root'
      : isTestPath(node.path)
        ? 'test'
        : isConfigurationPath(node.path)
          ? 'configuration'
          : node.relationKind,
    file: node.path,
    line: firstLine,
    endLine: lastLine,
    symbol: node.relationSymbol,
    question: node.path === rootPath
      ? 'Analyze behavior rooted at this file.'
      : `Related at graph depth ${node.depth}.`,
    content,
  };
}

/**
 * Builds a bounded transitive repository context rooted at one file. It follows
 * definitions recursively, follows references for symbols defined in each
 * visited file, and enriches the graph with tests/configuration mentioning the
 * high-value root symbols.
 */
export async function collectRelatedRepositoryContext(
  request: RelatedRepositoryContextRequest,
  services: RepositoryEvidenceServices = defaultServices,
): Promise<RepositoryAnalysisContext> {
  const reasons = new Set<RepositoryContextLimitReason>();
  const budget: EvidenceBudget = {
    usedChars: 0,
    deadline: services.now() + RELATED_CONTEXT_LIMITS.timeoutMs,
  };
  let reviewablePaths: string[] = [];
  let hasReviewableAllowlist = false;
  try {
    reviewablePaths = await beforeDeadline(
      services.listReviewablePaths(request.cwd),
      budget,
      services,
    );
    hasReviewableAllowlist = true;
  } catch {
    addLimitReason(reasons, 'scan-unavailable');
  }
  const reviewable = new Set(reviewablePaths);
  reviewable.add(request.sourcePath);
  const nodes = new Map<string, RelatedFileNode>();
  const queue: RelatedFileNode[] = [];
  const root: RelatedFileNode = {
    path: request.sourcePath,
    uri: request.sourceDocument.uri,
    text: request.sourceDocument.getText(),
    depth: 0,
    relationKind: 'root',
    relationSymbol: request.sourcePath,
    lines: new Set([1]),
  };
  nodes.set(root.path, root);
  queue.push(root);
  let providerCalls = 0;

  const addRelated = (
    location: EvidenceLocation,
    parentDepth: number,
    kind: 'definition' | 'reference',
    symbol: string,
  ) => {
    const file = relativePath(request.cwd, location.uri);
    if (
      !file
      || (hasReviewableAllowlist
        ? !reviewable.has(file)
        : !isSafeProviderPath(file))
    ) {
      return;
    }
    const nextDepth = parentDepth + 1;
    if (nextDepth > RELATED_CONTEXT_LIMITS.depth) {
      addLimitReason(reasons, 'depth');
      return;
    }
    const existing = nodes.get(file);
    if (existing) {
      existing.lines.add(location.startLine);
      return;
    }
    if (nodes.size >= RELATED_CONTEXT_LIMITS.files) {
      addLimitReason(reasons, 'files');
      return;
    }
    const node: RelatedFileNode = {
      path: file,
      uri: location.uri,
      depth: nextDepth,
      relationKind: kind,
      relationSymbol: symbol,
      lines: new Set([location.startLine]),
    };
    nodes.set(file, node);
    queue.push(node);
  };

  while (queue.length > 0) {
    if (request.token.isCancellationRequested) {
      break;
    }
    if (services.now() >= budget.deadline) {
      addLimitReason(reasons, 'timeout');
      break;
    }
    const node = queue.shift()!;
    if (node.depth >= RELATED_CONTEXT_LIMITS.depth) {
      continue;
    }
    try {
      node.text ??= await beforeDeadline(services.readText(node.uri), budget, services);
    } catch {
      addLimitReason(reasons, 'timeout');
      continue;
    }
    const symbols = extractRelationshipSymbols(
      node.text,
      node.depth === 0
        ? RELATED_CONTEXT_LIMITS.symbolsPerRoot
        : RELATED_CONTEXT_LIMITS.symbolsPerRelatedFile,
    );
    for (const symbol of symbols) {
      if (request.token.isCancellationRequested) {
        break;
      }
      if (providerCalls >= RELATED_CONTEXT_LIMITS.providerCalls) {
        addLimitReason(reasons, 'provider-calls');
        break;
      }
      providerCalls++;
      let definitions: EvidenceLocation[] = [];
      try {
        definitions = await beforeDeadline(
          services.definitions(node.uri, symbol.position),
          budget,
          services,
        );
      } catch {
        if (services.now() >= budget.deadline) {
          addLimitReason(reasons, 'timeout');
          break;
        }
      }
      for (const definition of definitions) {
        addRelated(definition, node.depth, 'definition', symbol.symbol);
      }
      const definedHere = definitions.some(
        (definition) => definition.uri.fsPath === node.uri.fsPath,
      );
      if (!definedHere || providerCalls >= RELATED_CONTEXT_LIMITS.providerCalls) {
        continue;
      }
      providerCalls++;
      try {
        const references = await beforeDeadline(
          services.references(node.uri, symbol.position),
          budget,
          services,
        );
        for (const reference of references) {
          addRelated(reference, node.depth, 'reference', symbol.symbol);
        }
      } catch {
        if (services.now() >= budget.deadline) {
          addLimitReason(reasons, 'timeout');
          break;
        }
      }
    }
  }

  const rootSymbols = extractRelationshipSymbols(
    root.text ?? '',
    RELATED_CONTEXT_LIMITS.symbolsPerRoot,
  ).map((item) => item.symbol);
  const preferred = new Set(request.preferredPaths ?? []);
  const enrichment = reviewablePaths
    .filter((file) =>
      !nodes.has(file)
      && (isTestPath(file) || isConfigurationPath(file)),
    )
    .sort((a, b) =>
      Number(preferred.has(b)) - Number(preferred.has(a))
      || a.localeCompare(b),
    )
    .slice(0, RELATED_CONTEXT_LIMITS.enrichmentFiles);
  let scannedChars = 0;
  for (const file of enrichment) {
    if (
      request.token.isCancellationRequested
      || nodes.size >= RELATED_CONTEXT_LIMITS.files
      || services.now() >= budget.deadline
    ) {
      if (nodes.size >= RELATED_CONTEXT_LIMITS.files) addLimitReason(reasons, 'files');
      if (services.now() >= budget.deadline) addLimitReason(reasons, 'timeout');
      break;
    }
    if (scannedChars >= RELATED_CONTEXT_LIMITS.scanChars) {
      addLimitReason(reasons, 'scan-characters');
      break;
    }
    const uri = services.uriForPath(request.cwd, file);
    let text: string;
    try {
      text = await beforeDeadline(services.readText(uri), budget, services);
    } catch {
      addLimitReason(reasons, 'timeout');
      break;
    }
    scannedChars += text.length;
    const matched = rootSymbols.find((symbol) => findSymbolOffsets(text, symbol, 1).length > 0);
    if (!matched) {
      continue;
    }
    const offset = findSymbolOffsets(text, matched, 1)[0] ?? 0;
    nodes.set(file, {
      path: file,
      uri,
      text,
      depth: 1,
      relationKind: isTestPath(file) ? 'test' : 'configuration',
      relationSymbol: matched,
      lines: new Set([lineAtOffset(text, offset)]),
    });
  }

  const snippets: RepositoryEvidenceSnippet[] = [];
  const files: string[] = [];
  const lineCounts: Record<string, number> = {};
  const fileHashes: Record<string, string> = {};
  let totalCharacters = 0;
  for (const node of nodes.values()) {
    if (request.token.isCancellationRequested) {
      break;
    }
    try {
      node.text ??= await beforeDeadline(services.readText(node.uri), budget, services);
    } catch {
      addLimitReason(reasons, 'timeout');
      break;
    }
    const snippet = contextSnippet(node, request.sourcePath, reasons);
    const remaining = RELATED_CONTEXT_LIMITS.totalChars - totalCharacters;
    if (remaining <= 0) {
      addLimitReason(reasons, 'characters');
      break;
    }
    if (snippet.content.length > remaining) {
      snippet.content = snippet.content.slice(0, remaining);
      addLimitReason(reasons, 'characters');
    }
    snippets.push({ ...snippet, id: `ctx-${snippets.length}` });
    files.push(node.path);
    lineCounts[node.path] = node.text.split(/\r?\n/).length;
    fileHashes[node.path] = contentFingerprint(node.text);
    totalCharacters += snippet.content.length;
  }

  return {
    rootPath: request.sourcePath,
    files,
    lineCounts,
    fileHashes,
    snippets,
    truncated: reasons.size > 0,
    limitReasons: [...reasons],
    providerCalls,
    totalCharacters,
  };
}

/** Verifies that no file used by the model changed before findings are persisted. */
export async function validateRepositoryAnalysisContext(
  context: RepositoryAnalysisContext,
  cwd: string,
  token: vscode.CancellationToken,
  services: RepositoryEvidenceServices = defaultServices,
): Promise<boolean> {
  for (const file of context.files) {
    if (token.isCancellationRequested) {
      return false;
    }
    try {
      const text = await services.readText(services.uriForPath(cwd, file));
      if (contentFingerprint(text) !== context.fileHashes[file]) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}
