import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { businessHash } from '../review/businessReview';
import { buildReviewCenterState } from '../ui/reviewCenterState';
import { reviewCenterView } from '../ui/reviewCenterView';
import { esc } from '../ui/html';
import type { DocDiffLine, DocModel } from '../ui/documentPanel';
import { resolveLanguage } from '../i18n';
import { reviewCenterFixture } from './reviewCenterFixture';

interface ScrollReport {
  id: number;
  mode: string;
  sourceLeft: number;
  sourceRight: number;
  sourceWidth: number;
  contentRight: number;
  contentBottom: number;
  contentHeight: number;
  mainLeft: number;
  mainRight: number;
  mainBottom: number;
  scrollTop: number;
  scrollLeft: number;
  horizontalRange: number;
  diffRows: number;
  judgmentAboveSource: boolean;
  sourceInitiallyClosed: boolean;
  sourceClosed: boolean;
  workspaceColumns: number;
  judgmentFullWidth: boolean;
  issueContentVisible: boolean;
  judgmentText: string;
  pendingVisible: boolean;
  dismissedVisible: boolean;
  independent: boolean;
  referenceClickable: boolean;
  toolbarContained: boolean;
  placeholderHidden: boolean;
  preparationEntries: number;
  exportEntries: number;
  recheckEntries: number;
  scopeReadOnly: boolean;
  optimisticBusy: boolean;
  recheckBlocked: boolean;
  modelTooltip: string;
}

async function waitFor(test: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 30_000;
  while (!test()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function runSourceScrollHostChecks(): Promise<string[]> {
  const { session } = await reviewCenterFixture();
  session.recordTokenUsage({ op: 'business', input: 12_345, output: 123 });
  const run = session.businessReview!;
  const finding = run.findings[0];
  run.findings.push({ ...structuredClone(finding), id: 'dismissed-control', status: 'dismissed', kind: 'reasonable' });
  const lastPath = 'tests/e2e/visual.spec.ts-snapshots/detail-paragraphs-content-understanding-chrome-win32-14.png';
  session.reviewSet!.files.push(...Array.from({ length: 15 }, (_, i) => ({
    path: lastPath.replace('-14.png', `-${i}.png`), context: true,
  })));
  session.setWorkspaceView({ navigator: 'findings', selection: { kind: 'finding', id: finding.id }, inspector: 'judgment' });
  const input = {
    running: false, publishBusy: false, model: 'Controlled scroll fixture', language: resolveLanguage(),
  };
  const center = buildReviewCenterState(session, input);
  const raw = Array.from({ length: 400 }, (_, i) =>
    `export const sourceLine${i} = "${'controlled-long-source-value/'.repeat(i % 7 === 0 ? 45 : 3)}";`);
  const model: DocModel = {
    path: 'src/restore.ts', name: 'ContentUnderstandingResultViewerWithAnExtremelyLongDescriptiveComponentName.tsx', revision: businessHash(raw.join('\n')),
    sourceDescription: 'Controlled immutable source for native scroll layout regression',
    isMarkdown: false, raw, sourceLines: raw.map(esc), defaultToDiff: true,
    diffLines: raw.map((_, i): DocDiffLine => ({
      kind: i % 31 === 0 ? 'added' : 'context', oldLine: i + 1, newLine: i + 1,
    })),
    seen: [], findings: [], annotations: [], analyzing: false, readOnly: false,
  };
  const token = 'source-scroll-layout-test';
  const panel = vscode.window.createWebviewPanel('codereview.sourceScrollTest', 'Source scroll layout',
    vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  let loaded = false;
  let error: string | undefined;
  let selectedPath: string | undefined;
  let analysisRequests = 0;
  let preparationRequests = 0;
  const reports = new Map<number, ScrollReport>();
  const subscription = panel.webview.onDidReceiveMessage((message: {
    type: string;
    message?: { type: string; message?: string };
    action?: string;
    value?: string;
    path?: string;
    report?: ScrollReport;
  }) => {
    if (message.type === 'document' && message.message?.type === 'ready') {
      void panel.webview.postMessage({ type: 'document', message: { type: 'load', requestId: 1, model } });
    }
    if (message.type === 'document' && message.message?.type === 'loaded') {
      loaded = true;
      void panel.webview.postMessage({ type: 'sourceStatus', title: model.name });
    }
    if (message.type === 'document' && message.message?.type === 'loadError') error = message.message.message;
    if (message.type === 'sourceScrollReport' && message.report) reports.set(message.report.id, message.report);
    if (message.type === 'center' && message.action === 'file') selectedPath = message.path;
    if (message.type === 'center' && message.action === 'stage') preparationRequests++;
    if (message.type === 'center' && message.action === 'navigator'
      && (message.value === 'files' || message.value === 'findings')) {
      session.setWorkspaceView({ navigator: message.value });
      void panel.webview.postMessage({ type: 'centerState', center: buildReviewCenterState(session, input) });
    }
    if (message.type === 'document' && message.message?.type === 'analyze') analysisRequests++;
  });
  const automation = `
    window.addEventListener('message',async event=>{
      const message=event.data;if(message.type!=='sourceScrollProbe')return;
      const host=document.getElementById('review-source'),root=host.shadowRoot,scroll=root.getElementById('content'),pane=document.getElementById('source-main'),mainElement=document.querySelector('.main');
      const inspector=document.querySelector('.inspector');
      const sourceInitiallyClosed=!pane.open,initialJudgment=inspector.getBoundingClientRect();
      const judgmentFullWidth=Math.abs(mainElement.clientWidth-initialJudgment.width)<=2;
      const workspaceColumns=getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns.split(' ').length;
      const analyze=root.getElementById('act-analyze');let optimisticBusy=false,scopeReadOnly=true;
      if(message.id===1){
        const stage=document.querySelector('.stages [aria-current="step"]')?.dataset.value;
        document.getElementById('show-current-scope').click();
        const dialog=document.getElementById('scope-dialog');
        scopeReadOnly=dialog.open&&dialog.querySelectorAll('li').length>0&&!dialog.querySelector('input,textarea,select,[data-center-action]');
        document.getElementById('close-scope-dialog').click();
        scopeReadOnly=scopeReadOnly&&!dialog.open&&stage===document.querySelector('.stages [aria-current="step"]')?.dataset.value;
      }
      if(message.action==='closed')document.querySelector('[data-lens="closed"]').click();
      if(message.action==='pending')document.querySelector('[data-lens="open"]').click();
      if(message.mode)host.style.width=message.width?message.width+'px':'';
      if(message.action==='back'){pane.scrollIntoView({block:'start'});document.getElementById('back-to-judgment').click();}
      else if(!message.reference){pane.open=true;pane.scrollIntoView({block:'end'});}
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const previous=mainElement.scrollTop;
      if(message.id===1){analyze.click();optimisticBusy=analyze.disabled;}
      if(message.mode){root.getElementById(message.mode==='diff'?'m-diff':'m-file').click();scroll.scrollTop=message.top;scroll.scrollLeft=message.left;}
      const sourceTop=scroll.scrollTop,sourceLeft=scroll.scrollLeft;
      if(message.reference){const search=document.getElementById('center-search');search.value=${JSON.stringify(lastPath)};search.dispatchEvent(new Event('input',{bubbles:true}));}
      const link=message.reference?document.querySelector('#center-list .nav-row[data-path]'):undefined;
      if(link)link.scrollIntoView({block:'center'});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const main=mainElement.getBoundingClientRect(),source=host.getBoundingClientRect(),content=scroll.getBoundingClientRect(),edge=inspector.getBoundingClientRect(),paneRect=pane.getBoundingClientRect();
      const toolbar=[root.getElementById('fname'),...root.querySelectorAll('.topbar button')].filter(element=>element.getClientRects().length);
      let referenceClickable=false;
      if(link){
        const rect=link.getBoundingClientRect();
        const target=document.elementFromPoint(rect.left+Math.min(20,rect.width/2),rect.top+rect.height/2);
        referenceClickable=!!target&&target.closest('.nav-row')===link;if(referenceClickable)link.click();
      }
      window.__reviewCenterApi.postMessage({type:'sourceScrollReport',report:{
        id:message.id,mode:message.mode||'',sourceLeft:source.left,sourceRight:source.right,sourceWidth:source.width,
        preparationEntries:document.querySelectorAll('[data-center-action="stage"][data-value="prepare"]').length,
        exportEntries:document.querySelectorAll('[data-center-action="export"]').length,
        sourceInitiallyClosed,sourceClosed:!pane.open,workspaceColumns,judgmentFullWidth,judgmentText:inspector.innerText,
        issueContentVisible:inspector.innerText.includes(${JSON.stringify(finding.impact)})&&inspector.innerText.includes(${JSON.stringify(finding.trigger)})&&inspector.innerText.includes('await order.restore();'),
        pendingVisible:!!document.querySelector('#center-list [data-id="'+${JSON.stringify(finding.id)}+'"]'),
        dismissedVisible:!!document.querySelector('#center-list [data-id="dismissed-control"]'),
        recheckEntries:root.querySelectorAll('#act-analyze').length,scopeReadOnly,optimisticBusy,recheckBlocked:analyze.disabled,
        modelTooltip:document.getElementById('center-model').title,
        contentRight:content.right,contentBottom:content.bottom,contentHeight:content.height,mainLeft:main.left,mainRight:main.right,mainBottom:main.bottom,
        scrollTop:scroll.scrollTop,scrollLeft:scroll.scrollLeft,horizontalRange:scroll.scrollWidth-scroll.clientWidth,
        diffRows:root.querySelectorAll('.diff-row').length,judgmentAboveSource:edge.bottom<=paneRect.top+1,
        independent:message.reference?scroll.scrollTop===sourceTop&&scroll.scrollLeft===sourceLeft:mainElement.scrollTop===previous,
        referenceClickable,placeholderHidden:document.getElementById('source-placeholder').hidden,
        toolbarContained:toolbar.every(element=>{const rect=element.getBoundingClientRect();return rect.left>=source.left-1&&rect.right<=source.right+1;})
      }});
    });
  `;
  const files = session.reviewSet!.files.map((file) => ({
    path: file.path, name: file.path.split('/').pop()!, dir: file.path.split('/').slice(0, -1).join('/'),
    seen: 0, total: raw.length, analyzed: false, ready: false, fullySeen: false, unconfirmed: 0, findings: 0,
    active: file.path === model.path, analyzing: false,
  }));
  const html = reviewCenterView(center, files, token);
  const restoreAnchor = 'const saved=api.getState();';
  assert.ok(html.includes(restoreAnchor));
  panel.webview.html = html.replace(restoreAnchor,
    `api.setState({...api.getState(),center:{...api.getState()?.center,sourceOpen:true,sourceKey:${JSON.stringify(center.contextKey)}}});${restoreAnchor}`)
    .replace('</body>', `<script nonce="${token}">${automation}</script></body>`);
  const probe = async (input: { mode?: 'diff' | 'file'; width?: number; top?: number; left?: number; reference?: boolean; action?: 'back' | 'closed' | 'pending' }): Promise<ScrollReport> => {
    const id = reports.size + 1;
    await panel.webview.postMessage({ type: 'sourceScrollProbe', id, ...input });
    await waitFor(() => reports.has(id), 'native source scroll geometry');
    return reports.get(id)!;
  };
  try {
    await waitFor(() => loaded || error !== undefined, 'native long-source render');
    assert.equal(error, undefined);
    const chrome = await probe({});
    assert.equal(chrome.workspaceColumns, 2, 'The review workspace must be an issue list plus judgment, not three competing panes');
    assert.equal(chrome.sourceInitiallyClosed, true, 'Code must not take over the initial issue view');
    assert.equal(chrome.judgmentFullWidth, true, JSON.stringify(chrome));
    assert.equal(chrome.issueContentVisible, true, 'The default judgment must show actual impact, trigger and code evidence');
    assert.equal(chrome.pendingVisible, true, JSON.stringify(chrome));
    assert.equal(chrome.dismissedVisible, false);
    assert.equal(chrome.preparationEntries, 1);
    assert.equal(chrome.exportEntries, 1);
    assert.equal(chrome.recheckEntries, 1);
    assert.ok(chrome.modelTooltip.includes('12,345'), 'Estimated usage must remain available on the real model control after removing the HUD');
    assert.equal(chrome.scopeReadOnly, true, 'Scope details must be a read-only modal that does not change the stage');
    assert.equal(chrome.optimisticBusy, false, 'A refused/undelivered analysis action must not leave the source button permanently busy');
    await waitFor(() => analysisRequests === 1, 'single contextual source action');
    assert.equal(preparationRequests, 0, 'Opening scope details must not navigate to preparation');
    const closed = await probe({ action: 'closed' });
    assert.equal(closed.pendingVisible, false, JSON.stringify(closed));
    assert.equal(closed.dismissedVisible, true, JSON.stringify(closed));
    const pending = await probe({ action: 'pending' });
    assert.equal(pending.pendingVisible, true, JSON.stringify(pending));
    assert.equal(pending.dismissedVisible, false, JSON.stringify(pending));
    await panel.webview.postMessage({ type: 'document', message: { type: 'analyzing', on: true } });
    assert.equal((await probe({})).recheckBlocked, true, 'Host busy state must disable the shared analysis action');
    await panel.webview.postMessage({ type: 'document', message: { type: 'analyzing', on: false } });
    assert.equal((await probe({})).recheckBlocked, false, 'Completion/cancellation must restore the analysis action');
    for (const width of [undefined, 320]) {
      for (const mode of ['diff', 'file'] as const) {
        for (const [top, left] of [[0, 0], [1400, 0], [2600, 900]]) {
          const report = await probe({ mode, width, top, left });
          assert.ok(report.sourceLeft >= report.mainLeft - 1, JSON.stringify(report));
          assert.ok(report.sourceRight <= report.mainRight + 1 && report.contentRight <= report.mainRight + 1, JSON.stringify(report));
          assert.ok(report.contentBottom <= report.mainBottom + 1, JSON.stringify(report));
          assert.ok(report.contentHeight > 0 && report.placeholderHidden, 'The regression must scroll a visible source viewport');
          assert.ok(report.horizontalRange > 1000, 'Long code must remain horizontally scrollable, not truncated');
          assert.equal(report.judgmentAboveSource, true, 'The optional reader must remain below, not over, the judgment');
          assert.equal(report.independent, true);
          assert.equal(report.diffRows > 0, mode === 'diff');
          assert.equal(report.toolbarContained, true, 'Source controls must wrap instead of being clipped');
          if (width) assert.ok(Math.abs(report.sourceWidth - width) <= 1, 'The narrow-source regression must exercise a 320px pane');
          if (top) assert.ok(report.scrollTop > 0, 'Vertical source scrolling must move the viewport');
          if (left) assert.ok(report.scrollLeft > 0, 'Horizontal source scrolling must move the viewport');
        }
      }
    }
    const back = await probe({ action: 'back' });
    assert.equal(back.sourceClosed, true, 'Returning to the issue must collapse the optional source reader');
    assert.equal(back.issueContentVisible, true, JSON.stringify(back));
    await probe({});
    session.setWorkspaceView({ navigator: 'files' });
    await panel.webview.postMessage({ type: 'centerState', center: buildReviewCenterState(session, input) });
    const reference = await probe({ reference: true });
    assert.equal(reference.independent, true, 'Inspector scrolling must not move the code viewport');
    assert.equal(reference.referenceClickable, true, 'Long file references must remain visible and clickable');
    await waitFor(() => selectedPath === lastPath, 'native inspector reference action after scrolling');
    return [
      'native issues-first layout has two columns, defaults to pending issues and actual judgment/evidence, and keeps code collapsed until requested',
      'native full-width/320px optional source scrolling is contained below the judgment; returning collapses code without losing the issue',
      'native pending/ruled-out issue filters stay distinct; long paths in the real file navigator remain clickable without changing source scroll position',
      'native center has one preparation/export/source-recheck entry; scope details stay read-only and host-controlled source busy state recovers without optimistic stuck loading',
    ];
  } finally {
    subscription.dispose();
    panel.dispose();
    session.dispose();
  }
}
