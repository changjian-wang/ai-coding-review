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
  inspectorUncovered: boolean;
  tabsUncovered: boolean;
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
  const run = session.businessReview!;
  run.units[0].goal = 'Validate end-to-end UI test baselines, cross-browser visual snapshots and assertion-tool contracts';
  const lastPath = 'tests/e2e/visual.spec.ts-snapshots/detail-paragraphs-content-understanding-chrome-win32-14.png';
  run.units[0].files.push(...Array.from({ length: 15 }, (_, i) => lastPath.replace('-14.png', `-${i}.png`)));
  session.setWorkspaceView({ selection: { kind: 'unit', id: run.units[0].id }, inspector: 'judgment' });
  const center = buildReviewCenterState(session, {
    running: false, publishBusy: false, model: 'Controlled scroll fixture', language: resolveLanguage(),
  });
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
    if (message.type === 'document' && message.message?.type === 'analyze') analysisRequests++;
  });
  const automation = `
    window.addEventListener('message',async event=>{
      const message=event.data;if(message.type!=='sourceScrollProbe')return;
      const host=document.getElementById('review-source'),root=host.shadowRoot,scroll=root.getElementById('content');
      const analyze=root.getElementById('act-analyze');let optimisticBusy=false,scopeReadOnly=true;
      if(message.id===1){
        analyze.click();optimisticBusy=analyze.disabled;
        const stage=document.querySelector('.stages [aria-current="step"]')?.dataset.value;
        document.getElementById('show-current-scope').click();
        const dialog=document.getElementById('scope-dialog');
        scopeReadOnly=dialog.open&&dialog.querySelectorAll('li').length>0&&!dialog.querySelector('input,textarea,select,[data-center-action]');
        document.getElementById('close-scope-dialog').click();
        scopeReadOnly=scopeReadOnly&&!dialog.open&&stage===document.querySelector('.stages [aria-current="step"]')?.dataset.value;
      }
      if(message.mode)host.style.width=message.width?message.width+'px':'';
      const inspector=document.querySelector('.inspector'),details=document.getElementById('center-inspector');
      if(getComputedStyle(inspector).display==='none')document.getElementById('toggle-inspector').click();
      const previous=details.scrollTop;
      if(message.mode){root.getElementById(message.mode==='diff'?'m-diff':'m-file').click();scroll.scrollTop=message.top;scroll.scrollLeft=message.left;}
      const sourceTop=scroll.scrollTop,sourceLeft=scroll.scrollLeft;
      if(message.reference)details.scrollTop=details.scrollHeight;
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const main=document.querySelector('.main').getBoundingClientRect(),source=host.getBoundingClientRect(),content=scroll.getBoundingClientRect();
      const title=document.getElementById('inspector-title').getBoundingClientRect(),edge=inspector.getBoundingClientRect();
      const tab=document.querySelector('#inspector-tabs button'),tabRect=tab.getBoundingClientRect();
      const toolbar=[root.getElementById('fname'),...root.querySelectorAll('.topbar button')].filter(element=>element.getClientRects().length);
      const hit=document.elementFromPoint(edge.left+24,Math.min(title.top+8,edge.bottom-20));
      const tabHit=document.elementFromPoint(tabRect.left+tabRect.width/2,tabRect.top+tabRect.height/2);
      let referenceClickable=false;
      if(message.reference){
        const links=[...document.querySelectorAll('#inspector-body .reference-link')],link=links.at(-1),rect=link.getBoundingClientRect();
        const target=document.elementFromPoint(rect.left+Math.min(20,rect.width/2),rect.top+rect.height/2);
        referenceClickable=!!target&&target.closest('.reference-link')===link;if(referenceClickable)link.click();
      }
      window.__reviewCenterApi.postMessage({type:'sourceScrollReport',report:{
        id:message.id,mode:message.mode||'',sourceLeft:source.left,sourceRight:source.right,sourceWidth:source.width,
        preparationEntries:document.querySelectorAll('[data-center-action="stage"][data-value="prepare"]').length,
        exportEntries:document.querySelectorAll('[data-center-action="export"]').length,
        recheckEntries:root.querySelectorAll('#act-analyze').length,scopeReadOnly,optimisticBusy,recheckBlocked:analyze.disabled,
        contentRight:content.right,contentBottom:content.bottom,contentHeight:content.height,mainLeft:main.left,mainRight:main.right,mainBottom:main.bottom,
        scrollTop:scroll.scrollTop,scrollLeft:scroll.scrollLeft,horizontalRange:scroll.scrollWidth-scroll.clientWidth,
        diffRows:root.querySelectorAll('.diff-row').length,inspectorUncovered:!!hit?.closest('.inspector'),
        tabsUncovered:!!tabHit?.closest('#inspector-tabs'),
        independent:message.reference?scroll.scrollTop===sourceTop&&scroll.scrollLeft===sourceLeft:details.scrollTop===previous,
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
  panel.webview.html = reviewCenterView(center, files, token).replace('</body>', `<script nonce="${token}">${automation}</script></body>`);
  const probe = async (input: { mode?: 'diff' | 'file'; width?: number; top?: number; left?: number; reference?: boolean }): Promise<ScrollReport> => {
    const id = reports.size + 1;
    await panel.webview.postMessage({ type: 'sourceScrollProbe', id, ...input });
    await waitFor(() => reports.has(id), 'native source scroll geometry');
    return reports.get(id)!;
  };
  try {
    await waitFor(() => loaded || error !== undefined, 'native long-source render');
    assert.equal(error, undefined);
    const chrome = await probe({});
    assert.equal(chrome.preparationEntries, 1);
    assert.equal(chrome.exportEntries, 1);
    assert.equal(chrome.recheckEntries, 1);
    assert.equal(chrome.scopeReadOnly, true, 'Scope details must be a read-only modal that does not change the stage');
    assert.equal(chrome.optimisticBusy, false, 'A refused/undelivered analysis action must not leave the source button permanently busy');
    await waitFor(() => analysisRequests === 1, 'single contextual source action');
    assert.equal(preparationRequests, 0, 'Opening scope details must not navigate to preparation');
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
          assert.ok(report.inspectorUncovered && report.tabsUncovered, 'Code must not paint over the inspector or its tabs');
          assert.equal(report.independent, true);
          assert.equal(report.diffRows > 0, mode === 'diff');
          assert.equal(report.toolbarContained, true, 'Source controls must wrap instead of being clipped');
          if (width) assert.ok(Math.abs(report.sourceWidth - width) <= 1, 'The narrow-source regression must exercise a 320px pane');
          if (top) assert.ok(report.scrollTop > 0, 'Vertical source scrolling must move the viewport');
          if (left) assert.ok(report.scrollLeft > 0, 'Horizontal source scrolling must move the viewport');
        }
      }
    }
    const reference = await probe({ reference: true });
    assert.equal(reference.independent, true, 'Inspector scrolling must not move the code viewport');
    assert.equal(reference.referenceClickable, true, 'Long file references must remain visible and clickable');
    await waitFor(() => selectedPath === lastPath, 'native inspector reference action after scrolling');
    return [
      'native full-width/320px source file/diff scrolling stays inside the middle column, with visible controls and unobscured inspector text/tabs',
      'native source and inspector scroll independently; the long-path reference remains clickable after scrolling',
      'native center has one preparation/export/source-recheck entry; scope details stay read-only and host-controlled source busy state recovers without optimistic stuck loading',
    ];
  } finally {
    subscription.dispose();
    panel.dispose();
    session.dispose();
  }
}
