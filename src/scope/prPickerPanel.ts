import * as vscode from 'vscode';
import { esc, nonce as makeNonce } from '../ui/html';
import { m } from '../i18n';
import type { PrSummary } from '../gh/types';

/** Options for {@link pickPr}. */
export interface PrPickerOptions {
  /** Base-repo slug shown in the header (upstream for a fork). */
  repoLabel: string;
  /** PRs to choose from (all states). */
  prs: PrSummary[];
  /** Login of the current gh user, enabling the "Mine" filter. */
  currentLogin?: string;
  /** Editor column to open in — anchor to the workbench's window. */
  viewColumn?: vscode.ViewColumn;
}

/**
 * Opens a webview card-list picker over the repo's open/draft PRs. Resolves with
 * the chosen PR number, or `undefined` when the reviewer cancels or closes it.
 */
export function pickPr(opts: PrPickerOptions): Promise<number | undefined> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      'codereview.prPicker',
      m().prPanel.title,
      opts.viewColumn ?? vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    let settled = false;
    const finish = (result: number | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
      panel.dispose();
    };

    panel.webview.onDidReceiveMessage((msg: { type?: string; number?: unknown }) => {
      if (msg?.type === 'confirm' && typeof msg.number === 'number') {
        finish(msg.number);
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

function renderHtml(opts: PrPickerOptions): string {
  const nonce = makeNonce();
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const data = JSON.stringify(opts.prs);
  const t = m().prPanel;
  const T = JSON.stringify(t);
  const me = JSON.stringify(opts.currentLogin ?? '');
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
    --green: var(--vscode-charts-green, #4ec9b0);
    --purple: var(--vscode-charts-purple, #b180d7);
    --red: var(--vscode-charts-red, #f14c4c);
  }
  * { box-sizing: border-box; }
  body { margin:0; height:100vh; display:flex; flex-direction:column;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .head { padding:12px 16px 8px; border-bottom:1px solid var(--line); }
  .head h2 { margin:0 0 4px; font-size:14px; }
  .repo-line { font-size:12px; color:var(--dim); }
  .repo-line b { color:var(--blue); font-weight:600; }
  .toolbar { display:flex; align-items:center; gap:8px; padding:8px 16px; border-bottom:1px solid var(--line); }
  .tabs { display:flex; gap:4px; }
  .tab { font-size:11.5px; padding:4px 10px; cursor:pointer; border:1px solid var(--line); border-radius:5px;
    background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
  .tab.active { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border-color:transparent; }
  .toolbar input[type=search] { flex:1; font-family:inherit; font-size:12px; padding:5px 9px;
    color:var(--vscode-input-foreground); background:var(--vscode-input-background);
    border:1px solid var(--vscode-input-border, var(--line)); border-radius:5px; outline:none; }
  .toolbar input[type=search]:focus { border-color:var(--vscode-focusBorder, var(--blue)); }
  .list { flex:1; overflow:auto; padding:8px 12px; display:flex; flex-direction:column; gap:8px; }
  .card { padding:10px 12px; border:1px solid var(--line); border-radius:8px; cursor:pointer; }
  .card:hover { background:var(--vscode-list-hoverBackground, rgba(127,127,127,.08)); }
  .card.sel { border-color:var(--blue); background:var(--vscode-list-activeSelectionBackground, rgba(86,156,214,.14)); }
  .card-top { display:flex; align-items:center; gap:8px; }
  .num { font-weight:700; color:var(--blue); flex:none; }
  .title { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .badge { flex:none; font-size:10.5px; padding:1px 7px; border-radius:10px; }
  .badge.open { color:var(--green); border:1px solid var(--green); }
  .badge.draft { color:var(--dim); border:1px solid var(--dim); }
  .badge.merged { color:var(--purple); border:1px solid var(--purple); }
  .badge.closed { color:var(--red); border:1px solid var(--red); }
  .card-meta { margin-top:4px; font-size:11.5px; color:var(--dim); display:flex; gap:10px; flex-wrap:wrap; }
  .empty { padding:24px 16px; color:var(--dim); text-align:center; }
  .foot { display:flex; align-items:center; gap:12px; padding:10px 16px; border-top:1px solid var(--line);
    background:var(--vscode-editorWidget-background, transparent); }
  .sel-line { flex:1; font-size:12px; color:var(--dim); }
  .sel-line b { color:var(--vscode-foreground); }
  button.act { font-family:inherit; font-size:12px; padding:6px 14px; cursor:pointer; border-radius:5px;
    border:1px solid var(--line); background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
  button.act:hover { background:var(--vscode-toolbar-hoverBackground); }
  button.act.primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border-color:transparent; }
  button.act.primary:disabled { opacity:.5; cursor:default; }
</style>
</head>
<body>
  <div class="head">
    <h2>${esc(t.heading)}</h2>
    <div class="repo-line">${esc(t.repoLabel)}<b>${esc(opts.repoLabel)}</b></div>
  </div>
  <div class="toolbar">
    <div class="tabs">
      <button class="tab active" data-tab="active">${esc(t.tabActive)}</button>
      <button class="tab" data-tab="mine">${esc(t.tabMine)}</button>
      <button class="tab" data-tab="open">${esc(t.tabOpen)}</button>
      <button class="tab" data-tab="draft">${esc(t.tabDraft)}</button>
      <button class="tab" data-tab="merged">${esc(t.tabMerged)}</button>
      <button class="tab" data-tab="closed">${esc(t.tabClosed)}</button>
      <button class="tab" data-tab="all">${esc(t.tabAll)}</button>
    </div>
    <input id="filter" type="search" placeholder="${esc(t.filterPlaceholder)}" autocomplete="off" />
  </div>
  <div class="list" id="list"></div>
  <div class="foot">
    <div class="sel-line" id="selLine"></div>
    <button class="act" id="btnCancel">${esc(t.cancel)}</button>
    <button class="act primary" id="btnConfirm" disabled>${esc(t.confirm)}</button>
  </div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const PRS = ${data};
  const T = ${T};
  const ME = ${me};
  const fmt = (s, ...a) => String(s).replace(/\\{(\\d+)\\}/g, (_, i) => a[Number(i)] ?? '');
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const listEl = $('list');
  const filterEl = $('filter');
  let tab = 'active';
  let selected = null;

  function timeAgo(iso) {
    const then = new Date(iso).getTime();
    if (!then) return '';
    const s = Math.max(0, (Date.now() - then) / 1000);
    if (s < 60) return Math.floor(s) + 's';
    const mn = s / 60; if (mn < 60) return Math.floor(mn) + 'm';
    const h = mn / 60; if (h < 24) return Math.floor(h) + 'h';
    const d = h / 24; if (d < 30) return Math.floor(d) + 'd';
    const mo = d / 30; if (mo < 12) return Math.floor(mo) + 'mo';
    return Math.floor(mo / 12) + 'y';
  }

  function statusOf(p) {
    if (p.state === 'MERGED') return 'merged';
    if (p.state === 'CLOSED') return 'closed';
    return p.isDraft ? 'draft' : 'open';
  }

  function visible() {
    const q = (filterEl.value || '').trim().toLowerCase();
    return PRS.filter((p) => {
      const st = statusOf(p);
      if (tab === 'mine') {
        if (!ME || p.author !== ME) return false;
      } else {
        if (tab === 'active' && st !== 'open' && st !== 'draft') return false;
        if (tab === 'open' && st !== 'open') return false;
        if (tab === 'draft' && st !== 'draft') return false;
        if (tab === 'merged' && st !== 'merged') return false;
        if (tab === 'closed' && st !== 'closed') return false;
      }
      if (q) {
        const hay = ('#' + p.number + ' ' + p.title + ' ' + (p.author || '') + ' ' + p.headRefName).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function render() {
    const rows = visible();
    if (rows.length === 0) {
      listEl.innerHTML = '<div class="empty">' + esc(PRS.length ? T.noMatch : T.empty) + '</div>';
      return;
    }
    listEl.innerHTML = rows.map((p) => {
      const st = statusOf(p);
      const badgeText = { open: T.badgeOpen, draft: T.badgeDraft, merged: T.badgeMerged, closed: T.badgeClosed }[st];
      const badge = '<span class="badge ' + st + '">' + esc(badgeText) + '</span>';
      const refs = esc(p.headRefName) + ' &rarr; ' + esc(p.baseRefName);
      const changed = fmt(T.metaChanged, p.changedFiles);
      const churn = '+' + p.additions + ' \u2212' + p.deletions;
      const meta = esc(p.author || '') + ' \u00b7 ' + timeAgo(p.updatedAt) + ' \u00b7 ' + changed + ' \u00b7 ' + churn;
      const sel = selected === p.number ? ' sel' : '';
      return '<div class="card' + sel + '" data-n="' + p.number + '">'
        + '<div class="card-top"><span class="num">#' + p.number + '</span>'
        + '<span class="title" title="' + esc(p.title) + '">' + esc(p.title) + '</span>' + badge + '</div>'
        + '<div class="card-meta"><span>' + refs + '</span><span>' + meta + '</span></div>'
        + '</div>';
    }).join('');
  }

  function updateFoot() {
    const btn = $('btnConfirm');
    if (selected == null) { btn.disabled = true; $('selLine').textContent = ''; return; }
    btn.disabled = false;
    const pr = PRS.find((p) => p.number === selected);
    $('selLine').innerHTML = '#' + selected + ' <b>' + esc(pr ? pr.title : '') + '</b>';
  }

  listEl.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    selected = Number(card.getAttribute('data-n'));
    render(); updateFoot();
  });
  filterEl.addEventListener('input', () => render());
  for (const tb of document.querySelectorAll('.tab')) {
    tb.addEventListener('click', () => {
      for (const x of document.querySelectorAll('.tab')) x.classList.remove('active');
      tb.classList.add('active');
      tab = tb.getAttribute('data-tab');
      render();
    });
  }
  $('btnCancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('btnConfirm').addEventListener('click', () => {
    if (selected != null) vscode.postMessage({ type: 'confirm', number: selected });
  });

  render(); updateFoot();
}());
</script>
</body>
</html>`;
}
