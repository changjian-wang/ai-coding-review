import { m, resolveLanguage } from '../i18n';
import { esc } from './html';
import { documentViewParts } from './documentPanel';
import type { ReviewCenterState } from './reviewCenterState';
import type { WorkbenchFile } from './workbenchPanel';
import { reviewBrand, reviewCenterChrome, reviewStageLabel } from './reviewCenterChrome';

const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

export function reviewCenterView(center: ReviewCenterState, files: readonly WorkbenchFile[], token: string): string {
  const t = m().reviewCenter;
  const document = documentViewParts(true);
  return `<!doctype html><html lang="${resolveLanguage()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${token}'">
  <style>${reviewCenterChrome}
  .shell{height:100%;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;overflow:hidden}
  .contextbar{display:flex;align-items:center;gap:14px;min-height:41px;padding:7px 20px;border-bottom:1px solid var(--review-border);color:var(--review-muted);font-size:10px;min-width:0}
  .contextbar .scope{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #center-boundary{max-width:300px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  #center-model{max-width:180px;overflow:hidden;text-overflow:ellipsis;display:block}
  .workspace{display:grid;grid-template-columns:244px minmax(0,1fr) 354px;min-height:0;overflow:hidden;position:relative}
  .navigator,.inspector{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--review-surface)}
  .navigator{border-right:1px solid var(--review-border)}
  .inspector{border-left:1px solid var(--review-border)}
  .navigator-head{padding:15px 12px 12px}
  .navigator-heading{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px;font-size:11px;font-weight:550}
  .navigator-heading small{font-size:10px;font-weight:400;color:var(--review-muted)}
  .tabs{display:flex;gap:3px;padding:3px;border:1px solid var(--review-border);border-radius:5px;background:var(--review-canvas)}
  .tabs button{flex:1;min-height:27px;padding:5px 4px;border:0;background:transparent;color:var(--review-muted);font-size:10px;white-space:nowrap}
  .tabs button.active{background:var(--review-accent-soft);color:var(--review-accent)}
  .nav-count{font-size:9px;opacity:.85}
  .navigator-head input{width:100%;margin-top:12px;padding:7px 9px;border:1px solid var(--review-border);border-radius:4px;background:var(--review-canvas);font-size:11px}
  .list{flex:1;min-height:0;overflow:auto;position:relative;padding:0 9px}
  .nav-row{display:block;width:100%;height:80px;padding:10px 9px;text-align:left;border:1px solid transparent;border-radius:5px;background:transparent;overflow:hidden}
  .nav-row:hover{background:var(--vscode-list-hoverBackground)}
  .nav-row.active{background:var(--review-accent-soft);border-color:var(--review-accent-border)}
  .nav-row strong{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:11px;font-weight:500;line-height:1.7}
  .nav-row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--review-muted);font-size:9px;line-height:1.7}
  .nav-row .badge{border:0;background:transparent;padding:0;margin-top:2px;color:var(--review-accent)}
  .nav-row.error .badge{color:var(--vscode-errorForeground)}
  .nav-row.warning .badge{color:var(--vscode-editorWarning-foreground)}
  .empty{padding:24px 12px;color:var(--review-muted);font-size:11px;line-height:1.9;overflow-wrap:anywhere}
  .empty h3{color:var(--vscode-foreground);margin-bottom:9px}
  .navigator-foot{padding:12px;border-top:1px solid var(--review-border);background:var(--review-subtle)}
  .navigator-foot>button{display:flex;width:100%;justify-content:flex-start;background:transparent;border-color:transparent;font-size:11px}
  .navigator-foot details{margin-top:8px;color:var(--review-muted);font-size:10px}
  .navigator-foot details button{margin-top:6px}
  .main{min-width:0;min-height:0;position:relative;background:var(--review-canvas)}
  #source-main{height:100%;display:grid;grid-template-rows:36px minmax(0,1fr)}
  .source-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 16px;border-bottom:1px solid var(--review-border);background:var(--review-subtle);font-size:10px;color:var(--review-muted);min-width:0}
  .source-heading strong{font-weight:500;color:var(--vscode-foreground);flex:none}
  #source-finding{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #review-source{width:100%;height:100%;min-height:0}
  .source-placeholder{position:absolute;inset:36px 0 0;display:grid;place-items:center;padding:24px;background:var(--review-canvas);color:var(--review-muted);text-align:center}
  .inspector-head{padding:14px 17px 12px;border-bottom:1px solid var(--review-border)}
  .inspector-head>.row{justify-content:space-between;gap:8px;font-size:11px}
  .inspector-head .row button{font-size:10px;background:transparent;border-color:transparent}
  .inspector-head .tabs{margin-top:11px}
  .inspector-head .hint{margin-top:5px}
  .inspector-scroll{flex:1;min-height:0;overflow:auto;padding:18px}
  .inspector-scroll h2{font-size:17px;line-height:1.7;margin-bottom:10px}
  .inspector-scroll h3{font-size:11px;margin:19px 0 8px}
  .inspector-scroll p{font-size:11px;line-height:1.9;margin:8px 0;overflow-wrap:anywhere}
  .inspector-subtitle{font-size:10px;color:var(--review-muted);margin-bottom:15px;overflow-wrap:anywhere}
  .inspector-actions,.conclusion-actions{padding:13px 17px;border-top:1px solid var(--review-border);background:var(--review-subtle)}
  .inspector-actions:empty{display:none}
  .inspector-actions button{margin:3px 4px 3px 0}
  .reference-link{display:block;text-align:left;max-width:100%;margin:6px 0;padding:4px 0;min-height:24px;border:0;background:transparent;color:var(--review-accent);font-size:10px;overflow-wrap:anywhere;white-space:normal}
  .reference-card,.rule{padding:11px;margin:10px 0;border:1px solid var(--review-border);border-radius:5px;background:var(--review-subtle);overflow-wrap:anywhere}
  summary{cursor:pointer;color:var(--review-accent)}
  .reference-card summary,.rule summary{font-size:11px}
  .reference-card small{font-size:9px;word-break:break-all;color:var(--review-muted)}
  .reference-card pre,pre{max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:10px;background:var(--vscode-textCodeBlock-background);font:11px/1.8 var(--vscode-editor-font-family)}
  .warning{border-color:var(--vscode-editorWarning-foreground)}
  .notice{padding:10px 12px;margin:10px 0;border-left:2px solid var(--review-accent);background:var(--review-subtle);font-size:11px;overflow-wrap:anywhere}
  .conclusion-main{height:100%;overflow:auto;padding:26px 30px;scrollbar-gutter:stable}
  .conclusion-main .review-card h2{font-size:12px}
  .conclusion-main .review-card>p{font-size:11px;line-height:1.9;overflow-wrap:anywhere}
  .conclusion-main label{display:block;margin:12px 0 7px;font-size:11px}
  .conclusion-main textarea{display:block;width:100%;min-height:280px;resize:vertical;padding:12px;border:1px solid var(--review-border);border-radius:5px;background:var(--vscode-input-background,var(--review-canvas));color:var(--vscode-input-foreground,var(--vscode-foreground));font:12px/1.9 var(--vscode-editor-font-family)}
  .summary-row{display:flex;align-items:flex-start;gap:10px;width:100%;margin-top:6px;padding:10px 0;border-width:1px 0 0;border-radius:0;background:transparent;text-align:left}
  .summary-row:first-of-type{border-top:0}
  .summary-row>span:last-child{flex:1;min-width:0}
  .summary-row strong{display:block;font-size:11px;font-weight:500}
  .summary-row small{display:block;font-size:10px;line-height:1.9;color:var(--review-muted);margin-top:3px;overflow-wrap:anywhere}
  .summary-row .badge{flex:none;max-width:120px}
  .draft-toolbar{justify-content:space-between;margin-bottom:12px}
  #draft-status{font-size:10px;color:var(--review-muted)}
  .draft-preview{padding:16px;border:1px solid var(--review-border);border-radius:5px;margin:12px 0;min-height:240px;background:var(--review-canvas)}
  .comment-preview{padding:12px 0;border-top:1px solid var(--review-border)}
  .comment-preview p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}
  .gate-row{display:flex;gap:9px;padding:11px 0;border-bottom:1px solid var(--review-border);font-size:11px;color:var(--review-muted)}
  .gate-row::before{content:"!";display:grid;place-items:center;width:16px;height:16px;flex:none;border:1px solid currentColor;border-radius:50%;font-size:10px;color:var(--vscode-editorWarning-foreground)}
  .gate-row.ok::before{content:"+";color:var(--review-green)}
  .verdict-options{display:grid;gap:8px;margin:18px 0}
  .verdict-option{display:flex;align-items:flex-start;gap:9px;padding:11px;border:1px solid var(--review-border);border-radius:5px;background:var(--review-subtle);cursor:pointer}
  .verdict-option:has(input:checked){background:var(--review-accent-soft);border-color:var(--review-accent-border)}
  .verdict-option:has(input:disabled){opacity:.55;cursor:not-allowed}
  .verdict-option input{accent-color:var(--vscode-button-background);margin:3px 0 0}
  .verdict-option strong{display:block;font-size:11px;font-weight:500}
  .verdict-option small{display:block;font-size:10px;line-height:1.9;color:var(--review-muted);margin-top:3px}
  #acknowledge-row{display:flex;align-items:flex-start;gap:9px;font-size:11px;line-height:1.9;color:var(--review-muted)}
  #acknowledge-row input{accent-color:var(--vscode-button-background);margin:4px 0 0}
  .conclusion-actions>.primary{width:100%;margin-bottom:8px}
  .prepare-main{height:100%;overflow:auto;padding:32px;max-width:840px;margin:auto}
  .mobile-toggle,.decision-toggle{display:none}
  .shell.prepare .workspace{display:block}
  .shell.prepare .navigator,.shell.prepare .inspector{display:none}
  .shell.focus:not(.conclusion) .workspace{grid-template-columns:minmax(0,1fr) 354px}
  .shell.focus:not(.conclusion) .navigator{display:none}
  @media(max-width:1240px){.workspace{grid-template-columns:220px minmax(0,1fr) 330px}}
  @media(max-width:1120px){.workspace{grid-template-columns:220px minmax(0,1fr)}.inspector{display:none;position:absolute;inset:0 0 0 auto;width:min(354px,94%);z-index:20;box-shadow:-8px 0 22px #0003}.shell.inspector-open .inspector{display:flex}.shell.focus:not(.conclusion) .workspace{grid-template-columns:minmax(0,1fr)}.mobile-inspector,.decision-toggle{display:inline-flex}.brand small{max-width:200px}#center-model{max-width:140px}}
  @media(max-width:690px){.workspace{grid-template-columns:minmax(0,1fr)}.navigator{display:none;position:absolute;inset:0 auto 0 0;width:min(280px,90%);z-index:20;box-shadow:8px 0 22px #0003}.shell.nav-open .navigator{display:flex}.contextbar{padding:7px 10px;gap:7px;flex-wrap:wrap}#center-boundary{max-width:180px}.contextbar .scope{min-width:130px}.conclusion-main{padding:21px 16px}.mobile-nav{display:inline-flex}.inspector-scroll{padding:14px}.shell.focus:not(.conclusion) .navigator{display:none}.summary-row{flex-wrap:wrap}.brand small{max-width:140px}.command-actions{flex-wrap:wrap}#center-model{max-width:125px}}
  [hidden]{display:none!important}
  </style></head><body>
  <div class="shell" id="center-shell">
    <header class="command">${reviewBrand('center-repository')}
    <nav class="stages" aria-label="${esc(t.title)}"><button data-center-action="stage" data-value="prepare">${reviewStageLabel(1, t.prepare)}</button><span class="stage-divider"></span><button data-center-action="stage" data-value="review">${reviewStageLabel(2, t.review)}</button><span class="stage-divider"></span><button data-center-action="stage" data-value="conclusion">${reviewStageLabel(3, t.conclusion)}</button></nav>
    <div class="command-actions"><button data-center-action="model" id="center-model" class="secondary"></button><button data-center-action="language" class="language-button" title="${esc(t.language)}">${esc(t.languageName)}</button><button data-center-action="run" class="primary" id="center-run"></button></div></header>
    <div class="contextbar"><button class="mobile-toggle mobile-nav" id="toggle-nav">${esc(t.navigation)}</button><span class="scope" id="center-scope"></span><span class="badge" id="center-boundary"></span><button data-center-action="focus" class="secondary" id="center-focus">${esc(t.focus)}</button><button class="mobile-toggle mobile-inspector" id="toggle-inspector">${esc(t.inspector)}</button></div>
    <div class="workspace"><aside class="navigator"><div class="navigator-head"><div class="navigator-heading"><span>${esc(t.navigationTitle)}</span><small id="center-file-count"></small></div><div class="tabs" id="center-navigators">${(['business','findings','feedback','files'] as const).map((id) => `<button data-center-action="navigator" data-value="${id}">${esc(t[id])}<span class="nav-count" id="count-${id}"></span></button>`).join('')}</div><input id="center-search" type="search" aria-label="${esc(t.search)}" placeholder="${esc(t.search)}"></div><div class="list" id="center-list"></div><div class="navigator-foot"><button id="center-overview" data-center-action="select" data-kind="overview">${esc(t.overview)}</button><button data-center-action="stage" data-value="prepare">${esc(m().requirements.openPreparation)}</button><button data-center-action="export">${esc(m().workbench.exportReport)}</button><details><summary>${esc(t.moreTools)}</summary><button id="center-legacy-analyze" data-center-action="legacyAnalyze">${esc(m().documentPanel.analyzeFile)}</button><button id="center-legacy-global" data-center-action="legacyGlobal">${esc(m().workbench.globalAnalysis)}</button></details></div></aside>
    <main class="main"><div id="source-main"><div class="source-heading"><strong>${esc(t.sourceScene)}</strong><span id="source-finding"></span></div><div id="review-source"></div><div id="source-placeholder" class="source-placeholder">${esc(t.chooseSource)}</div></div>
    <section id="prepare-main" class="prepare-main" hidden><h1>${esc(t.prepare)}</h1><p>${esc(m().scope.prepareIntro)}</p><button class="primary" data-center-action="stage" data-value="prepare">${esc(m().requirements.openPreparation)}</button><p class="boundary">${esc(t.preparePending)}</p></section>
    <section id="conclusion-main" class="conclusion-main" hidden><div class="eyebrow">${esc(t.conclusionEyebrow)}<span>${esc(t.conclusionHint)}</span></div><h1>${esc(t.conclusionTitle)}</h1><p class="stage-description">${esc(t.conclusionDescription)}</p><div id="conclusion-error" class="notice error-text" hidden></div><button id="check-publication" data-center-action="checkPublication" hidden>${esc(t.checkPublication)}</button>
      <section class="review-card"><div class="section-heading"><h2>${esc(t.openItems)}</h2><span class="badge" id="conclusion-open-count"></span></div><div id="conclusion-open"></div></section>
      <section class="review-card"><h2>${esc(t.dismissedItems)}</h2><div id="conclusion-dismissed"></div></section>
      <section class="review-card"><div class="section-heading"><h2>${esc(t.scopeBoundaryTitle)}</h2><button class="secondary" data-center-action="stage" data-value="prepare">${esc(t.prepare)}</button></div><p id="conclusion-target"></p><p id="conclusion-scope" class="hint"></p><p id="conclusion-requirements" class="hint"></p><p class="boundary">${esc(t.reportBoundary)}</p></section>
      <section class="review-card"><div class="section-heading"><h2>${esc(t.draftTitle)}</h2><button data-center-action="generateDraft" class="secondary">${esc(t.rebuildDraft)}</button></div><div id="draft-form" hidden>
      <div class="row draft-toolbar"><span id="draft-status"></span><div class="row"><button id="show-draft-edit">${esc(t.edit)}</button><button id="show-draft-preview">${esc(t.preview)}</button></div></div>
      <label for="draft-body">${esc(t.body)}</label><textarea id="draft-body" rows="14"></textarea><div class="row" style="margin:10px 0"><button id="save-preview" class="primary">${esc(t.savePreview)}</button><button class="decision-toggle" id="open-conclusion-decision">${esc(t.decisionTitle)}</button></div>
      <article id="draft-preview" class="draft-preview markdown" hidden></article><details><summary>${esc(t.pendingComments)}</summary><div id="draft-comments"></div></details><p class="boundary">${esc(t.bodyDisclosure)}</p>
      </div></section></section></main>
    <aside class="inspector"><div class="inspector-head"><div class="row"><strong id="inspector-heading">${esc(t.context)}</strong><button data-center-action="next" id="next-finding">${esc(t.next)}</button></div><p class="hint" id="judgment-help">${esc(t.judgmentHelp)}</p><div class="tabs" id="inspector-tabs">${(['judgment','evidence','handling'] as const).map((id) => `<button data-center-action="inspector" data-value="${id}">${esc(t[id])}</button>`).join('')}</div></div>
      <div class="inspector-scroll" id="center-inspector"><h2 id="inspector-title"></h2><div class="inspector-subtitle" id="inspector-subtitle"></div><div id="inspector-notice" class="notice warning" hidden></div><div id="inspector-body"></div>
      <div id="conclusion-decision" hidden><select id="draft-verdict" aria-label="${esc(t.verdict)}" hidden><option value="comment">${esc(m().conclusion.comment)}</option><option value="request-changes">${esc(m().conclusion.requestChanges)}</option><option value="approve">${esc(m().conclusion.approve)}</option></select>
      <div class="verdict-options" role="radiogroup" aria-label="${esc(t.verdict)}">${(['approve','request-changes','comment'] as const).map((verdict) => `<label class="verdict-option"><input type="radio" name="draft-verdict-choice" value="${verdict}"><span><strong>${esc(verdict === 'approve' ? m().conclusion.approve : verdict === 'request-changes' ? m().conclusion.requestChanges : m().conclusion.comment)}</strong><small>${esc(verdict === 'approve' ? t.approveHint : verdict === 'request-changes' ? t.requestChangesHint : t.commentHint)}</small></span></label>`).join('')}</div>
      <label id="acknowledge-row"><input type="checkbox" id="acknowledge-report"><span>${esc(t.acknowledgeReport)}</span></label></div></div>
      <div class="inspector-actions" id="inspector-actions"></div><div class="conclusion-actions" id="conclusion-actions" hidden><button id="publish-draft" class="primary"></button><div class="row"><button data-center-action="stage" data-value="review">${esc(t.reopenReview)}</button><button data-center-action="export" class="secondary">${esc(m().workbench.exportReport)}</button></div><p class="hint">${esc(t.submitHint)}</p></div></aside></div>
    <footer class="bottom"><div id="center-notice" class="notice" role="alert" hidden style="width:100%;max-height:90px;overflow:auto;margin:0"><span id="center-notice-text"></span><button id="close-center-notice">${esc(t.close)}</button></div><span id="center-progress"></span><span id="center-tokens" hidden></span><span id="center-status"></span></footer>
  </div>
  <template id="source-template">${document.styles}${document.body}</template>
  <script nonce="${token}">(()=>{const api=acquireVsCodeApi();const saved=api.getState();if(saved?.preparationCwd){const {preparationCwd,...reviewState}=saved;api.setState(reviewState);}const CLIENT=${json(token)};window.__reviewCenterApi=api;window.__reviewCenterClient=CLIENT;window.__reviewDocumentApi={
    getState:()=>api.getState()?.document||{},setState:value=>api.setState({...api.getState(),document:value}),
    postMessage:message=>api.postMessage({type:'document',clientId:CLIENT,message})};
    document.getElementById('review-source').attachShadow({mode:'open'}).append(document.getElementById('source-template').content.cloneNode(true));})();</script>
  <script nonce="${token}">${document.script}</script>
  <script nonce="${token}">
  (()=>{'use strict';
  const api=window.__reviewCenterApi,CLIENT=window.__reviewCenterClient,T=${json(t)},B=${json(m().businessReview)},C=${json(m().conclusion)},W=${json(m().workbench)};
  const $=id=>document.getElementById(id),esc=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  let data=${json(center)},files=${json(files)},request=0,pendingBody,replaceEditor=false,previewMode=false,lastPreviewKey,filter='',rowKind,inspectorContext,inspectorContent,inspectorActions,summaryKey,globalMessage='';
  const persisted=api.getState()?.center||{},buffers=persisted.buffers||{};let editorId;
  function store(){api.setState({...api.getState(),center:{buffers,filter,previewMode}})}
  function draftEdit(){const draft=data.conclusion.draft;if(!draft||editorId!==draft.id)return;return{id:draft.id,revision:draft.revision,body:$('draft-body').value,verdict:$('draft-verdict').value}}
  function dirty(){const d=data.conclusion.draft,e=draftEdit();return!!d&&!!e&&(e.body!==d.body||e.verdict!==d.verdict)}
  function send(action,fields={},bodyOperation=false){const id=++request;const message={type:'center',action,contextKey:data.contextKey,clientId:CLIENT,requestId:id,...fields};
    if((bodyOperation||action==='stage'&&fields.value==='prepare')&&dirty())message.draft=draftEdit();
    if(bodyOperation){pendingBody=id;replaceEditor=action==='appendFinding'||action==='generateDraft';$('draft-body').disabled=true;$('draft-verdict').disabled=true;$('save-preview').disabled=true;updateDraftStatus();}
    api.postMessage(message);return id;}
  function rememberDraft(){const d=data.conclusion.draft;if(d){buffers[d.id]={scope:data.view.scopeKey,body:$('draft-body').value,verdict:$('draft-verdict').value};store()}updateDraftStatus()}
  function updateDraftStatus(){const d=data.conclusion.draft;if(!d)return;$('draft-status').textContent=pendingBody?T.draftPending:dirty()?T.unsavedDraft:T.savedDraft;
    const allowed=d.verdict==='approve'?data.conclusion.canApprove:d.verdict==='request-changes'?data.conclusion.canRequestChanges:data.conclusion.canComment;
    if(data.conclusion.published)$('draft-status').textContent=T.alreadyPublished;
    $('publish-draft').disabled=!!pendingBody||data.conclusion.publishBusy||data.conclusion.stale||data.conclusion.published||!!data.conclusion.unknownAttempt||!data.conclusion.previewCurrent||!previewMode||dirty()||!allowed;syncVerdicts();}
  function syncVerdicts(){document.querySelectorAll('[name="draft-verdict-choice"]').forEach(input=>{input.checked=input.value===$('draft-verdict').value;input.disabled=$('draft-verdict').disabled||!!pendingBody||!!$('draft-verdict').querySelector('[value="'+input.value+'"]').disabled;});}
  function renderSummary(){const state=data.conclusion,key=JSON.stringify([state.openItems,state.dismissedItems,data.scope,data.head,data.base,data.requirementStatus,files.length]);if(key===summaryKey)return;summaryKey=key;
    const rows=(items,empty)=>items.length?items.map(item=>'<button class="summary-row" data-center-action="select" data-kind="'+item.kind+'" data-id="'+esc(item.id)+'"><span class="badge">'+esc(item.badge||'')+'</span><span><strong>'+esc(item.title)+'</strong><small>'+esc(item.summary||item.detail)+'</small></span></button>').join(''):'<p class="hint">'+empty+'</p>';
    $('conclusion-open').innerHTML=rows(state.openItems,T.noOpenItems);$('conclusion-dismissed').innerHTML=rows(state.dismissedItems,T.noDismissedItems);$('conclusion-open-count').textContent=String(state.openItems.length);
    $('conclusion-scope').textContent=data.scope+' · '+T.scopeCount.replace('{0}',String(files.length))+' · head '+data.head+(data.base?' / base '+data.base:'');$('conclusion-requirements').textContent=data.requirementStatus;}
  function renderConclusion(previous){const state=data.conclusion,d=state.draft;renderSummary();$('conclusion-target').textContent=T.target+': '+state.target;
    const error=state.error||(state.unknownAttempt?T.unknownPublication+(state.unknownAttempt.error?' '+state.unknownAttempt.error:''):state.stale?T.draftStale:'');$('conclusion-error').hidden=!error;$('conclusion-error').textContent=error;
    $('check-publication').hidden=!state.unknownAttempt;if(state.unknownAttempt)$('check-publication').dataset.id=state.unknownAttempt.id;
    $('draft-form').hidden=!d;$('conclusion-decision').hidden=data.view.stage!=='conclusion'||!d;$('conclusion-actions').hidden=data.view.stage!=='conclusion'||!d;if(!d)return;
    const first=editorId!==d.id,wasClean=previous?.id===d.id&&$('draft-body').value===previous.body&&$('draft-verdict').value===previous.verdict;
    if(first){editorId=d.id;const buffer=buffers[d.id];$('draft-body').value=buffer?.scope===data.view.scopeKey?buffer.body:d.body;$('draft-verdict').value=buffer?.scope===data.view.scopeKey?buffer.verdict:d.verdict;previewMode=!!persisted.previewMode&&!dirty();}
    else if(wasClean||replaceEditor&&(!previous||d.revision!==previous.revision)){ $('draft-body').value=d.body;$('draft-verdict').value=d.verdict;replaceEditor=false; }
    $('draft-verdict').querySelector('[value="approve"]').disabled=!state.canApprove;
    $('draft-verdict').querySelector('[value="request-changes"]').disabled=!state.canRequestChanges;
    $('draft-verdict').querySelector('[value="comment"]').disabled=!state.canComment;
    $('draft-body').disabled=!!pendingBody||state.published||state.publishBusy;$('draft-verdict').disabled=!!pendingBody||state.published||state.publishBusy;$('save-preview').disabled=!!pendingBody||state.published||state.publishBusy;
    $('acknowledge-row').hidden=!data.view.runId;$('acknowledge-report').checked=state.confirmed;$('acknowledge-report').disabled=data.running||data.analysisBusy||data.runStatus==='stale';
    $('publish-draft').textContent=data.isPr?T.publish:T.saveLocal;
    $('draft-comments').innerHTML=d.comments.length?d.comments.map(c=>'<article class="comment-preview"><strong>'+esc(c.path)+' · L'+c.startLine+'–'+c.endLine+'</strong><p>'+esc(c.body)+'</p></article>').join(''):'<p class="hint">'+T.noPendingComments+'</p>';
    if(state.previewHtml&&d.previewKey){if($('draft-preview').dataset.key!==d.previewKey){$('draft-preview').innerHTML='<p class="boundary">'+T.draftReadOnlyPreview+'</p>'+state.previewHtml;$('draft-preview').dataset.key=d.previewKey;}}
    else{previewMode=false;lastPreviewKey=undefined}
    $('draft-preview').hidden=!previewMode;$('draft-body').hidden=previewMode;
    if(data.view.stage==='conclusion'&&previewMode&&d.previewKey&&!state.stale&&lastPreviewKey!==d.previewKey){const key=d.previewKey;requestAnimationFrame(()=>{if(data.view.stage!=='conclusion'||!previewMode||data.conclusion.stale||data.conclusion.draft?.previewKey!==key||lastPreviewKey===key)return;const preview=$('draft-preview');preview.scrollIntoView({block:'nearest'});const rect=preview.getBoundingClientRect(),main=$('conclusion-main').getBoundingClientRect();if(rect.bottom<=main.top||rect.top>=main.bottom)return;lastPreviewKey=key;send('previewRendered',{id:d.id,revision:d.revision,previewKey:key});});}
    updateDraftStatus();
  }
  function rows(){const query=filter.toLowerCase();let result;
    if(data.view.navigator==='business')result=data.units;else if(data.view.navigator==='findings')result=data.findings;else if(data.view.navigator==='files')result=files.map(f=>({id:f.path,kind:'file',title:f.name||f.path.split('/').pop(),detail:f.path,badge:f.change==='add'?T.added:f.change==='del'?T.deleted:f.change==='role'?T.changed:''})).concat(data.legacy);else result=[];
    return query?result.filter(r=>(r.title+' '+r.detail+' '+r.id).toLowerCase().includes(query)):result;}
  function renderList(){const list=$('center-list');if(data.view.navigator==='feedback'){list.innerHTML='<div class="empty"><h3>'+T.feedbackUnavailable+'</h3><p>'+T.feedbackBoundary+'</p></div>';return}
    const result=rows();if(!result.length){list.innerHTML='<div class="empty">'+(data.view.navigator==='business'?T.emptyBusiness:T.emptyFindings)+'</div>';return}
    const height=80,start=Math.max(0,Math.floor(list.scrollTop/height)-3),end=Math.min(result.length,start+Math.ceil((list.clientHeight||600)/height)+6);
    const active=data.view.selection;list.innerHTML='<div style="height:'+start*height+'px"></div>'+result.slice(start,end).map(r=>'<button class="nav-row '+(r.tone||'')+' '+(r.kind==='file'?data.view.source?.kind==='file'&&data.view.source.path===r.id?'active':'':active.kind===r.kind&&active.id===r.id?'active':'')+'" data-center-action="'+(r.kind==='file'?'file':'select')+'" data-id="'+esc(r.id)+'" data-kind="'+r.kind+'" data-path="'+(r.kind==='file'?esc(r.id):'')+'"><strong>'+esc(r.title)+'</strong><small class="badge">'+esc(r.badge||'')+'</small><small>'+esc(r.detail)+'</small></button>').join('')+'<div style="height:'+(result.length-end)*height+'px"></div>';}
  function inspector(){const item=data.inspector,concluding=data.view.stage==='conclusion';$('inspector-heading').textContent=concluding?T.decisionTitle:T.context;$('inspector-title').textContent=concluding?T.verdict:item.title;$('inspector-subtitle').textContent=concluding?data.status:item.subtitle;
    $('inspector-tabs').hidden=concluding;$('next-finding').hidden=concluding;$('next-finding').disabled=!data.findings.length;$('judgment-help').hidden=concluding;
    const warning=data.viewError||(data.runStatus==='stale'?B.stale:'');$('inspector-notice').hidden=!warning;$('inspector-notice').textContent=warning;
    const html=concluding?(data.conclusion.blockers.length?data.conclusion.blockers.map(reason=>'<div class="gate-row">'+esc(reason)+'</div>').join(''):'<div class="gate-row '+(data.conclusion.canApprove?'ok':'')+'">'+esc(data.conclusion.canApprove?T.decisionReady:B.incomplete)+'</div>')+'<p class="boundary">'+T.reportBoundary+'</p>':item.html;
    const body=$('inspector-body'),context=JSON.stringify([data.view.scopeKey,data.view.runId,data.view.selection,data.view.inspector,data.view.stage]);if(inspectorContext!==context||inspectorContent!==html){const position=inspectorContext===context?$('center-inspector').scrollTop:0;body.innerHTML=html;$('center-inspector').scrollTop=position;inspectorContext=context;inspectorContent=html;}
    const actions=[];if(data.view.stage==='review'){if(item.primaryReference||item.primaryFile)actions.push('<button data-center-action="return">'+T.returnFinding+'</button>');if(item.findingId)actions.push('<button data-center-action="note">'+B.comment+'</button><button data-center-action="appendFinding">'+T.appendFinding+'</button>');if(item.legacy||item.canFix)actions.push('<button data-center-action="fix">'+T.fix+'</button>');}
    const controls=actions.join('');if(inspectorActions!==controls){$('inspector-actions').innerHTML=controls;inspectorActions=controls;}}
  function paint(previous){const shell=$('center-shell');shell.classList.toggle('prepare',data.view.stage==='prepare');shell.classList.toggle('conclusion',data.view.stage==='conclusion');shell.classList.toggle('focus',data.view.focus);
    $('source-main').hidden=data.view.stage!=='review';$('prepare-main').hidden=data.view.stage!=='prepare';$('conclusion-main').hidden=data.view.stage!=='conclusion';
    $('center-repository').textContent=data.repository;$('center-repository').title=data.repository;$('center-scope').textContent=data.scope+' · '+data.head.slice(0,12)+(data.base?' / '+data.base.slice(0,12):'');$('center-scope').title=data.scope+' · head '+data.head+(data.base?' / base '+data.base:'');$('center-boundary').textContent=data.requirementStatus;$('center-boundary').title=data.requirementStatus;
    $('center-model').textContent=T.model+': '+data.model;$('center-model').title=data.model;$('center-run').textContent=data.running?T.cancel:T.start;$('center-run').title=data.running?B.cancel:B.start;$('center-run').dataset.centerAction=data.running?'cancel':'run';
    $('center-file-count').textContent=T.scopeCount.replace('{0}',String(files.length));$('count-business').textContent=String(data.units.length);$('count-findings').textContent=String(data.findings.length);$('count-files').textContent=String(files.length);$('count-feedback').textContent='';$('source-finding').textContent=data.inspector.findingId?data.inspector.title:'';$('source-finding').title=data.inspector.findingId?data.inspector.title:'';$('center-focus').hidden=data.view.stage==='conclusion';
    $('center-run').disabled=!data.running&&data.analysisBusy;$('center-legacy-analyze').disabled=data.running||data.analysisBusy||data.view.source?.kind!=='file';
    $('center-legacy-global').disabled=data.running||data.analysisBusy&&!data.globalRunning;$('center-legacy-global').textContent=data.globalRunning?W.cancel:W.globalAnalysis;
    $('center-overview').setAttribute('aria-pressed',String(data.view.selection.kind==='overview'));$('center-tokens').hidden=!data.tokens;$('center-tokens').textContent=data.tokens?.label||'';$('center-tokens').title=data.tokens?.tooltip||'';
    document.querySelectorAll('.stages [data-center-action="stage"]').forEach(b=>{const active=b.dataset.value===data.view.stage;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','step');else b.removeAttribute('aria-current');});
    document.querySelectorAll('[data-center-action="navigator"]').forEach(b=>b.classList.toggle('active',b.dataset.value===data.view.navigator));
    document.querySelectorAll('[data-center-action="inspector"]').forEach(b=>b.classList.toggle('active',b.dataset.value===data.view.inspector));
    if(rowKind!==data.view.navigator){$('center-list').scrollTop=0;rowKind=data.view.navigator}renderList();inspector();renderConclusion(previous);
    $('center-progress').textContent=globalMessage||data.progress;$('center-status').textContent=data.status;}
  $('center-search').value=filter=persisted.filter||'';$('center-search').addEventListener('input',event=>{filter=event.target.value;$('center-list').scrollTop=0;store();renderList()});
  $('center-list').addEventListener('scroll',()=>requestAnimationFrame(renderList));
  $('toggle-nav').addEventListener('click',()=>{$('center-shell').classList.remove('inspector-open');$('center-shell').classList.toggle('nav-open');});
  $('toggle-inspector').addEventListener('click',()=>{$('center-shell').classList.remove('nav-open');$('center-shell').classList.toggle('inspector-open');});
  $('open-conclusion-decision').addEventListener('click',()=>{$('center-shell').classList.remove('nav-open');$('center-shell').classList.add('inspector-open');});
  document.querySelectorAll('[name="draft-verdict-choice"]').forEach(input=>input.addEventListener('change',()=>{$('draft-verdict').value=input.value;rememberDraft();}));
  $('draft-body').addEventListener('input',rememberDraft);$('draft-verdict').addEventListener('change',rememberDraft);
  $('save-preview').addEventListener('click',()=>{previewMode=false;send('savePreview',{draft:draftEdit()},true)});
  $('show-draft-edit').addEventListener('click',()=>{previewMode=false;$('draft-preview').hidden=true;$('draft-body').hidden=false;store();updateDraftStatus()});
  $('show-draft-preview').addEventListener('click',()=>{if(dirty()){$('conclusion-error').hidden=false;$('conclusion-error').textContent=T.previewRequired;return}previewMode=true;renderConclusion(data.conclusion.draft);store()});
  $('acknowledge-report').addEventListener('change',event=>send('confirmReport',{value:String(event.target.checked)}));
  $('publish-draft').addEventListener('click',()=>{if($('publish-draft').disabled)return;send('publish',{id:data.conclusion.draft.id,revision:data.conclusion.draft.revision,previewKey:data.conclusion.draft.previewKey},true)});
  document.addEventListener('click',event=>{const button=event.target.closest('[data-center-action]');if(!button||button.disabled)return;
    const action=button.dataset.centerAction,fields={id:button.dataset.id,kind:button.dataset.kind,value:button.dataset.value,path:button.dataset.path};
    if(action==='return'){if(data.inspector.primaryReference){send('reference',{id:data.inspector.primaryReference})}else if(data.inspector.primaryFile){send('file',{path:data.inspector.primaryFile.path})}return}
    if(action==='note')fields.id=data.inspector.findingId;if(action==='fix'){fields.id=data.inspector.legacy?.id||data.inspector.findingId;fields.path=data.inspector.legacy?.path}
    if(action==='appendFinding')fields.id=data.inspector.findingId;
    send(action,fields,action==='appendFinding'||action==='generateDraft');if(action==='select'||action==='file')$('center-shell').classList.remove('nav-open');});
  window.addEventListener('message',event=>{const message=event.data;
    if(message.type==='centerState'){const previous=data.conclusion.draft;if(data.contextKey!==message.center.contextKey){pendingBody=undefined;replaceEditor=false;previewMode=false;lastPreviewKey=undefined}if(data.view.scopeKey!==message.center.view.scopeKey){filter='';$('center-search').value=''}data=message.center;if(message.files)files=message.files;for(const change of message.fileChanges||[]){const current=files.find(f=>f.path===change.path);if(current)Object.assign(current,change)}paint(previous);}
    else if(message.type==='centerResult'&&message.clientId===CLIENT&&message.contextKey===data.contextKey){if(pendingBody!==undefined&&pendingBody===message.requestId){pendingBody=undefined;if(message.error){replaceEditor=false;previewMode=false;}else if(message.preview)previewMode=true;renderConclusion(data.conclusion.draft);if(message.error){$('conclusion-error').hidden=false;$('conclusion-error').textContent=message.error;}store();}else if(message.requestId===undefined&&message.preview){previewMode=true;renderConclusion(data.conclusion.draft);store();}if(message.error){$('center-notice').hidden=false;$('center-notice-text').textContent=message.error;}}
    else if(message.type==='sourceStatus'){const empty=$('source-placeholder');empty.hidden=!message.loading&&!message.empty;empty.textContent=message.error||message.title||T.chooseSource;}
    else if(message.type==='notice'){ $('center-notice').hidden=false;$('center-notice-text').textContent=message.message||''; }
    else if(message.type==='focusSource'){const content=$('review-source').shadowRoot.getElementById('content');content.tabIndex=-1;content.focus({preventScroll:true});}
    else if(message.type==='focusTree'){$('center-shell').classList.add('nav-open');if(data.view.focus)send('focus',{value:'false'});setTimeout(()=>$('center-search').focus(),100);}
    else if(message.type==='globalProgress'){globalMessage=message.active?message.message:'';$('center-progress').textContent=globalMessage||data.progress;}
    else if(message.type==='busy'){ $('center-status').textContent=message.message||''; }});
  window.addEventListener('keydown',event=>{if(event.key!=='F8'||event.composedPath().some(el=>el?.tagName==='INPUT'||el?.tagName==='TEXTAREA'||el?.isContentEditable))return;event.preventDefault();send('next')});
  $('close-center-notice').addEventListener('click',()=>$('center-notice').hidden=true);window.addEventListener('resize',()=>requestAnimationFrame(renderList));
  paint();send('ready');api.postMessage({type:'centerRendered',clientId:CLIENT,columns:document.querySelectorAll('.workspace>aside,.workspace>main').length,stage:data.view.stage,sourceShadow:!!$('review-source').shadowRoot});
  })();</script></body></html>`;
}
