import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createScopePreparation } from '../scope/scopePreparationPanel';
import { BranchSnapshotScope } from '../scope/scopes';
import { parseRequirementUnderstanding } from '../review/requirements';
import type { PrSummary } from '../gh/types';
import type { ReviewSet } from '../scope/types';
import { m } from '../i18n';

interface LoadingReport {
  phase: string;
  prDisabled: boolean;
  spinner: boolean;
  selected: string;
  oldOption: boolean;
  materialEnabled: boolean;
  materialCount: number;
  confirmDisabled: boolean;
  scopeText: string;
  understandingText: string;
  error: string;
  integratedBrowse: boolean;
}

export async function runPreparationLoadingHostChecks(cwd: string): Promise<string[]> {
  const panel = vscode.window.createWebviewPanel('codereview.scopePreparation', 'Loading test',
    vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  let list!: (prs: PrSummary[]) => void;
  let failRefresh!: (error: Error) => void;
  let readScope!: (set: ReviewSet) => void;
  let finishModel!: () => void;
  let listCalls = 0;
  const reports = new Map<string, LoadingReport>();
  const subscription = panel.webview.onDidReceiveMessage((message: { loadingCheck?: LoadingReport }) => {
    if (message.loadingCheck) reports.set(message.loadingCheck.phase, message.loadingCheck);
  });
  const handle = createScopePreparation(cwd, vscode.ViewColumn.One, 'pr', {
    hostPanel: panel,
    loadPrs: () => ++listCalls === 1
      ? new Promise((resolve) => { list = resolve; })
      : new Promise((_resolve, reject) => { failRefresh = reject; }),
    loadScope: () => new Promise((resolve) => { readScope = resolve; }),
    analyze: (draft, scope) => new Promise((resolve) => {
      finishModel = () => resolve(parseRequirementUnderstanding({
        summary: 'Controlled requirement understanding.',
        requirements: [{
          id: 'RQ-1', title: 'Reserve before restore', text: 'Reserve inventory before restoring an order.',
          origins: [{ sourceId: draft.materials[0].id, version: 1, line: 1, endLine: 1, quote: draft.materials[0].versions[0].text }],
        }], checks: [], questions: [],
      }, draft, scope.key, 'controlled-loading-fixture'));
    }),
  });
  const report = async (phase: string): Promise<LoadingReport> => {
    const deadline = Date.now() + 30_000;
    while (!reports.has(phase)) {
      if (Date.now() >= deadline) throw new Error(`Timed out: native preparation loading phase ${phase}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return reports.get(phase)!;
  };
  const anchor = "rememberPreparation();api.postMessage({type:'ready'});";
  const automation = `
    function reportLoading(phase){
      api.postMessage({type:'rendered',cwd:${JSON.stringify(cwd)},loadingCheck:{
        phase,prDisabled:$('pr').disabled,spinner:!$('status-spinner').hidden,selected:$('pr').value,
        oldOption:[...$('pr').options].some(option=>option.value==='42'),
        materialEnabled:!$('paste').disabled&&!$('file').disabled&&!$('link').disabled,
        materialCount:document.querySelectorAll('.material').length,confirmDisabled:$('confirm').disabled,
        scopeText:$('status-text').textContent,understandingText:$('requirement-status').textContent,
        error:$('error').textContent,integratedBrowse:!!$('repository').querySelector('optgroup #browse-repository')&&!document.getElementById('browse')
      }});
    }
    window.addEventListener('message',event=>{
      const message=event.data;
      if(message.type==='repository')reportLoading('list-pending');
      else if(message.type==='prs')reportLoading('list-ready');
      else if(message.type==='requirements'){
        const state=message.state;
        if(state.scopeLoading)reportLoading('scope-pending');
        else if(state.busy)reportLoading('model-pending');
        else if(state.ready)reportLoading('understanding-ready');
        else if(state.materials.length&&!state.scopeReady)reportLoading('material-saved');
      }else if(message.type==='error'&&message.target==='prs')reportLoading('refresh-failed');
      else if(message.type==='loadingPaste'){
        $('paste').click();$('material-name').value='While PRs load';
        $('material-text').value='Reserve inventory before restoring an order.';
        $('material-form').requestSubmit();
      }else if(message.type==='loadingChoose'){
        $('pr').value='42';$('pr').dispatchEvent(new Event('change'));
      }else if(message.type==='loadingRefresh'){
        $('retry').click();reportLoading('refresh-pending');
      }
    });
  `;
  assert.ok(panel.webview.html.includes(anchor));
  panel.webview.html = panel.webview.html.replace(anchor, `${automation}${anchor}`);
  try {
    const pending = await report('list-pending');
    assert.equal(pending.integratedBrowse, true);
    assert.equal(pending.prDisabled, true);
    assert.equal(pending.spinner, true);
    assert.equal(pending.materialEnabled, true);
    assert.equal(pending.confirmDisabled, true);
    await panel.webview.postMessage({ type: 'loadingPaste' });
    assert.equal((await report('material-saved')).materialCount, 1);
    const pr: PrSummary = {
      number: 42, title: 'Controlled PR', url: '', author: '', isDraft: false, state: 'OPEN',
      headRefName: 'feature', baseRefName: 'main', updatedAt: '', additions: 1, deletions: 0, changedFiles: 1,
    };
    list([pr]);
    const listed = await report('list-ready');
    assert.equal(listed.selected, '', 'A first PR must not be selected automatically');
    assert.equal(listed.prDisabled, false);
    await panel.webview.postMessage({ type: 'loadingChoose' });
    const scope = await report('scope-pending');
    assert.equal(scope.scopeText, m().scope.loadingPrScope);
    assert.equal(scope.understandingText, m().scope.scopePending);
    assert.equal(scope.materialEnabled, true);
    const set = await new BranchSnapshotScope('feature', 'main').load(cwd);
    readScope({ ...set, scopeId: 'pr-42' });
    assert.equal((await report('model-pending')).understandingText, m().requirements.analyzing);
    finishModel();
    assert.equal((await report('understanding-ready')).confirmDisabled, false);
    await panel.webview.postMessage({ type: 'loadingRefresh' });
    const refresh = await report('refresh-pending');
    assert.equal(refresh.selected, '42');
    assert.equal(refresh.oldOption, true);
    assert.equal(refresh.prDisabled, true);
    assert.equal(refresh.confirmDisabled, true);
    assert.equal(refresh.materialCount, 1);
    const deadline = Date.now() + 30_000;
    while (!failRefresh) {
      if (Date.now() >= deadline) throw new Error('Timed out: native controlled PR refresh');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    failRefresh(new Error('Controlled PR list failure'));
    const failed = await report('refresh-failed');
    assert.equal(failed.error, 'Controlled PR list failure');
    assert.equal(failed.oldOption, true);
    assert.equal(failed.confirmDisabled, true);
    return [
      'native repository dropdown integrates browsing; pending PR lists keep material input usable and never auto-select a PR',
      'native PR-list/source/model phases and retained-refresh failure remain distinct without enabling stale review',
    ];
  } finally {
    subscription.dispose();
    handle.dispose();
  }
}
