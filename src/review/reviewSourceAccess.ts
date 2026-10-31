import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { m } from '../i18n';
import { reviewRepositoryState } from '../scope/gitClient';
import { contentSignature } from './reviewWorkflow';
import { scanReviewablePaths } from '../scope/scopePicker';

export function isBinaryReviewPath(relativePath: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|ico|psd|pdf|zip|tar|gz|tgz|7z|vsix|woff2?|ttf|eot|mp4|mov|mp3|wav|exe|dll|so|dylib|wasm|bin|class|jar|pyc|db|sqlite3?)$/i.test(relativePath);
}

export function insideRepository(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function safeRepositoryUri(cwd: string, relativePath: string): Promise<vscode.Uri> {
  const absolute = path.resolve(cwd, relativePath);
  if (!relativePath || path.isAbsolute(relativePath) || !insideRepository(path.resolve(cwd), absolute)) {
    throw new Error(m().reviewCenter.outsideRepository);
  }
  const [root, target] = await Promise.all([fs.realpath(cwd), fs.realpath(absolute)]);
  if (!insideRepository(root, target)) throw new Error(m().reviewCenter.outsideRepository);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error(m().reviewCenter.sourceFileUnsupported);
  return vscode.Uri.file(absolute);
}

async function fingerprintPath(cwd: string, relativePath: string, token?: vscode.CancellationToken): Promise<string> {
  const absolute = path.resolve(cwd, relativePath);
  if (!insideRepository(path.resolve(cwd), absolute)) throw new Error(m().reviewCenter.outsideRepository);
  let stat;
  try {
    stat = await fs.lstat(absolute);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'deleted';
    throw error;
  }
  if (stat.isSymbolicLink()) return contentSignature(`symlink:${await fs.readlink(absolute)}`);
  if (!stat.isFile()) return `non-file:${stat.mtimeMs}:${stat.size}`;
  if (isBinaryReviewPath(relativePath)) return `non-text:${stat.mtimeMs}:${stat.size}`;
  await safeRepositoryUri(cwd, relativePath);
  const open = vscode.workspace.textDocuments.find((document) => document.uri.fsPath === absolute);
  if (open) return contentSignature(open.getText());
  const hash = createHash('sha256');
  const textHash = createHash('sha256');
  let decoder: TextDecoder | undefined;
  let validText = true;
  const stream = createReadStream(absolute);
  const cancel = token?.onCancellationRequested(() => stream.destroy(new Error(m().reviewCenter.runState.cancelled)));
  const timeout = setTimeout(() => stream.destroy(new Error(m().reviewCenter.sourceReadTimeout)), 15_000);
  try {
    for await (const chunk of stream) {
      hash.update(chunk);
      if (!validText) continue;
      if (!decoder) decoder = new TextDecoder(chunk[0] === 0xff && chunk[1] === 0xfe ? 'utf-16le' : chunk[0] === 0xfe && chunk[1] === 0xff ? 'utf-16be' : 'utf-8', { fatal: true });
      try { textHash.update(decoder.decode(chunk, { stream: true })); }
      catch { validText = false; }
    }
    if (validText) {
      try { textHash.update(decoder?.decode() ?? ''); }
      catch { validText = false; }
    }
    return validText ? textHash.digest('hex') : hash.digest('hex');
  } finally {
    clearTimeout(timeout);
    cancel?.dispose();
    stream.destroy();
  }
}

export async function repositoryEvidenceStamp(
  cwd: string,
  expectedHead: string,
  token?: vscode.CancellationToken,
): Promise<string> {
  const abort = new AbortController();
  const cancellation = token?.onCancellationRequested(() => abort.abort());
  if (token?.isCancellationRequested) abort.abort();
  try {
    let state: Awaited<ReturnType<typeof reviewRepositoryState>> | undefined;
    try { state = await reviewRepositoryState(cwd, abort.signal); }
    catch (error) {
      if (expectedHead !== 'live' || token?.isCancellationRequested) throw error;
      console.warn('[codereview] Git metadata unavailable; fingerprinting the reviewable local source folder:', error);
    }
    if (expectedHead === 'live' && (!state || await fs.realpath(state.root) !== await fs.realpath(cwd))) {
      const paths = await scanReviewablePaths([vscode.Uri.file(cwd)], cwd);
      const fingerprints = new Map<string, string>();
      for (const relativePath of paths) {
        if (token?.isCancellationRequested) throw new Error(m().reviewCenter.runState.cancelled);
        fingerprints.set(relativePath, await fingerprintPath(cwd, relativePath, token));
      }
      for (const document of vscode.workspace.textDocuments.filter((item) => item.isDirty && item.uri.scheme === 'file' && insideRepository(path.resolve(cwd), item.uri.fsPath))) {
        await safeRepositoryUri(cwd, path.relative(cwd, document.uri.fsPath));
        fingerprints.set(path.relative(cwd, document.uri.fsPath).replaceAll('\\', '/'), contentSignature(document.getText()));
      }
      return contentSignature(JSON.stringify([...fingerprints].sort(([a], [b]) => a.localeCompare(b))));
    }
    if (!state) throw new Error(m().reviewCenter.repositoryRootRequired);
    const [root, workspace] = await Promise.all([fs.realpath(state.root), fs.realpath(cwd)]);
    if (root !== workspace) throw new Error(m().reviewCenter.repositoryRootRequired);
    const dirtyDocuments = vscode.workspace.textDocuments.filter((document) =>
      document.isDirty && document.uri.scheme === 'file' && insideRepository(path.resolve(cwd), document.uri.fsPath),
    );
    if (expectedHead !== 'live' && (state.head !== expectedHead || state.status || dirtyDocuments.length)) {
      throw new Error(m().reviewCenter.snapshotMismatch);
    }
    const changed = new Map<string, string>();
    for (const relativePath of state.dirtyPaths) {
      if (token?.isCancellationRequested) throw new Error(m().reviewCenter.runState.cancelled);
      changed.set(relativePath, await fingerprintPath(cwd, relativePath, token));
    }
    for (const document of dirtyDocuments) {
      await safeRepositoryUri(cwd, path.relative(cwd, document.uri.fsPath));
      changed.set(path.relative(cwd, document.uri.fsPath).replaceAll('\\', '/'), contentSignature(document.getText()));
    }
    return contentSignature(JSON.stringify([state.head ?? 'unborn', state.paths, [...changed].sort(([a], [b]) => a.localeCompare(b))]));
  } finally {
    cancellation?.dispose();
  }
}
