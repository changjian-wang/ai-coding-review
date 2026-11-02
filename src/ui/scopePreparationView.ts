import { m, resolveLanguage } from '../i18n';
import { esc, nonce } from './html';
import { reviewBrand, reviewCenterChrome, reviewStageLabel } from './reviewCenterChrome';

export function scopePreparationView(defaultCwd: string, initialKind: string, canReturn = false, filesCwd?: string): string {
  const t = m().scope;
  const r = m().requirements;
  const c = m().reviewCenter;
  const token = nonce();
  const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="${resolveLanguage()}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${token}'">
  <style>${reviewCenterChrome}
  .preparation-shell{height:100%;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto auto}
  #model{display:block;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .prepare-scroll{overflow:auto;min-height:0;scrollbar-gutter:stable}
  main{width:min(840px,100%);margin-inline:auto;padding:24px 24px 12px}
  .fields{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:11px 14px}
  label{display:block;min-width:0;font-size:10px;color:var(--review-muted)}
  input:not([type=checkbox]):not([type=radio]),select,textarea{display:block;width:100%;margin-top:5px;padding:7px 9px;border:1px solid var(--review-border);border-radius:4px;background:var(--vscode-input-background,var(--review-canvas));color:var(--vscode-input-foreground,var(--vscode-foreground));font-size:11px;line-height:1.6;min-width:0}
  textarea{min-height:190px;resize:vertical;tab-size:4;font-family:var(--vscode-editor-font-family);line-height:1.9}
  .scope-kind{margin:0;padding:0;border:0;min-width:0}
  .scope-kind legend{font-size:10px;color:var(--review-muted);padding:0;margin-bottom:6px}
  .scope-kind>div{display:flex;gap:6px}
  .scope-kind label{display:flex;align-items:center;justify-content:center;gap:7px;flex:1;padding:7px;border:1px solid var(--review-border);border-radius:4px;background:var(--review-subtle);cursor:pointer;font-size:11px;color:var(--vscode-foreground)}
  .scope-kind label:has(input:checked){border-color:var(--review-accent-border);background:var(--review-accent-soft);color:var(--review-accent)}
  input[type=radio],input[type=checkbox]{accent-color:var(--vscode-button-background);margin:0}
  .scope-wide{grid-column:1/-1}
  #scope-summary{margin-top:12px;font-size:11px;overflow-wrap:anywhere}
  .scope-tools{margin-top:8px;justify-content:space-between}
  .scope-tools>div{display:flex;gap:10px;flex-wrap:wrap}
  details{font-size:10px;line-height:1.9}
  summary{cursor:pointer;color:var(--review-accent)}
  .scope-details{margin-top:9px;padding-top:8px;border-top:1px solid var(--review-border)}
  #scope-files{max-height:180px;overflow:auto;margin:8px 0;padding-left:18px;font-family:var(--vscode-editor-font-family)}
  #source{margin-top:8px}
  #status{display:flex;align-items:center;gap:8px;min-height:22px;margin-top:8px;font-size:11px;color:var(--review-muted)}
  #scope-summary:empty{display:none}
  .select-loading{display:block;position:relative}
  .select-loading select{padding-right:32px;height:34px}
  .select-loading:has(.loading-spinner:not([hidden])) select{appearance:none}
  .select-loading>.loading-spinner{position:absolute;right:11px;top:50%;margin-top:-6px}
  .loading-spinner{display:inline-block;width:12px;height:12px;flex:none;border:1.5px solid var(--review-border);border-top-color:var(--review-accent);border-radius:50%;animation:preparation-spin .8s linear infinite}
  @keyframes preparation-spin{to{transform:rotate(360deg)}}
  @media(prefers-reduced-motion:reduce){.loading-spinner{animation:none;border-color:var(--review-accent);border-style:dotted}}
  .error{padding:9px 11px;margin-top:9px;background:color-mix(in srgb,var(--vscode-errorForeground) 9%,var(--review-canvas));border-left:2px solid var(--vscode-errorForeground);overflow-wrap:anywhere;font-size:11px}
  #materials{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
  #materials:empty{display:none}
  .material{display:flex;align-items:center;gap:8px;max-width:100%;padding:6px 9px;border:1px solid var(--review-border);border-radius:5px;background:var(--review-subtle)}
  .material label{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--vscode-foreground);overflow-wrap:anywhere}
  .material button{font-size:10px;min-height:24px;padding:3px}
  .material .badge{font-size:9px}
  .material-input-actions{margin-bottom:6px}
  .empty-materials{margin-top:8px}
  .evidence-details{margin-top:10px}
  .evidence-details p{margin-top:6px}
  .understanding-intent{padding:0 0 0 10px;border-left:2px solid var(--review-accent-border);font-size:11px;margin:10px 0;color:var(--review-muted)}
  .item{padding:9px 0;border-bottom:1px solid var(--review-border);overflow-wrap:anywhere}
  .understanding-row{display:flex;align-items:flex-start;gap:9px;font-size:11px}
  .understanding-row>div{flex:1;min-width:0}
  .understanding-row h3{font-size:11px;line-height:1.8}
  .understanding-row small{color:var(--review-muted);font-size:10px}
  .understanding-marker{color:var(--review-accent);font-size:14px;line-height:1.7}
  .item.excluded{opacity:.65}
  .understanding-detail{margin:6px 0 0 22px}
  .requirement-text{margin:8px 0 10px 22px;font-size:11px;line-height:1.9}
  #requirement-inline{margin:12px 0}#requirement-inline .actions{margin-top:10px}
  .understanding-detail .markdown{margin-top:7px;font-size:11px}
  .understanding-extras{padding-top:10px;margin-top:10px}
  .understanding-extras h3{font-size:11px;margin-top:10px}
  .understanding-extras p{margin:6px 0}
  .quote,pre{padding:10px;background:var(--vscode-textCodeBlock-background);white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.8 var(--vscode-editor-font-family)}
  #understanding>details{margin-top:10px}
  #requirement-status{font-size:11px;color:var(--review-muted);line-height:1.9}
  .prepare-footer{width:min(840px,100%);margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:12px 24px;background:var(--review-canvas);border-top:1px solid var(--review-border)}
  .prepare-footer>div:first-child{flex:1;min-width:0;max-width:470px}
  .prepare-footer .primary{min-height:36px;font-size:12px}
  .review-mode{margin-top:12px;padding-top:10px;border-top:1px solid var(--review-border)}
  .review-mode label{font-size:11px;color:var(--vscode-foreground)}
  .review-mode p{margin:6px 0 0 22px}
  #files-field p{margin-top:7px}
  dialog{width:min(780px,calc(100vw - 28px));max-height:calc(100vh - 36px);overflow:auto;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface);color:var(--vscode-foreground);padding:22px}
  dialog::backdrop{background:#0008;backdrop-filter:blur(2px)}
  dialog h2{font-size:15px;overflow-wrap:anywhere;margin-bottom:10px}
  dialog label{margin-top:12px}
  dialog .actions{margin-top:10px}
  #preview{min-height:190px;padding:12px;border:1px solid var(--review-border);margin-top:8px;background:var(--review-canvas)}
  .checkbox{display:flex;align-items:flex-start;gap:8px}
  .checkbox input{margin-top:3px}
  .active{color:var(--review-accent)}
  @media(max-width:560px){main{padding:20px 16px 12px}.fields{grid-template-columns:minmax(0,1fr)}.review-card{padding:13px}#status{min-height:40px}.material{flex-wrap:wrap}.prepare-footer{gap:8px;padding:10px 16px}.prepare-footer>.actions{width:100%}.prepare-footer>.actions button{width:100%}.understanding-row{flex-wrap:wrap}.understanding-row .badge{margin-left:22px}}
  </style></head><body>
  <div class="preparation-shell" id="preparation-shell"><header class="command">${reviewBrand('preparation-repository')}
  <nav class="stages" aria-label="${esc(c.title)}"><button class="active" aria-current="step" type="button">${reviewStageLabel(1, c.prepare)}</button><span class="stage-divider"></span><button type="button" id="return-review" ${canReturn ? '' : 'disabled'}>${reviewStageLabel(2, c.review)}</button><span class="stage-divider"></span><button type="button" id="return-conclusion" ${canReturn ? '' : 'disabled'}>${reviewStageLabel(3, c.conclusion)}</button></nav>
  <div class="command-actions"><button id="model" class="secondary" title="${esc(r.chooseModel)}"><span id="model-label">${esc(r.chooseModel)}</span></button><button id="preparation-language" class="language-button" title="${esc(c.language)}">${esc(c.languageName)}</button></div></header>
  <div class="prepare-scroll" id="prepare-scroll"><main>
  <div class="eyebrow">${esc(c.prepareEyebrow)}<span>${esc(c.prepareHint)}</span></div><h1>${esc(t.prepareTitle)}</h1><p class="stage-description">${esc(c.prepareDescription)}</p>
  <section class="review-card"><div class="section-heading"><h2><span class="section-number">1</span>${esc(c.prepareTarget)}</h2></div><div class="fields">
  <label>${esc(t.repository)}<select id="repository" title="${esc(t.browseRepositoryHint)}"></select></label><fieldset class="scope-kind"><legend>${esc(t.target)}</legend><div><label><input id="target-pr" type="radio" name="scope-kind" value="pr" checked>PR</label><label><input id="target-branch" type="radio" name="scope-kind" value="branch">${esc(c.branchTarget)}</label><label id="files-target-field"><input id="target-files" type="radio" name="scope-kind" value="files">${esc(t.fileTarget)}</label></div></fieldset>
  <select id="kind" hidden aria-label="${esc(t.target)}"><option value="pr">${esc(t.prTarget)}</option><option value="branchChanges">${esc(t.branchTarget)}</option><option value="branchFull">${esc(t.fullTarget)}</option><option value="files">${esc(t.fileTarget)}</option></select>
  <label id="pr-field" class="scope-wide">${esc(t.pr)}<span class="select-loading"><select id="pr" aria-describedby="status" disabled></select><span id="pr-spinner" class="loading-spinner" aria-hidden="true" hidden></span></span></label><label id="head-field">${esc(t.branch)}<select id="head"></select></label>
  <label id="scope-mode-field">${esc(c.branchMode)}<select id="scope-mode"><option value="branchChanges">${esc(t.branchTarget)}</option><option value="branchFull">${esc(t.fullTarget)}</option></select></label>
  <label id="base-field" class="scope-wide">${esc(t.base)}<select id="base"></select></label>
  <div id="files-field" class="scope-wide" hidden><button id="files" class="secondary">${esc(t.localFiles)}</button><p class="hint">${esc(t.localFilesHint)}</p></div></div>
  <p id="scope-summary"></p><p id="status" role="status" aria-live="polite"><span id="status-spinner" class="loading-spinner" aria-hidden="true" hidden></span><span id="status-text"></span></p><p id="error" class="error" role="alert" hidden></p>
  <div class="scope-tools actions"><details class="scope-details"><summary>${esc(c.scopeDetails)}</summary><p id="source" class="hint"></p><ul id="scope-files"></ul></details><button id="retry" class="secondary" title="${esc(t.refreshHint)}" disabled>${esc(t.refreshPrs)}</button></div></section>
  <section class="review-card"><div class="section-heading"><h2><span class="section-number">2</span>${esc(c.prepareEvidence)}<small>${esc(c.optional)}</small></h2><span class="badge" id="material-count" hidden></span></div>
  <div class="actions material-input-actions"><button id="paste">${esc(r.paste)}</button><button id="link">${esc(r.link)}</button><button id="file">${esc(r.localFile)}</button><button id="human">${esc(r.addHuman)}</button></div><p class="hint">${esc(c.prepareEvidenceHint)}</p>
  <div id="materials"></div><p id="empty-materials" class="hint empty-materials">${esc(c.emptyMaterials)}</p>
  <div class="review-mode"><label class="checkbox"><input id="technical" type="checkbox" aria-describedby="technical-boundary"><span>${esc(r.technicalMode)}</span></label><p class="hint" id="technical-boundary">${esc(r.technicalBoundary)}</p></div>
  <details class="evidence-details"><summary>${esc(c.evidenceBoundary)}</summary><p class="hint">${esc(r.disclosure)}</p><p class="hint">${esc(r.linkSnapshot)}</p></details></section>
  <section class="review-card"><div class="section-heading"><h2><span class="section-number">3</span><span id="understanding-title">${esc(c.prepareUnderstanding)}</span></h2><span class="badge accent" id="understanding-count" hidden></span></div>
  <p id="requirement-status" role="status">${esc(r.empty)}</p><p id="requirement-error" class="error" role="alert" hidden></p><div id="understanding"></div>
  <div class="actions"><button id="organize" class="secondary">${esc(r.retry)}</button><button id="cancel-analysis" class="secondary" hidden>${esc(r.cancelAnalysis)}</button></div></section>
  </main></div><footer class="prepare-footer" id="prepare-footer"><div><p class="hint" id="prepare-action-hint">${esc(c.technicalActionHint)}</p></div><div class="actions"><button id="confirm" class="primary" disabled>${esc(c.start)}</button></div></footer>
  <footer class="bottom"><span>${esc(c.prepareHint)}</span><span>${esc(c.reportBoundary)}</span></footer></div>
  <dialog id="editor"><form id="material-form"><h2 id="editor-title"></h2><p id="editor-context" class="hint"></p>
  <div id="material-input"><label>${esc(r.name)}<input id="material-name" maxlength="200"></label><label>${esc(r.content)}</label>
  <div class="actions"><button id="edit" class="secondary active" type="button">${esc(r.edit)}</button><button id="preview-button" class="secondary" type="button">${esc(r.preview)}</button></div>
  <textarea id="material-text" rows="9" placeholder="${esc(r.inputPlaceholder)}"></textarea><div id="preview" class="markdown" hidden></div></div>
  <div id="link-input" hidden><label>${esc(r.address)}<input id="material-link" type="url" placeholder="https://…"></label><p class="hint">${esc(r.confirmFetch.replace('{0}', ''))}</p></div>
  <div id="revision-input" hidden><label class="checkbox"><input id="requirement-included" type="checkbox" checked><span>${esc(r.included)}</span></label><label>${esc(r.reason)}<input id="requirement-reason"></label></div>
  <p id="editor-error" class="error" role="alert" hidden></p><div class="actions"><button type="button" id="close-editor" class="secondary">${esc(r.cancel)}</button><button id="save-material" type="submit">${esc(r.save)}</button></div></form></dialog>
  <script nonce="${token}">(()=>{'use strict';const api=acquireVsCodeApi();const T=${json(t)},R=${json(r)},C=${json(c)};const $=id=>document.getElementById(id);let data;let selected=${json(defaultCwd)};let prsLoading=false;let prStatus='idle',prRequest=0,prError='',repositoryError='',scopeSequence=0,browsePending=false,slowTimer,loadingKey='';let repositoryLoading=true;let state={materials:[],ready:false,busy:false,reading:false,scopeReady:false,scopeLoading:false};let editorKind='paste';let editorId;let previewSequence=0;let inlineEdit=api.getState()?.requirementEdit;
  function rememberEdit(){api.setState({...api.getState(),requirementEdit:inlineEdit});}
  function renderInline(){
    if(!inlineEdit)return;
    let row=document.querySelector('[data-requirement="'+CSS.escape(inlineEdit.id)+'"]');
    if(!row){row=document.createElement('article');row.className='item';$('understanding').prepend(row);}
    row.querySelector('#requirement-inline')?.remove();
    const body=row.querySelector('.requirement-text');if(body)body.hidden=true;
    row.insertAdjacentHTML('beforeend','<form id="requirement-inline"><label>'+R.name+'<input id="inline-title" required value="'+esc(inlineEdit.name)+'"></label><label>'+R.content+'<textarea id="inline-body" required>'+esc(inlineEdit.text)+'</textarea></label><label class="checkbox"><input type="checkbox" id="inline-included" '+(inlineEdit.included?'checked':'')+'>'+R.included+'</label><label>'+R.reason+'<input id="inline-reason" value="'+esc(inlineEdit.reason)+'"></label><p class="hint">'+(inlineEdit.revision!==state.revision?R.stale:R.editBoundary)+'</p><div class="actions"><button type="button" id="cancel-inline" '+(inlineEdit.saving?'disabled':'')+'>'+R.cancel+'</button><button type="submit" id="save-inline" '+(inlineEdit.saving?'disabled':'')+'>'+R.save+'</button></div><p id="inline-error" class="error" hidden></p></form>');
    $('cancel-inline').onclick=()=>{if(inlineEdit.saving||state.committing)return;inlineEdit=undefined;rememberEdit();api.postMessage({type:'editingRequirement'});$('requirement-inline').remove();if(body)body.hidden=false;update();};
    $('requirement-inline').oninput=()=>{Object.assign(inlineEdit,{name:$('inline-title').value,text:$('inline-body').value,included:$('inline-included').checked,reason:$('inline-reason').value});rememberEdit();};
    $('requirement-inline').onsubmit=event=>{event.preventDefault();if(inlineEdit.saving||state.committing||!event.target.reportValidity())return;inlineEdit.saving=true;rememberEdit();update();api.postMessage({type:'revise',...choice(),...inlineEdit});};
    api.postMessage({type:'editingRequirement',id:inlineEdit.id});
  }
  $('return-review').onclick=()=>api.postMessage({type:'return',stage:'review'});
  $('return-conclusion').onclick=()=>api.postMessage({type:'return',stage:'conclusion'});
  $('kind').value=${json(['branchChanges', 'branchFull', 'files'].includes(initialKind) ? initialKind : 'pr')};
  let FILES_CWD=${json(filesCwd ?? '')};
  const BROWSE_REPOSITORY='__browse_repository__';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function options(select,items,value){select.replaceChildren();const blank=document.createElement('option');blank.value='';blank.textContent=T.select;select.appendChild(blank);for(const item of items){const o=document.createElement('option');o.value=String(item.value);o.textContent=item.label;select.appendChild(o);}select.value=value||'';}
  function fileChoice(cwd){FILES_CWD=cwd||'';}
  function repositoryOptions(roots){options($('repository'),roots.map(root=>({value:root,label:root})),selected);const group=document.createElement('optgroup');group.label=T.otherRepositories;const browse=document.createElement('option');browse.id='browse-repository';browse.value=BROWSE_REPOSITORY;browse.textContent=T.browseRepository;group.appendChild(browse);$('repository').appendChild(group);}
  function choice(){return{cwd:data?data.cwd:selected,kind:$('kind').value,prNumber:Number($('pr').value),headRef:$('head').value,baseRef:$('base').value};}
  function valid(){const v=choice();if(v.kind==='files')return!!data&&data.cwd===FILES_CWD;return !!data&&!repositoryLoading&&(v.kind==='pr'?prStatus==='ready'&&!!data.prs?.some(pr=>pr.number===v.prNumber):!!v.headRef&&(v.kind!=='branchChanges'||!!v.baseRef&&v.baseRef!==v.headRef));}
  function rememberPreparation(){const {preparationHasReview,...saved}=api.getState()||{};api.setState({...saved,preparationCwd:selected||${json(defaultCwd)},...(${canReturn ? 'true' : 'false'}?{preparationHasReview:true}:{})});}
  function progress(){const pr=$('kind').value==='pr',local=$('kind').value==='files';let key='',text='',error=repositoryError||(pr?prError:'')||state.scopeError||'';
    if(state.committing){key='commit';text=state.operation||R.saving;}else if(repositoryLoading){key='repository';text=T.loading;}else if(pr&&prsLoading){key='prs:'+prRequest;text=data?.prs?.length?T.refreshingPrList:T.loadingPrList;}else if(state.scopeLoading){key='scope:'+scopeSequence;text=pr?T.loadingPrScope:local?T.loadingFilesScope:T.loadingBranchScope;}else if(error){text=pr&&prError?T.prListFailed+(data?.prs?.length?' '+T.retainedPrList:''):state.scopeError?T.scopeLoadFailed:'';}else if(state.scopeRetained){text=T.scopeRetained;}else if(local&&!valid()){text=T.chooseFilesHint;}else if(pr&&prStatus==='ready'){text=data.prs.length?T.prListLoaded.replace('{0}',String(data.prs.length)):T.noPrs;}
    if(key!==loadingKey){window.clearTimeout(slowTimer);loadingKey=key;$('status-text').textContent=text;if(key&&key!=='repository'&&key!=='commit')slowTimer=window.setTimeout(()=>{if(loadingKey===key)$('status-text').textContent=key.startsWith('prs:')?T.slowPrList:T.slowScope;},5000);}else if(!key)$('status-text').textContent=text;
    $('status-spinner').hidden=!key;$('pr-spinner').hidden=!pr||!prsLoading;$('pr').setAttribute('aria-busy',String(prsLoading));$('error').hidden=!error;$('error').textContent=error;
    if(state.scopeRetained&&state.scopeSummary)$('scope-summary').textContent=state.scopeSummary+' · '+T.scopeRetained;
    $('retry').hidden=local;$('retry').textContent=state.scopeError?T.retryScope:error?T.retry:pr?T.refreshPrs:T.refreshRepository;$('retry').disabled=repositoryLoading||browsePending||pr&&prsLoading||!!state.scopeLoading||!!state.busy||!!state.reading;
  }
  function requestPrs(){prsLoading=true;prStatus='loading';prError='';data.prsCurrent=false;state.ready=false;state.scopeReady=false;state.scopeLoading=false;scopeSequence++;if(!data.prs?.length)options($('pr'),[]);if($('pr').options[0])$('pr').options[0].textContent=data.prs?.length?T.select:T.loadingPrList;api.postMessage({type:'prs',cwd:data.cwd,requestId:++prRequest});}
  const editDisabled=new Map();
  function update(){for(const [id,disabled]of editDisabled)$(id).disabled=disabled;editDisabled.clear();const pr=$('kind').value==='pr',local=$('kind').value==='files';$('target-pr').checked=pr;$('target-branch').checked=!pr&&!local;$('scope-mode-field').hidden=pr||local;$('scope-mode').value=$('kind').value==='branchFull'?'branchFull':'branchChanges';$('pr-field').hidden=!pr;$('head-field').hidden=pr||local;$('base-field').hidden=$('kind').value!=='branchChanges';
    if(data&&pr&&prStatus==='idle'&&!repositoryLoading)requestPrs();
    const scopeReady=valid()&&state.scopeReady&&!state.scopeLoading;
    $('confirm').disabled=!scopeReady||state.reading||state.busy||state.hasSources&&!state.ready;$('confirm').textContent=state.confirming?R.confirming:C.start;$('confirm').title=scopeReady?state.hasSources&&!state.technicalOnly?R.confirm:'':T.waitingForScope;
    $('technical').checked=!state.hasSources||state.technicalOnly===true;$('technical').disabled=!data||!state.hasSources||state.reading||state.busy||state.scopeLoading;
    $('technical-boundary').hidden=!$('technical').checked;$('prepare-action-hint').textContent=state.hasSources&&!state.technicalOnly?C.prepareActionHint:C.technicalActionHint;
    $('files-field').hidden=!local;$('files').textContent=state.pickingFiles?T.selectingFiles:data?.cwd===FILES_CWD&&state.scopeFiles?.length?T.changeFiles:T.localFiles;
    $('target-files').disabled=state.canPickFiles===false&&(!data||data.cwd!==FILES_CWD);
    $('files').disabled=!selected||repositoryLoading||state.reading||state.busy||state.scopeLoading||state.canPickFiles===false;
    $('organize').disabled=!scopeReady||!state.hasSources||state.reading||state.busy;$('organize').hidden=!state.hasSources;$('organize').title=scopeReady?'':T.waitingForScope;$('cancel-analysis').hidden=!state.busy;
    for(const id of ['paste','file','link','human'])$(id).disabled=!data||state.reading;
    $('save-material').disabled=!!state.reading;$('model').disabled=!!state.scopeLoading||!!state.reading;$('preparation-language').disabled=!!state.busy||!!state.reading||!!state.scopeLoading||prsLoading||$('editor').open;$('repository').disabled=browsePending;$('pr').disabled=repositoryLoading||prsLoading||prStatus!=='ready'||!data?.prs?.length;
    const locked=!!state.committing||!!inlineEdit?.saving;$('preparation-shell').inert=locked;$('preparation-shell').setAttribute('aria-busy',String(locked));
    for(const id of ['repository','kind','target-pr','target-branch','target-files','scope-mode','head','base','confirm','technical','files','organize','model','preparation-language','return-review','return-conclusion','paste','file','link','human','retry','cancel-analysis'])if(inlineEdit||locked){editDisabled.set(id,$(id).disabled);$(id).disabled=true;}
    for(const id of ['close-editor','save-material','material-name','material-text','material-link','edit','preview-button','requirement-included','requirement-reason'])if(locked){editDisabled.set(id,$(id).disabled);$(id).disabled=true;}
    if($('cancel-inline'))$('cancel-inline').disabled=locked;if($('save-inline'))$('save-inline').disabled=locked;
    $('target-files').checked=local;
    $('understanding').hidden=state.technicalOnly===true;$('organize').hidden=!state.hasSources||state.technicalOnly===true;$('understanding-count').hidden=!state.requirementCount||state.technicalOnly===true;
    $('understanding-title').textContent=state.humanOnly?R.humanTitle:C.prepareUnderstanding;
    $('requirement-status').hidden=!!state.ready&&!!state.requirementCount&&!state.technicalOnly&&!state.error&&!state.busy&&!state.scopeLoading&&!locked;$('requirement-status').textContent=state.committing?state.operation||R.saving:inlineEdit?R.unsavedEdit:state.busy?R.analyzing:state.scopeLoading?T.scopePending:state.technicalOnly?R.technicalMode:state.hasSources?(state.ready&&!state.error?R.ready:!state.scopeReady&&!state.error?T.waitingForScope:R.failed):R.empty;progress();}
  function selectChanged(){if($('kind').value!=='pr'&&prsLoading){api.postMessage({type:'cancelPrs',cwd:data.cwd});prRequest++;prsLoading=false;prStatus='idle';prError='';}state.ready=false;state.scopeReady=false;state.scopeLoading=false;state.scopeError='';state.scopeRetained=false;scopeSequence++;update();if(!data)return;if(valid()){state.scopeLoading=true;update();api.postMessage({type:'selection',...choice()});}else{if($('kind').value==='files'){state.scopeLoading=true;update();}api.postMessage({type:'clearSelection',...choice()});}}
  for(const id of ['kind','head','base','pr'])$(id).onchange=selectChanged;
  $('target-pr').onchange=()=>{$('kind').value='pr';selectChanged();};$('target-branch').onchange=()=>{$('kind').value=$('scope-mode').value;selectChanged();};$('scope-mode').onchange=()=>{$('kind').value=$('scope-mode').value;selectChanged();};
  $('target-files').onchange=()=>{$('kind').value='files';selectChanged();};
  $('repository').onchange=()=>{const value=$('repository').value;if(value===BROWSE_REPOSITORY){$('repository').value=selected;browsePending=true;update();api.postMessage({type:'browse'});return;}if(!value){$('repository').value=selected;return;}selected=value;state.scopeReady=false;repositoryLoading=true;prRequest++;prsLoading=false;api.postMessage({type:'repository',cwd:selected});update();};
  function startReview(){if(state.committing)return;const message={type:'select',...choice(),...(state.technicalOnly?{technicalOnly:true}:{confirmed:true})};state.committing=true;state.confirming=true;state.operation=R.confirming;update();api.postMessage(message);}
  $('confirm').onclick=startReview;
  $('technical').onchange=()=>{if(state.committing)return;state.committing=true;state.operation=R.saving;api.postMessage({type:'reviewMode',...choice(),technicalOnly:$('technical').checked,revision:state.revision});update();};
  $('files').onclick=()=>api.postMessage({type:'pickFiles'});
  $('retry').onclick=()=>{if(state.scopeError){selectChanged();return;}if(data&&$('kind').value==='pr'&&!repositoryError){requestPrs();update();}else{repositoryError='';repositoryLoading=true;update();api.postMessage({type:'repository',cwd:selected||${json(defaultCwd)}});}};
  function openEditor(kind,source){editorKind=kind;editorId=source?.id;$('editor-error').hidden=true;$('material-input').hidden=kind==='link';$('link-input').hidden=kind!=='link';$('revision-input').hidden=kind!=='revise';$('editor-title').textContent=kind==='link'?R.link:kind==='revise'?R.revise:kind==='source'?R.raw:R.paste;$('editor-context').textContent=source?.context||R.linksBlocked;$('material-name').value=source?.name||'';$('material-name').readOnly=!!source&&kind!=='revise';$('material-text').value=source?.text||'';$('material-link').value='';$('requirement-included').checked=source?.included!==false;$('requirement-reason').value=source?.reason||'';showMode(false);$('editor').showModal();$('preparation-language').disabled=true;}
  function showMode(preview){$('material-text').hidden=preview;$('preview').hidden=!preview;$('edit').classList.toggle('active',!preview);$('preview-button').classList.toggle('active',preview);if(preview)api.postMessage({type:'markdown',text:$('material-text').value,sequence:++previewSequence});}
  $('edit').onclick=()=>showMode(false);$('preview-button').onclick=()=>showMode(true);$('close-editor').onclick=()=>{if(state.reading)api.postMessage({type:'cancelAnalysis'});$('editor').close();update();};$('editor').addEventListener('close',()=>update());
  $('editor').addEventListener('cancel',event=>{if(state.committing){event.preventDefault();return;}if(state.reading)api.postMessage({type:'cancelAnalysis'});});
  $('paste').onclick=()=>openEditor('paste');$('human').onclick=()=>{openEditor('human');$('editor-title').textContent=R.addHuman;$('save-material').hidden=false;$('material-text').readOnly=false;};$('link').onclick=()=>openEditor('link');$('file').onclick=()=>api.postMessage({type:'file',...choice()});
  $('model').onclick=()=>api.postMessage({type:'model'});$('organize').onclick=()=>api.postMessage({type:'organize',...choice()});$('cancel-analysis').onclick=()=>api.postMessage({type:'cancelAnalysis'});
  $('preparation-language').onclick=()=>api.postMessage({type:'language'});
  $('material-form').onsubmit=event=>{event.preventDefault();if(state.committing)return;const message={type:editorKind==='revise'?'revise':editorKind==='link'?'link':'material',...choice(),human:editorKind==='human',id:editorId,name:$('material-name').value,text:$('material-text').value,address:$('material-link').value,included:$('requirement-included').checked,reason:$('requirement-reason').value,revision:state.revision};if(editorKind!=='link'){state.committing=true;state.operation=R.saving;}else state.reading=true;update();api.postMessage(message);};
  $('materials').onclick=event=>{const b=event.target.closest('[data-source]');const reload=event.target.closest('[data-reload]');if(b)api.postMessage({type:'source',id:b.dataset.source});if(reload)api.postMessage({type:'reloadSource',id:reload.dataset.reload,...choice()});};
  $('materials').onchange=event=>{if(event.target.matches('[data-material]'))api.postMessage({type:'include',id:event.target.dataset.material,selected:event.target.checked,...choice()});};
  $('understanding').onclick=event=>{const source=event.target.closest('[data-source]');const revise=event.target.closest('[data-revise]');if(source)api.postMessage({type:'source',id:source.dataset.source,version:Number(source.dataset.version)});if(revise)api.postMessage({type:'editRequirement',id:revise.dataset.revise});};
  window.addEventListener('message',event=>{const msg=event.data;
    const active=document.activeElement;
    const inlineFocus=msg.type==='requirements'&&active?.id?.startsWith('inline-')?{id:active.id,start:active.selectionStart,end:active.selectionEnd}:undefined;
    if(msg.type==='loading'){repositoryLoading=true;repositoryError='';browsePending=false;prRequest++;prStatus='idle';data=undefined;selected=msg.selected;rememberPreparation();repositoryOptions(msg.roots);prsLoading=false;prError='';state.scopeReady=false;state.scopeLoading=false;state.scopeError='';state.scopeRetained=false;$('scope-summary').textContent='';$('source').textContent='';$('scope-files').innerHTML='';options($('pr'),[]);update();}
    else if(msg.type==='repository'){repositoryLoading=false;repositoryError='';if(msg.committing)state.committing=true;data=msg.data;selected=msg.selected;fileChoice(msg.filesCwd||FILES_CWD);rememberPreparation();repositoryOptions(msg.roots);options($('head'),data.refs.map(ref=>({value:ref,label:ref})),msg.selection?.headRef||data.current);options($('base'),data.refs.map(ref=>({value:ref,label:ref})),msg.selection?.baseRef||(data.refs.includes('origin/main')?'origin/main':data.refs.includes('main')?'main':''));if(msg.selection?.kind)$('kind').value=msg.selection.kind;else if($('kind').value==='files'&&data.cwd!==FILES_CWD)$('kind').value='pr';prStatus=data.prsCurrent===false?'idle':Array.isArray(data.prs)?'ready':'idle';prError='';prsLoading=false;options($('pr'),data.prs?.map(pr=>({value:pr.number,label:'PR #'+pr.number+' · '+pr.title}))||[],msg.selection?.prNumber);$('preparation-repository').textContent=data.repositoryIdentity||data.cwd;$('preparation-repository').title=data.cwd;$('source').textContent=data.cwd;update();api.postMessage({type:'rendered',cwd:data.cwd,cards:document.querySelectorAll('main>section').length});if(!state.committing&&($('kind').value!=='pr'||prStatus==='ready'&&$('pr').value))selectChanged();}
    else if(msg.type==='fileScope'){fileChoice(msg.cwd);$('kind').value='files';update();}
    else if(msg.type==='prs'&&data&&msg.cwd===data.cwd&&msg.requestId===prRequest&&prsLoading&&$('kind').value==='pr'){const previous=$('pr').value;data.prs=msg.prs;data.prsCurrent=true;prsLoading=false;prStatus='ready';prError='';options($('pr'),msg.prs.map(pr=>({value:pr.number,label:'PR #'+pr.number+' · '+pr.title})),msg.selectedPr||previous);update();selectChanged();}
    else if(msg.type==='repositoryBrowse'){browsePending=msg.pending===true;update();}
    else if(msg.type==='error'){if(msg.target==='prs'){if(!data||msg.cwd!==data.cwd||msg.requestId!==prRequest||$('kind').value!=='pr')return;prsLoading=false;prStatus='error';prError=msg.message;data.prsCurrent=false;state.scopeReady=false;}else if(msg.target==='scope'){state.scopeLoading=false;state.scopeError=msg.message;state.scopeReady=false;}else if(msg.target==='operation'){$('requirement-error').hidden=false;$('requirement-error').textContent=msg.message;}else{repositoryLoading=false;repositoryError=msg.message;}update();}
    else if(msg.type==='operationError'){$('requirement-error').hidden=false;$('requirement-error').textContent=msg.message;}
    else if(msg.type==='requirements'){state=msg.state;if(data)$('source').textContent=data.cwd+' · '+(state.scopeDescription||'');$('scope-summary').textContent=state.scopeSummary||'';$('scope-files').innerHTML=(state.scopeFiles||[]).map(path=>'<li>'+esc(path)+'</li>').join('')+(state.scopeMore?'<li>'+esc(C.scopeMore.replace('{0}',String(state.scopeMore)))+'</li>':'');$('materials').innerHTML=state.materials.map(s=>'<div class="material" title="'+esc(s.location)+'"><label><input type="checkbox" data-material="'+esc(s.id)+'" '+(s.selected?'checked':'')+'> '+esc(s.name)+'</label><span class="badge">v'+s.version+'</span><button class="secondary" data-source="'+esc(s.id)+'">'+R.raw+(s.kind==='paste'?' / '+R.edit:'')+'</button>'+(s.kind!=='paste'?'<button class="secondary" data-reload="'+esc(s.id)+'">'+R.reread+'</button>':'')+'</div>').join('');const count=state.materials.filter(s=>s.selected).length;$('material-count').hidden=!count;$('material-count').textContent=C.materialCount.replace('{0}',String(count));$('empty-materials').hidden=!!state.materials.length;$('understanding-count').hidden=!state.requirementCount;$('understanding-count').textContent=C.understandingCount.replace('{0}',String(state.requirementCount||0));$('understanding').innerHTML=state.html;$('requirement-error').hidden=!state.error;$('requirement-error').textContent=state.error||'';$('model-label').textContent=state.modelLabel;$('model').title=state.modelLabel;update();api.postMessage({type:'requirementsRendered',revision:state.revision,materials:state.materials.length,items:document.querySelectorAll('#understanding .item').length,unsafeNodes:document.querySelectorAll('#understanding script,#understanding img').length,ready:state.ready,error:state.error});}
    else if(msg.type==='markdown'&&msg.sequence===previewSequence){$('preview').innerHTML=msg.html;}
    else if(msg.type==='source'){openEditor(msg.readOnly?'paste':'source',{id:msg.id,name:msg.name,text:msg.text,context:msg.context});$('save-material').hidden=!!msg.readOnly;$('material-text').readOnly=!!msg.readOnly;}
    else if(msg.type==='editRequirement'){if(inlineEdit&&inlineEdit.id!==msg.item.id)return;inlineEdit||=msg.item;rememberEdit();renderInline();update();$('inline-title').focus();}
    else if(msg.type==='editorSaved'){if(inlineEdit?.saving){inlineEdit=undefined;rememberEdit();api.postMessage({type:'editingRequirement'});$('requirement-inline')?.remove();}$('editor').close();$('material-text').readOnly=false;$('save-material').hidden=false;update();}
    else if(msg.type==='editorError'){if(inlineEdit){inlineEdit.saving=false;rememberEdit();renderInline();$('inline-error').textContent=msg.message;$('inline-error').hidden=false;}$('editor-error').textContent=msg.message;$('editor-error').hidden=false;update();}
    if(msg.type==='requirements'){
      for(const source of state.materials.filter(source=>source.kind==='human'))document.querySelector('[data-reload="'+CSS.escape(source.id)+'"]')?.remove();
      if(inlineEdit){renderInline();update();}
      if(inlineFocus&&!state.committing&&!inlineEdit?.saving){const field=$(inlineFocus.id);if(field){field.focus({preventScroll:true});if(inlineFocus.start!==null&&inlineFocus.start!==undefined&&typeof field.setSelectionRange==='function')field.setSelectionRange(inlineFocus.start,inlineFocus.end);}}
    }
  });
  for(const id of ['paste','link'])$(id).addEventListener('click',()=>{$('save-material').hidden=false;$('material-text').readOnly=false;});
  window.addEventListener('unload',()=>window.clearTimeout(slowTimer));
  window.addEventListener('error',event=>api.postMessage({type:'clientError',message:event.message}));
  window.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('editor').open&&!state.committing&&!inlineEdit?.saving)api.postMessage({type:'cancel'});});
  rememberPreparation();api.postMessage({type:'ready'});})();</script></body></html>`;
}
