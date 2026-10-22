import * as path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import * as vscode from 'vscode';
import { getPrByNumber } from '../gh/ghClient';
import { m } from '../i18n';
import { resolveCommit, validateRepositoryPath } from '../scope/gitClient';
import { assertPrSnapshotCurrent } from '../scope/scopes';
import type { ReviewSet } from '../scope/types';
import { businessHash, type BusinessEvidenceRequest, type BusinessReviewRun } from './businessReview';
import { CommitSource } from './commitSource';
import { collectRepositoryEvidence, createRepositoryEvidenceServices, findSymbolOffsets } from './repositoryEvidence';
import { currentMaterial, selectedMaterials, type RequirementsDraft } from './requirements';
import { readRequirementFile } from './requirementSources';

export class BusinessReviewSource {
  private readonly commit?: CommitSource;
  private readonly captured = new Map<string, Promise<string>>();

  constructor(readonly cwd: string, readonly set: ReviewSet) {
    if (set.source) this.commit = new CommitSource(cwd, set);
  }

  read = (file: string, side: 'head' | 'base'): Promise<string> => {
    validateRepositoryPath(file);
    const key = `${side}:${file}`;
    let value = this.captured.get(key);
    if (!value) {
      value = this.readFresh(file, side);
      this.captured.set(key, value);
    }
    return value;
  };

  readFresh = async (file: string, side: 'head' | 'base'): Promise<string> => {
    validateRepositoryPath(file);
    if (side === 'base' && !this.set.comparison) throw new Error(m().businessReview.readFailure);
    if (this.commit) return this.commit.read(file, side === 'base' ? this.set.comparison!.baseSha : this.set.headSha);
    if (side === 'base') throw new Error(m().businessReview.readFailure);
    const resolved = await realpath(path.join(this.cwd, file));
    const relative = path.relative(await realpath(this.cwd), resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(m().businessReview.readFailure);
    const uri = vscode.Uri.file(path.join(this.cwd, file));
    const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
    const text = open
      ? open.getText()
      : new TextDecoder('utf-8', { fatal: true }).decode(await readFile(resolved));
    if (text.includes('\0')) throw new Error(m().businessReview.readFailure);
    return text;
  };

  async resolve(request: BusinessEvidenceRequest, token: vscode.CancellationToken): Promise<string[]> {
    const text = await this.read(request.file, 'head');
    const document = await vscode.workspace.openTextDocument({ content: text });
    const uri = vscode.Uri.file(path.join(this.cwd, request.file));
    const services = this.commit?.evidenceServices() ?? createRepositoryEvidenceServices();
    services.readText = (uri) => this.read(path.relative(this.cwd, uri.fsPath).split(path.sep).join('/'), 'head');
    const offset = findSymbolOffsets(text, request.symbol, 1)[0] ?? 0;
    const result = await collectRepositoryEvidence({
      cwd: this.cwd, sourcePath: request.file,
      sourceDocument: {
        uri, getText: document.getText.bind(document), positionAt: document.positionAt.bind(document),
        lineAt: document.lineAt.bind(document), lineCount: document.lineCount,
      },
      preferredPaths: this.set.files.map((file) => file.path), token,
      candidates: [{
        id: 'business-evidence', candidateId: 'business-evidence', line: document.positionAt(offset).line + 1, severity: 'conditional',
        title: request.question, detail: request.question, requiresRepoContext: true,
        evidenceQueries: [{ kind: request.kind, symbol: request.symbol, question: request.question }],
      }],
    }, services);
    const bundle = result[0];
    if (!bundle?.snippets.length) throw new Error(m().businessReview.evidenceFailure);
    return [...new Set(bundle.snippets.map((item) => item.file))];
  }

  async assertCurrent(draft?: RequirementsDraft, run?: BusinessReviewRun): Promise<void> {
    if (this.set.source) {
      const pr = this.set.scopeId.match(/^pr-(\d+)$/);
      if (pr) {
        const target = /^([^/]+)\/(.+)$/.exec(this.set.repositoryIdentity ?? '');
        if (!target) throw new Error(m().scope.prSnapshotChanged);
        assertPrSnapshotCurrent(this.set, await getPrByNumber(this.cwd, Number(pr[1]), { host: target[1], nameWithOwner: target[2] }));
      } else {
        if (await resolveCommit(this.cwd, this.set.source.headRef) !== this.set.headSha
          || this.set.source.baseRef && await resolveCommit(this.cwd, this.set.source.baseRef) !== this.set.source.baseTipSha) {
          throw new Error(m().businessReview.stale);
        }
      }
    }
    for (const source of draft ? selectedMaterials(draft) : []) {
      if (source.kind === 'file' && ((await readRequirementFile(source.location)).text !== currentMaterial(source).text
        || vscode.workspace.textDocuments.some((document) => document.isDirty && document.uri.toString() === vscode.Uri.file(source.location).toString()
          && document.getText().replace(/^\uFEFF/, '') !== currentMaterial(source).text.replace(/^\uFEFF/, '')))) {
        throw new Error(m().requirements.materialChanged);
      }
    }
    for (const [key, hash] of Object.entries(run?.dependencies ?? {})) {
      const at = key.indexOf(':');
      const side = key.slice(0, at);
      if (side !== 'head' && side !== 'base' || businessHash(await this.readFresh(key.slice(at + 1), side)) !== hash) {
        throw new Error(m().businessReview.stale);
      }
    }
  }
}
