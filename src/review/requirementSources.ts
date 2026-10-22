import { readFile, stat } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { fmt, m } from '../i18n';
import { readGitHubRequirement } from '../gh/ghClient';
import { REQUIREMENT_LIMITS, validateMaterialText, type RequirementMaterial } from './requirements';

export interface LoadedRequirement {
  kind: RequirementMaterial['kind'];
  name: string;
  location: string;
  text: string;
  format: RequirementMaterial['format'];
}

export function decodeRequirementFile(bytes: Uint8Array, name: string): string {
  if (!/\.(md|markdown|txt)$/i.test(name)) throw new Error(m().requirements.fileUnsupported);
  if (bytes.byteLength > REQUIREMENT_LIMITS.bytes) throw new Error(m().requirements.sourceTooLarge);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(m().requirements.fileEncoding); }
  validateMaterialText(text);
  return text;
}

export async function readRequirementFile(filePath: string): Promise<LoadedRequirement> {
  const size = (await stat(filePath)).size;
  if (size > REQUIREMENT_LIMITS.bytes) throw new Error(m().requirements.sourceTooLarge);
  const name = filePath.split(/[\\/]/).at(-1) ?? filePath;
  return {
    kind: 'file', name, location: filePath, format: /\.txt$/i.test(name) ? 'text' : 'markdown',
    text: decodeRequirementFile(await readFile(filePath), name),
  };
}

export function validateRequirementUrl(address: string): URL {
  let url: URL;
  try { url = new URL(address); } catch { throw new Error(m().requirements.unsafeUrl); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname
    || /(^|\.)localhost$|\.local$|\.internal$/i.test(url.hostname)) throw new Error(m().requirements.unsafeUrl);
  return url;
}

export function isPublicRequirementAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
      || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19)
      || a === 192 && b === 0 && (c === 0 || c === 2)
      || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113);
  }
  // Only global-unicast IPv6; reject transition/tunnelling ranges as well.
  return family === 6 && /^[23][0-9a-f]{3}:/i.test(address)
    && !/^2002:|^2001:(0{1,4}:|db8:)/i.test(address);
}

export interface RequirementHttpResponse {
  status: number;
  type: string;
  location?: string;
  body: Uint8Array;
}

export interface RequirementHttpServices {
  addresses(hostname: string): Promise<{ address: string; family: number }[]>;
  get(url: URL, address: { address: string; family: number }, signal: AbortSignal): Promise<RequirementHttpResponse>;
}

const httpServices: RequirementHttpServices = {
  addresses: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  get: (url, address, signal) => new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: url.protocol, hostname: address.address, family: address.family,
      servername: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || (url.protocol === 'https:' ? 443 : 80),
      method: 'GET', path: `${url.pathname}${url.search}`, signal,
      headers: { Host: url.host, Accept: 'text/markdown, text/plain, text/html', 'Accept-Encoding': 'identity' },
    }, (response: IncomingMessage) => {
      response.on('error', reject);
      if (Number(response.headers['content-length'] ?? 0) > REQUIREMENT_LIMITS.bytes) {
        response.destroy(new Error(m().requirements.sourceTooLarge));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > REQUIREMENT_LIMITS.bytes) response.destroy(new Error(m().requirements.sourceTooLarge));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0, type: String(response.headers['content-type'] ?? ''),
        location: response.headers.location, body: Buffer.concat(chunks),
      }));
    });
    request.on('error', reject);
    request.end();
  }),
};

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason ?? new Error(m().requirements.canceled));
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    work.then((value) => { signal.removeEventListener('abort', cancel); resolve(value); },
      (error) => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}

export async function readPublicRequirementUrl(
  address: string, signal: AbortSignal = AbortSignal.timeout(20_000), services: RequirementHttpServices = httpServices,
): Promise<LoadedRequirement> {
  const initial = validateRequirementUrl(address);
  let url = initial;
  for (let count = 0; count <= 3; count++) {
    signal.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(services.addresses(hostname), signal);
    signal.throwIfAborted();
    if (!addresses.length || addresses.some((entry) => !isPublicRequirementAddress(entry.address))) {
      throw new Error(m().requirements.unsafeUrl);
    }
    // Connect to the validated address, preserving HTTP Host and TLS servername.
    const response = await abortable(services.get(url, addresses[0], signal), signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location || count === 3) throw new Error(m().requirements.redirectBlocked);
      const next = validateRequirementUrl(new URL(response.location, url).href);
      if (next.origin !== initial.origin) throw new Error(m().requirements.redirectBlocked);
      url = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(fmt(m().requirements.urlFailed, `HTTP ${response.status}`));
    }
    const type = response.type.split(';')[0].trim().toLowerCase();
    if (!['text/plain', 'text/markdown', 'text/x-markdown', 'text/html', 'application/xhtml+xml'].includes(type)) {
      throw new Error(m().requirements.urlType);
    }
    const text = decodeRequirementFile(response.body, 'response.txt');
    return {
      kind: 'url', name: url.hostname + url.pathname, location: url.href, text,
      format: type.includes('html') ? 'html' : type.includes('markdown') ? 'markdown' : 'text',
    };
  }
  throw new Error(m().requirements.redirectBlocked);
}

export async function readRequirementLink(cwd: string, address: string, signal?: AbortSignal): Promise<LoadedRequirement> {
  const url = validateRequirementUrl(address);
  if (url.hostname === 'github.com') {
    const result = await readGitHubRequirement(cwd, url);
    signal?.throwIfAborted();
    validateMaterialText(result.text);
    return { kind: 'github', name: result.name, location: url.href, text: result.text, format: 'markdown' };
  }
  return readPublicRequirementUrl(url.href, signal);
}
