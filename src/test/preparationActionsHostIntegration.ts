import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createScopePreparation } from '../scope/scopePreparationPanel';
import { BranchSnapshotScope, FileSystemScope } from '../scope/scopes';
import {
  acceptRequirementUnderstanding, addRequirementMaterial, createRequirementsDraft,
  humanRequirementUnderstanding, requirementReadiness, requirementScopeKey,
} from '../review/requirements';
import { m } from '../i18n';

interface ActionReport {
  phase: string;
  heading: string;
  body: string;
  input: string;
  error: string;
  editor: boolean;
  saveDisabled: boolean;
  cancelDisabled: boolean;
  confirmDisabled: boolean;
  branchDisabled: boolean;
  inert: boolean;
  kind: string;
  fileModeVisible: boolean;
  materials: number;
  humanNotice: boolean;
  scrollTop: number;
  scrollBottom: number;
  footerTop: number;
  footerBottom: number;
  bodyTop: number;
  bodyBottom: number;
  viewport: number;
}

async function waitFor(test: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 30_000;
  while (!test()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function runPreparationActionsHostChecks(cwd: string): Promise<string[]> {
  const original = 'Reserve inventory before restoring an order.';
  const revised = 'Reserve inventory atomically before restoring an order.';
  const set = await new BranchSnapshotScope('feature', 'main').load(cwd);
  const local = await new FileSystemScope(['src/value.ts']).load(cwd);
  const draft = createRequirementsDraft();
  addRequirementMaterial(draft, { kind: 'human', name: 'Human requirement', location: 'Controlled host input', format: 'text', text: original });
  acceptRequirementUnderstanding(draft, humanRequirementUnderstanding(draft, requirementScopeKey(cwd, set)));
  const material = structuredClone(draft.materials[0]);
  const panel = vscode.window.createWebviewPanel('codereview.scopePreparation', 'Preparation actions',
    vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  let write: 'normal' | 'fail' | 'pause' = 'normal';
  let release: (() => void) | undefined;
  let picks = 0;
  let completed = false;
  let saved = structuredClone(draft);
  let sequence = 0;
  let clientReady = false;
  const reports = new Map<string, ActionReport>();
  const subscription = panel.webview.onDidReceiveMessage((message: { actionReport?: ActionReport; actionReady?: boolean }) => {
    if (message.actionReport) reports.set(message.actionReport.phase, message.actionReport);
    if (message.actionReady) clientReady = true;
  });
  const handle = createScopePreparation(cwd, vscode.ViewColumn.One, 'branchChanges', {
    hostPanel: panel,
    load: async () => ({ draft: structuredClone(draft), selection: { cwd, kind: 'branchChanges', headRef: 'feature', baseRef: 'main' } }),
    loadScope: async () => set,
    save: async (_cwd, _identity, record) => {
      const mode = write;
      write = 'normal';
      if (mode === 'fail') throw new Error('Controlled native storage failure');
      if (mode === 'pause') await new Promise<void>((resolve) => { release = resolve; });
      saved = structuredClone(record.draft);
    },
    pickFiles: async () => ++picks === 1 ? undefined : local,
  });
  void handle.result.then(() => { completed = true; });
  const anchor = "rememberPreparation();api.postMessage({type:'ready'});";
  const automation = `
    window.addEventListener('message',event=>{
      const message=event.data;if(message.type!=='preparationActionProbe')return;
      if(message.action==='edit')document.querySelector('[data-revise]').click();
      else if(message.action==='save'){
        $('inline-body').value=${JSON.stringify(revised)};
        $('inline-body').dispatchEvent(new Event('input',{bubbles:true}));
        $('requirement-inline').requestSubmit();
      }else if(message.action==='cancel')$('cancel-inline').click();
      else if(message.action==='files'){$('review-options').open=true;$('files').click();}
      else if(message.action==='confirm')$('confirm').click();
      else if(message.action==='lateScope')api.postMessage({type:'selection',cwd:${JSON.stringify(cwd)},kind:'branchFull',headRef:'main'});
      else if(message.action==='bottom')$('prepare-scroll').scrollTop=$('prepare-scroll').scrollHeight;
      requestAnimationFrame(()=>{
        const scroll=$('prepare-scroll').getBoundingClientRect(),footer=$('prepare-footer').getBoundingClientRect();
        const body=document.querySelector('.requirement-text'),rect=body?.getBoundingClientRect();
        api.postMessage({type:'rendered',cwd:${JSON.stringify(cwd)},actionReport:{
          phase:message.phase,heading:$('understanding-title').textContent,body:body?.textContent.trim()||'',
          input:$('inline-body')?.value||'',error:$('inline-error')?.textContent||'',
          editor:!!$('requirement-inline'),saveDisabled:$('save-inline')?.disabled??true,
          cancelDisabled:$('cancel-inline')?.disabled??true,confirmDisabled:$('confirm').disabled,
          branchDisabled:$('head').disabled,inert:$('preparation-shell').inert,kind:$('kind').value,fileModeVisible:!$('files-target-field').hidden,
          materials:document.querySelectorAll('.material').length,humanNotice:$('understanding').textContent.includes(R.humanNotice),
          scrollTop:scroll.top,scrollBottom:scroll.bottom,footerTop:footer.top,footerBottom:footer.bottom,
          bodyTop:rect?.top??0,bodyBottom:rect?.bottom??0,viewport:innerHeight
        }});
      });
    });
    api.postMessage({type:'rendered',cwd:${JSON.stringify(cwd)},actionReady:true});
  `;
  assert.ok(panel.webview.html.includes(anchor));
  panel.webview.html = panel.webview.html.replace(anchor, `${automation}${anchor}`);
  const probe = async (action = ''): Promise<ActionReport> => {
    const phase = `native-actions-${++sequence}`;
    await panel.webview.postMessage({ type: 'preparationActionProbe', action, phase });
    await waitFor(() => reports.has(phase), phase);
    return reports.get(phase)!;
  };
  const until = async (test: (report: ActionReport) => boolean, label: string): Promise<ActionReport> => {
    const end = Date.now() + 30_000;
    while (true) {
      const report = await probe();
      if (test(report)) return report;
      if (Date.now() > end) throw new Error(`Timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  try {
    await waitFor(() => clientReady, 'native preparation action client');
    await until((report) => report.body === original && !report.confirmDisabled, 'native human requirement');
    const initial = await probe('bottom');
    assert.equal(initial.heading, m().requirements.humanTitle);
    assert.equal(initial.humanNotice, false);
    assert.equal(initial.fileModeVisible, false);
    assert.ok(initial.scrollBottom <= initial.footerTop + 1, 'Footer must not overlap the scrollable preparation');
    assert.ok(initial.bodyTop >= initial.scrollTop - 1 && initial.bodyBottom <= initial.footerTop + 1, 'Requirement body must be readable above the action area');
    assert.ok(initial.footerBottom <= initial.viewport + 1);
    await probe('edit');
    await until((report) => report.editor && !report.saveDisabled, 'native inline editor');
    write = 'fail';
    await probe('save');
    const failed = await until((report) => report.error.includes('Controlled native storage failure') && !report.saveDisabled, 'native failed-save recovery');
    assert.equal(failed.input, revised);
    assert.equal(failed.body, original);
    assert.equal(failed.inert, false);
    assert.equal(saved.understanding?.requirements[0].text, original);
    write = 'pause';
    const saving = await probe('save');
    await waitFor(() => !!release, 'paused native revision');
    assert.equal(saving.saveDisabled, true);
    assert.equal(saving.cancelDisabled, true);
    assert.equal(saving.inert, true);
    assert.equal((await probe('cancel')).editor, true, 'Disabled cancellation must not discard an in-flight save');
    release!(); release = undefined;
    await until((report) => !report.editor && report.body === revised && !report.confirmDisabled, 'native retry saved');
    assert.equal(saved.materials[0].versions[0].text, original);
    assert.equal(saved.understanding?.requirements[0].text, revised);
    await probe('files');
    await waitFor(() => picks === 1, 'cancelled native file picker');
    await until((report) => !report.inert && report.kind === 'branchChanges' && report.body === revised, 'native cancelled picker keeps preparation');
    assert.equal(completed, false);
    await probe('files');
    await waitFor(() => picks === 2, 'selected native files');
    const files = await until((report) => !report.inert && report.kind === 'files' && !report.confirmDisabled, 'native file scope ready');
    assert.equal(files.materials, 1);
    assert.equal(files.fileModeVisible, true);
    assert.equal(files.body, revised);
    assert.equal(completed, false);
    assert.equal(saved.confirmation, undefined);
    write = 'pause';
    const confirming = await probe('confirm');
    await waitFor(() => !!release, 'paused native confirmation');
    assert.equal(confirming.confirmDisabled, true);
    assert.equal(confirming.branchDisabled, true);
    await probe('lateScope');
    release!(); release = undefined;
    const selected = await handle.result;
    assert.equal(selected?.kind, 'files');
    assert.deepEqual(selected?.reviewSet?.files, local.files);
    assert.deepEqual(selected?.requirements?.materials[0], material);
    assert.equal(selected?.requirements?.understanding?.requirements[0].text, revised);
    assert.ok(selected?.requirements && requirementReadiness(selected.requirements, requirementScopeKey(cwd, local)).confirmed);
    return [
      'native human requirements render once and remain fully readable above a non-overlapping action footer',
      'native failed save retains the edit and original state; retry works, while in-flight cancellation is disabled',
      'native local-file selection preserves requirements and waits for fresh confirmation; late scope changes cannot redirect it',
    ];
  } finally { release?.(); subscription.dispose(); handle.dispose(); }
}
