import { isIP } from 'node:net';
import type { CancellationToken } from 'vscode';
import { fmt, m } from '../i18n';
import { readGithubRequirement } from '../gh/ghClient';
import { WorkflowError } from './reviewWorkflow';

const MAX_SOURCE_BYTES = 256_000;

export function decodeRequirementSource(name: string, bytes: Uint8Array): string {
  if (!/\.(md|markdown|txt)$/i.test(name)) throw new Error(m().reviewCenter.sourceFormat);
  return decodeText(bytes);
}

function decodeText(bytes: Uint8Array): string {
  if (bytes.length > MAX_SOURCE_BYTES) throw new WorkflowError('materialTooLarge');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(m().reviewCenter.sourceFormat);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error(m().reviewCenter.sourceFormat);
  return text;
}

export function requirementSourceUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(m().reviewCenter.unsupportedLink);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const credentials = [...url.searchParams.keys()].some((key) => /^(token|access_token|api[_-]?key|password|secret|sig|signature|auth|x-amz-(credential|signature|security-token)|x-goog-(credential|signature))$/i.test(key));
  if (url.protocol !== 'https:' || url.username || url.password || !hostname
    || credentials || isIP(hostname) !== 0 || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error(m().reviewCenter.linkCredentials);
  }
  url.hash = '';
  return url;
}

export async function readRequirementLink(
  value: string,
  cwd: string,
  token: CancellationToken,
  fetcher: typeof fetch = fetch,
  githubReader = readGithubRequirement,
): Promise<{ label: string; location: string; text: string }> {
  const url = requirementSourceUrl(value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const cancellation = token.onCancellationRequested(() => controller.abort());
  if (token.isCancellationRequested) controller.abort();
  try {
    const github = url.hostname.toLowerCase() === 'github.com'
      ? /^\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/([1-9]\d*)(?:\/(?:files|commits))?\/?$/.exec(url.pathname)
      : null;
    if (github) {
      const [, owner, repository, kind, id] = github;
      const source = await githubReader(cwd, owner, repository, Number(id), controller.signal);
      return {
        label: `${kind === 'pull' ? 'PR' : 'Issue'} ${owner}/${repository}#${id} · ${source.title}`,
        location: `https://github.com/${owner}/${repository}/${kind}/${id}`,
        text: `# ${source.title}\n\n${source.body}`,
      };
    }
    const response = await fetcher(url.href, {
      signal: controller.signal, redirect: 'error', credentials: 'omit',
      headers: { Accept: 'text/plain, text/markdown;q=0.9' },
    });
    if (!response.ok) throw new Error(fmt(m().reviewCenter.linkReadFailed, `${response.status} ${response.statusText}`));
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!/^text\/(plain|markdown|x-markdown)(?:;|$)/.test(contentType)
      || (/charset=/.test(contentType) && !/charset\s*=\s*["']?(utf-?8|us-ascii)\b/.test(contentType))) {
      throw new Error(m().reviewCenter.linkTypeUnsupported);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new WorkflowError('emptyMaterial');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > MAX_SOURCE_BYTES) {
          await reader.cancel();
          throw new WorkflowError('materialTooLarge');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const text = decodeText(bytes);
    return {
      label: url.pathname.split('/').pop() || url.hostname,
      location: url.href, text,
    };
  } finally {
    clearTimeout(timeout);
    cancellation.dispose();
  }
}
