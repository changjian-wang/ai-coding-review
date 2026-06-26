import * as vscode from 'vscode';
import { esc, nonce as makeNonce } from '../ui/html';

/** One selectable scope-kind row. */
export interface ScopeKindOption {
  id: string;
  label: string;
  description?: string;
  detail?: string;
}

/** Options for {@link pickScopeKind}. */
export interface ScopeKindPickerOptions {
  title: string;
  heading: string;
  options: ScopeKindOption[];
  /** Editor column to open in — anchor to the workbench's window. */
  viewColumn?: vscode.ViewColumn;
}

/**
 * Opens a tiny webview list to pick a scope KIND. Used instead of a native
 * QuickPick because a QuickPick only shows in the main window — invisible when
 * the workbench lives in its own auxiliary / full-screen window. Resolves with
 * the chosen option id, or `undefined` when cancelled / closed.
 */
export function pickScopeKind(opts: ScopeKindPickerOptions): Promise<string | undefined> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      'codereview.scopeKindPicker',
      opts.title,
      opts.viewColumn ?? vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    let settled = false;
    const finish = (result: string | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
      panel.dispose();
    };

    panel.webview.onDidReceiveMessage((msg: { type?: string; id?: unknown }) => {
      if (msg?.type === 'pick' && typeof msg.id === 'string') {
        finish(msg.id);
      } else if (msg?.type === 'cancel') {
        finish(undefined);
      }
    });

    panel.onDidDispose(() => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });

    panel.webview.html = renderHtml(opts);
  });
}

function renderHtml(opts: ScopeKindPickerOptions): string {
  const nonce = makeNonce();
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const data = JSON.stringify(opts.options);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root {
    --line: var(--vscode-panel-border, rgba(127,127,127,.25));
    --dim: var(--vscode-descriptionForeground, #999);
    --blue: var(--vscode-textLink-foreground, #569cd6);
  }
  * { box-sizing: border-box; }
  body { margin:0; height:100vh; display:flex; flex-direction:column;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .head { padding:14px 16px 10px; border-bottom:1px solid var(--line); }
  .head h2 { margin:0; font-size:14px; }
  .list { flex:1; overflow:auto; padding:10px 12px; display:flex; flex-direction:column; gap:8px; }
  .card { padding:11px 13px; border:1px solid var(--line); border-radius:8px; cursor:pointer; }
  .card:hover { background:var(--vscode-list-hoverBackground, rgba(127,127,127,.1)); border-color:var(--blue); }
  .card-top { display:flex; align-items:center; gap:8px; }
  .label { flex:1; font-weight:600; }
  .desc { flex:none; font-size:11px; color:var(--dim); }
  .detail { margin-top:4px; font-size:12px; color:var(--dim); line-height:1.5; }
</style>
</head>
<body>
  <div class="head"><h2>${esc(opts.heading)}</h2></div>
  <div class="list" id="list"></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const OPTS = ${data};
  const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const listEl = document.getElementById('list');
  listEl.innerHTML = OPTS.map((o) =>
    '<div class="card" data-id="' + esc(o.id) + '">'
    + '<div class="card-top"><span class="label">' + esc(o.label) + '</span>'
    + (o.description ? '<span class="desc">' + esc(o.description) + '</span>' : '')
    + '</div>'
    + (o.detail ? '<div class="detail">' + esc(o.detail) + '</div>' : '')
    + '</div>'
  ).join('');
  listEl.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    vscode.postMessage({ type: 'pick', id: card.getAttribute('data-id') });
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') vscode.postMessage({ type: 'cancel' });
  });
}());
</script>
</body>
</html>`;
}
