import { createHash } from 'node:crypto';
import * as path from 'node:path';

export function canonicalRepositoryPath(root: string): string {
  if (/^[a-z]:[\\/]|^\\\\/i.test(root)) {
    return path.win32.resolve(root).replace(/\\/g, '/').toLowerCase();
  }
  return path.resolve(root).replace(/\\/g, '/');
}

export function repositoryStorageId(root: string, remote?: string): string {
  return `repo-v2-${createHash('sha256').update(`${canonicalRepositoryPath(root)}\0${remote ?? ''}`).digest('hex')}`;
}

export function repositoryLabel(root: string): string {
  return /^[a-z]:[\\/]|^\\\\/i.test(root) ? path.win32.basename(root) : path.basename(root);
}
