import * as path from 'node:path';
import * as vscode from 'vscode';
import { readSnapshotFile, snapshotPaths, validateRepositoryPath } from '../scope/gitClient';
import type { ReviewSet } from '../scope/types';
import type { RepositoryEvidenceServices } from './repositoryEvidence';

/** Reads all sources and related evidence from one immutable Git object tree. */
export class CommitSource {
  private readonly content = new Map<string, Promise<string>>();
  private paths?: Promise<string[]>;

  constructor(readonly cwd: string, readonly reviewSet: ReviewSet) {
    if (!reviewSet.source) throw new Error('A commit-backed review source is required');
  }

  read(file: string, sha = this.reviewSet.headSha): Promise<string> {
    validateRepositoryPath(file);
    const key = `${sha}:${file}`;
    let loaded = this.content.get(key);
    if (!loaded) {
      loaded = readSnapshotFile(this.cwd, sha, file);
      this.content.set(key, loaded);
    }
    return loaded;
  }

  readReviewFile(file: string): Promise<string> {
    const entry = this.reviewSet.files.find((item) => item.path === file);
    return entry?.status === 'deleted' && this.reviewSet.comparison
      ? this.read(entry.previousPath ?? file, this.reviewSet.comparison.baseSha)
      : this.read(file);
  }

  listPaths(): Promise<string[]> {
    return this.paths ??= snapshotPaths(this.cwd, this.reviewSet.headSha);
  }

  evidenceServices(): RepositoryEvidenceServices {
    return {
      languageServicesAvailable: false,
      definitions: async () => [],
      references: async () => [],
      readText: async (uri) => {
        const relative = path.relative(this.cwd, uri.fsPath).split(path.sep).join('/');
        validateRepositoryPath(relative);
        return this.read(relative);
      },
      listReviewablePaths: () => this.listPaths(),
      uriForPath: (_cwd, file) => {
        validateRepositoryPath(file);
        return vscode.Uri.joinPath(vscode.Uri.file(this.cwd), ...file.split('/'));
      },
      now: Date.now,
    };
  }
}
