import { randomUUID } from 'node:crypto';

/** Escapes the three HTML-significant characters for safe text-node interpolation. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escapes a string for use inside a double-quoted HTML attribute. */
export function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}

/** Cryptographically strong, unguessable nonce for a webview CSP. */
export function nonce(): string {
  return randomUUID().replace(/-/g, '');
}

export function scriptJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Review state is not serializable');
  return json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
