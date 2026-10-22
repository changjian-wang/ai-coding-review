import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import { m } from '../i18n';
import { esc, nonce } from '../ui/html';
import { currentBranch, listReviewRefs, repositoryRoot } from './gitClient';
import { ensureAuth, ensureGhAvailable, listPrs } from '../gh/ghClient';
import type { PrSummary } from '../gh/types';

export interface PreparedScopeChoice {
  cwd: string;
  kind: 'pr' | 'branchChanges' | 'branchFull' | 'files';
  prNumber?: number;
  headRef?: string;
  baseRef?: string;
}

interface RepositoryData {
  cwd: string;
  refs: string[];
  current: string;
  prs?: PrSummary[];
}

export function validatePreparedScope(data: RepositoryData | undefined, input: Record<string, unknown>): PreparedScopeChoice {
  if (!data || input.cwd !== data.cwd) throw new Error(m().scope.staleSelection);
  if (input.kind === 'files') return { cwd: data.cwd, kind: 'files' };
  if (input.kind === 'pr') {
    const pr = data.prs?.find((item) => item.number === input.prNumber);
    if (!pr) throw new Error(m().scope.staleSelection);
    return { cwd: data.cwd, kind: 'pr', prNumber: pr.number };
  }
  if (input.kind !== 'branchChanges' && input.kind !== 'branchFull') throw new Error(m().scope.staleSelection);
  const headRef = input.headRef;
  if (typeof headRef !== 'string' || !data.refs.includes(headRef)) throw new Error(m().scope.staleSelection);
  if (input.kind === 'branchFull') return { cwd: data.cwd, kind: 'branchFull', headRef };
  const baseRef = input.baseRef;
  if (typeof baseRef !== 'string' || !data.refs.includes(baseRef)) throw new Error(m().scope.staleSelection);
  if (baseRef === headRef) throw new Error(m().scope.sameComparison);
  return { cwd: data.cwd, kind: 'branchChanges', headRef, baseRef };
}

export function createScopePreparation(
  defaultCwd: string,
  viewColumn?: vscode.ViewColumn,
  initialKind = 'pr',
): { result: Promise<PreparedScopeChoice | undefined>; ready: Promise<boolean>; dispose(): void } {
  const t = m().scope;
  const panel = vscode.window.createWebviewPanel('codereview.scopePreparation', t.prepareTitle,
    viewColumn ?? vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  const roots = [...new Set([defaultCwd, ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)])];
  let data: RepositoryData | undefined;
  let generation = 0;
  let settled = false;
  let disposed = false;
  let selectedRoot = defaultCwd;
  let finish!: (value: PreparedScopeChoice | undefined) => void;
  let markReady!: (ready: boolean) => void;
  const result = new Promise<PreparedScopeChoice | undefined>((resolve) => { finish = resolve; });
  const ready = new Promise<boolean>((resolve) => { markReady = resolve; });
  const post = (message: object) => { if (!disposed) void panel.webview.postMessage(message); };
  const load = async (selected: string) => {
    const run = ++generation;
    data = undefined;
    try {
      if (!roots.includes(selected)) throw new Error(t.staleSelection);
      selectedRoot = selected;
      post({ type: 'loading', selected, roots });
      const cwd = await realpath(await repositoryRoot(selected));
      const [refs, current] = await Promise.all([listReviewRefs(cwd), currentBranch(cwd)]);
      if (run !== generation || disposed) return;
      if (!refs.length) throw new Error(t.noBranches);
      data = { cwd, refs, current };
      post({ type: 'repository', data, roots, selected });
    } catch (error) {
      if (run === generation) post({ type: 'error', message: String((error as Error).message) });
    }
  };
  panel.onDidDispose(() => { disposed = true; generation++; markReady(false); if (!settled) finish(undefined); });
  panel.webview.onDidReceiveMessage(async (input: Record<string, unknown>) => {
    try {
      if (input.type === 'ready') { await load(defaultCwd); return; }
      if (input.type === 'rendered') { if (data && input.cwd === data.cwd) markReady(true); return; }
      if (input.type === 'repository' && typeof input.cwd === 'string') { await load(input.cwd); return; }
      if (input.type === 'browse') {
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: t.browseRepository });
        if (picked?.[0]) {
          const cwd = picked[0].fsPath;
          if (!roots.includes(cwd)) roots.push(cwd);
          await load(cwd);
        }
        return;
      }
      if (input.type === 'prs') {
        const current = data;
        const run = generation;
        if (!current || input.cwd !== current.cwd) throw new Error(t.staleSelection);
        current.prs = undefined;
        try {
          await ensureGhAvailable(current.cwd);
          await ensureAuth(current.cwd);
          const prs = await listPrs(current.cwd);
          if (run !== generation || disposed || current !== data) return;
          current.prs = prs;
          post({ type: 'prs', prs });
        } catch (error) {
          if (run === generation && current === data) {
            post({ type: 'error', message: String((error as Error).message) });
          }
        }
        return;
      }
      if (input.type === 'select') {
        const selected = input.kind === 'files' && typeof input.cwd === 'string' && (input.cwd === selectedRoot || input.cwd === data?.cwd)
          ? { cwd: await realpath(selectedRoot), kind: 'files' as const }
          : validatePreparedScope(data, input);
        settled = true;
        finish(selected);
        panel.dispose();
      } else if (input.type === 'cancel') panel.dispose();
    } catch (error) {
      post({ type: 'error', message: String((error as Error).message) });
    }
  });
  const token = nonce();
  const catalog = JSON.stringify(t).replace(/</g, '\\u003c');
  panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${token}'">
  <style>*{box-sizing:border-box}body{margin:0;padding:28px 22px;font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}main{max-width:760px;margin:auto}h1{font-size:22px}p{line-height:1.8;color:var(--vscode-descriptionForeground)}section{border:1px solid var(--vscode-panel-border);padding:18px;border-radius:6px;margin:18px 0}.fields{display:grid;grid-template-columns:1fr 1fr;gap:15px}label{display:block;font-size:12px;min-width:0}select{display:block;width:100%;margin-top:7px;padding:8px;color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border)}button{padding:8px 13px;border:0;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:disabled{opacity:.55;cursor:default}button.secondary{color:var(--vscode-textLink-foreground);background:transparent;padding-left:0}#error{color:var(--vscode-errorForeground);overflow-wrap:anywhere}#source{overflow-wrap:anywhere}footer{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}select:focus-visible,button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}@media(max-width:560px){body{padding:20px 14px}.fields{grid-template-columns:1fr}}[hidden]{display:none!important}</style></head><body><main>
  <h1>${esc(t.prepareTitle)}</h1><p>${esc(t.prepareIntro)}</p><section><div class="fields">
  <label>${esc(t.repository)}<select id="repository"></select></label><label>${esc(t.target)}<select id="kind"><option value="pr">${esc(t.prTarget)}</option><option value="branchChanges">${esc(t.branchTarget)}</option><option value="branchFull">${esc(t.fullTarget)}</option></select></label>
  <label id="pr-field">${esc(t.pr)}<select id="pr"></select></label><label id="head-field">${esc(t.branch)}<select id="head"></select></label><label id="base-field">${esc(t.base)}<select id="base"></select></label></div>
  <p id="source"></p><p id="status" role="status"></p><p id="error" role="alert" hidden></p><button id="retry" class="secondary">${esc(t.retry)}</button><button id="browse" class="secondary">${esc(t.browseRepository)}</button></section>
  <p>${esc(t.scopeBoundary)}</p><footer><button id="files" class="secondary">${esc(t.localFiles)}</button><button id="confirm" disabled>${esc(t.startScope)}</button></footer></main>
  <script nonce="${token}">(()=>{'use strict';const api=acquireVsCodeApi();const T=${catalog};const $=id=>document.getElementById(id);let data;let prsLoading=false;let selected;
  $('kind').value=${JSON.stringify(initialKind === 'branchChanges' || initialKind === 'branchFull' ? initialKind : 'pr')};
  function options(select,items,value){select.replaceChildren();const blank=document.createElement('option');blank.value='';blank.textContent=T.select;select.appendChild(blank);for(const item of items){const option=document.createElement('option');option.value=String(item.value);option.textContent=item.label;select.appendChild(option);}select.value=value||'';}
  function update(){const kind=$('kind').value;const pr=kind==='pr';$('pr-field').hidden=!pr;$('head-field').hidden=pr;$('base-field').hidden=kind!=='branchChanges';$('confirm').disabled=!data||(pr?!data.prs||!$('pr').value:!$('head').value||kind==='branchChanges'&&(!$('base').value||$('base').value===$('head').value));$('files').disabled=!selected;if(data&&pr&&!data.prs&&!prsLoading){prsLoading=true;$('status').textContent=T.loadingPrList;api.postMessage({type:'prs',cwd:data.cwd});} }
  function send(kind){if(!data&&kind!=='files')return;api.postMessage({type:'select',cwd:data?data.cwd:selected,kind,prNumber:Number($('pr').value),headRef:$('head').value,baseRef:$('base').value});}
  $('kind').onchange=update;$('head').onchange=update;$('base').onchange=update;$('pr').onchange=update;
  $('repository').onchange=()=>{selected=$('repository').value;api.postMessage({type:'repository',cwd:selected});};
  $('confirm').onclick=()=>send($('kind').value);$('files').onclick=()=>send('files');
  $('browse').onclick=()=>api.postMessage({type:'browse'});$('retry').onclick=()=>{if(data&&$('kind').value==='pr'){data.prs=undefined;prsLoading=false;$('error').hidden=true;update();}else api.postMessage({type:'repository',cwd:selected||${JSON.stringify(defaultCwd).replace(/</g, '\\u003c')}});};
  window.addEventListener('message',event=>{const msg=event.data;if(msg.type==='loading'){data=undefined;selected=msg.selected;options($('repository'),msg.roots.map(root=>({value:root,label:root})),selected);prsLoading=false;$('status').textContent=T.loading;$('error').hidden=true;update();}else if(msg.type==='repository'){data=msg.data;selected=msg.selected;options($('repository'),msg.roots.map(root=>({value:root,label:root})),selected);options($('head'),data.refs.map(ref=>({value:ref,label:ref})),data.current);options($('base'),data.refs.map(ref=>({value:ref,label:ref})),data.refs.includes('origin/main')?'origin/main':data.refs.includes('main')?'main':'');options($('pr'),[]);$('source').textContent=data.cwd;$('status').textContent='';update();api.postMessage({type:'rendered',cwd:data.cwd});}else if(msg.type==='prs'&&data){data.prs=msg.prs;prsLoading=false;options($('pr'),msg.prs.map(pr=>({value:pr.number,label:'PR #'+pr.number+' · '+pr.title})));$('status').textContent=msg.prs.length?'':T.noPrs;update();}else if(msg.type==='error'){prsLoading=false;$('error').textContent=msg.message;$('error').hidden=false;$('status').textContent='';$('confirm').disabled=true;}});
  window.addEventListener('keydown',event=>{if(event.key==='Escape')api.postMessage({type:'cancel'});});
  api.postMessage({type:'ready'});})();</script></body></html>`;
  return { result, ready, dispose: () => panel.dispose() };
}
