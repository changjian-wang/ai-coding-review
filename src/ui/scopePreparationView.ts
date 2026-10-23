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
  .preparation-shell{height:100%;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto}
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
  #status:empty{display:none}
  #status{margin-top:8px;font-size:11px;color:var(--review-muted)}
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
  .understanding-detail .markdown{margin-top:7px;font-size:11px}
  .understanding-extras{padding-top:10px;margin-top:10px}
  .understanding-extras h3{font-size:11px;margin-top:10px}
  .understanding-extras p{margin:6px 0}
  .quote,pre{padding:10px;background:var(--vscode-textCodeBlock-background);white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.8 var(--vscode-editor-font-family)}
  #understanding>details{margin-top:10px}
  #requirement-status{font-size:11px;color:var(--review-muted);line-height:1.9}
  .prepare-footer{position:sticky;bottom:-12px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:17px 0 14px;background:var(--review-canvas);border-top:1px solid var(--review-border);margin-top:18px}
  .prepare-footer>div:first-child{flex:1;min-width:180px;max-width:470px}
  .prepare-footer .primary{min-height:36px;font-size:12px}
  .advanced-actions{margin-top:6px}
  dialog{width:min(780px,calc(100vw - 28px));max-height:calc(100vh - 36px);overflow:auto;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface);color:var(--vscode-foreground);padding:22px}
  dialog::backdrop{background:#0008;backdrop-filter:blur(2px)}
  dialog h2{font-size:15px;overflow-wrap:anywhere;margin-bottom:10px}
  dialog label{margin-top:12px}
  dialog .actions{margin-top:10px}
  #preview{min-height:190px;padding:12px;border:1px solid var(--review-border);margin-top:8px;background:var(--review-canvas)}
  .checkbox{display:flex;align-items:flex-start;gap:8px}
  .checkbox input{margin-top:3px}
  .active{color:var(--review-accent)}
  @media(max-width:560px){main{padding:20px 16px 12px}.fields{grid-template-columns:minmax(0,1fr)}.review-card{padding:13px}.material{flex-wrap:wrap}.prepare-footer{gap:10px}.prepare-footer>.actions{width:100%;justify-content:flex-end}.understanding-row{flex-wrap:wrap}.understanding-row .badge{margin-left:22px}}
  </style></head><body>
  <div class="preparation-shell"><header class="command">${reviewBrand('preparation-repository')}
  <nav class="stages" aria-label="${esc(c.title)}"><button class="active" aria-current="step" type="button">${reviewStageLabel(1, c.prepare)}</button><span class="stage-divider"></span><button type="button" id="return-review" ${canReturn ? '' : 'disabled'}>${reviewStageLabel(2, c.review)}</button><span class="stage-divider"></span><button type="button" id="return-conclusion" ${canReturn ? '' : 'disabled'}>${reviewStageLabel(3, c.conclusion)}</button></nav>
  <div class="command-actions"><button id="model" class="secondary" title="${esc(r.chooseModel)}"><span id="model-label">${esc(r.chooseModel)}</span></button><button id="preparation-language" class="language-button" title="${esc(c.language)}">${esc(c.languageName)}</button></div></header>
  <div class="prepare-scroll"><main>
  <div class="eyebrow">${esc(c.prepareEyebrow)}<span>${esc(c.prepareHint)}</span></div><h1>${esc(t.prepareTitle)}</h1><p class="stage-description">${esc(c.prepareDescription)}</p>
  <section class="review-card"><div class="section-heading"><h2><span class="section-number">1</span>${esc(c.prepareTarget)}</h2></div><div class="fields">
  <label>${esc(t.repository)}<select id="repository"></select></label><fieldset class="scope-kind"><legend>${esc(t.target)}</legend><div><label><input id="target-pr" type="radio" name="scope-kind" value="pr" checked>PR</label><label><input id="target-branch" type="radio" name="scope-kind" value="branch">${esc(c.branchTarget)}</label></div></fieldset>
  <select id="kind" hidden aria-label="${esc(t.target)}"><option value="pr">${esc(t.prTarget)}</option><option value="branchChanges">${esc(t.branchTarget)}</option><option value="branchFull">${esc(t.fullTarget)}</option>${filesCwd ? `<option value="files">${esc(t.currentFilesTarget)}</option>` : ''}</select>
  <label id="pr-field" class="scope-wide">${esc(t.pr)}<select id="pr"></select></label><label id="head-field">${esc(t.branch)}<select id="head"></select></label>
  <label id="scope-mode-field">${esc(c.branchMode)}<select id="scope-mode"><option value="branchChanges">${esc(t.branchTarget)}</option><option value="branchFull">${esc(t.fullTarget)}</option></select></label>
  <label id="base-field" class="scope-wide">${esc(t.base)}<select id="base"></select></label></div>
  <p id="scope-summary"></p><p id="status" role="status"></p><p id="error" class="error" role="alert" hidden></p>
  <div class="scope-tools actions"><details class="scope-details"><summary>${esc(c.scopeDetails)}</summary><p id="source" class="hint"></p><ul id="scope-files"></ul></details><div><button id="retry" class="secondary" title="${esc(t.refreshHint)}" disabled>${esc(t.refreshPrs)}</button><button id="browse" class="secondary" title="${esc(t.browseRepositoryHint)}">${esc(t.browseRepository)}</button></div></div></section>
  <section class="review-card"><div class="section-heading"><h2><span class="section-number">2</span>${esc(c.prepareEvidence)}<small>${esc(c.optional)}</small></h2><span class="badge" id="material-count" hidden></span></div>
  <div class="actions material-input-actions"><button id="paste">${esc(r.paste)}</button><button id="link">${esc(r.link)}</button><button id="file">${esc(r.localFile)}</button></div><p class="hint">${esc(c.prepareEvidenceHint)}</p>
  <div id="materials"></div><p id="empty-materials" class="hint empty-materials">${esc(c.emptyMaterials)}</p>
  <details class="evidence-details"><summary>${esc(c.evidenceBoundary)}</summary><p class="hint">${esc(r.disclosure)}</p><p class="hint">${esc(r.linkSnapshot)}</p></details></section>
  <section class="review-card"><div class="section-heading"><h2><span class="section-number">3</span>${esc(c.prepareUnderstanding)}</h2><span class="badge accent" id="understanding-count" hidden></span></div>
  <p id="requirement-status" role="status">${esc(r.empty)}</p><p id="requirement-error" class="error" role="alert" hidden></p><div id="understanding"></div>
  <div class="actions"><button id="organize" class="secondary">${esc(r.retry)}</button><button id="cancel-analysis" class="secondary" hidden>${esc(r.cancelAnalysis)}</button></div></section>
  <footer class="prepare-footer"><div><p class="hint">${esc(c.prepareBoundary)}</p><p class="hint">${esc(c.prepareNext)}</p><details class="advanced-actions"><summary>${esc(c.moreTools)}</summary><button id="files" class="secondary">${esc(t.localFiles)}</button></details></div><div class="actions"><button id="technical" class="secondary" hidden>${esc(r.skip)}</button><button id="confirm" class="primary" disabled>${esc(r.startTechnical)}</button></div></footer></main></div>
  <footer class="bottom"><span>${esc(c.prepareHint)}</span><span>${esc(c.reportBoundary)}</span></footer></div>
  <dialog id="editor"><form id="material-form"><h2 id="editor-title"></h2><p id="editor-context" class="hint"></p>
  <div id="material-input"><label>${esc(r.name)}<input id="material-name" maxlength="200"></label><label>${esc(r.content)}</label>
  <div class="actions"><button id="edit" class="secondary active" type="button">${esc(r.edit)}</button><button id="preview-button" class="secondary" type="button">${esc(r.preview)}</button></div>
  <textarea id="material-text" rows="9" placeholder="${esc(r.inputPlaceholder)}"></textarea><div id="preview" class="markdown" hidden></div></div>
  <div id="link-input" hidden><label>${esc(r.address)}<input id="material-link" type="url" placeholder="https://…"></label><p class="hint">${esc(r.confirmFetch.replace('{0}', ''))}</p></div>
  <div id="revision-input" hidden><label class="checkbox"><input id="requirement-included" type="checkbox" checked><span>${esc(r.included)}</span></label><label>${esc(r.reason)}<input id="requirement-reason"></label></div>
  <p id="editor-error" class="error" role="alert" hidden></p><div class="actions"><button type="button" id="close-editor" class="secondary">${esc(r.cancel)}</button><button id="save-material" type="submit">${esc(r.save)}</button></div></form></dialog>
  <script nonce="${token}">(()=>{'use strict';const api=acquireVsCodeApi();const T=${json(t)},R=${json(r)},C=${json(c)};const $=id=>document.getElementById(id);let data;let selected;let prsLoading=false;let repositoryLoading=true;let state={materials:[],ready:false,busy:false,reading:false};let editorKind='paste';let editorId;let previewSequence=0;
  $('return-review').onclick=()=>api.postMessage({type:'return',stage:'review'});
  $('return-conclusion').onclick=()=>api.postMessage({type:'return',stage:'conclusion'});
  $('kind').value=${json(initialKind === 'branchChanges' || initialKind === 'branchFull' ? initialKind : 'pr')};
  const FILES_CWD=${json(filesCwd ?? '')};
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function options(select,items,value){select.replaceChildren();const blank=document.createElement('option');blank.value='';blank.textContent=T.select;select.appendChild(blank);for(const item of items){const o=document.createElement('option');o.value=String(item.value);o.textContent=item.label;select.appendChild(o);}select.value=value||'';}
  function choice(){return{cwd:data?data.cwd:selected,kind:$('kind').value,prNumber:Number($('pr').value),headRef:$('head').value,baseRef:$('base').value};}
  function valid(){const v=choice();if(v.kind==='files')return!!data&&data.cwd===FILES_CWD;return !!data&&(v.kind==='pr'?!!data.prs&&!!v.prNumber:!!v.headRef&&(v.kind!=='branchChanges'||!!v.baseRef&&v.baseRef!==v.headRef));}
  function rememberPreparation(){api.setState({...api.getState(),preparationCwd:selected||${json(defaultCwd)}});}
  function repositoryActions(){$('retry').textContent=!$('error').hidden?T.retry:$('kind').value==='pr'?T.refreshPrs:T.refreshRepository;$('retry').disabled=repositoryLoading||prsLoading||!!data&&(state.busy||state.reading);}
  function update(){const pr=$('kind').value==='pr',local=$('kind').value==='files';$('target-pr').checked=pr;$('target-branch').checked=!pr&&!local;$('scope-mode-field').hidden=pr||local;$('scope-mode').value=$('kind').value==='branchFull'?'branchFull':'branchChanges';$('pr-field').hidden=!pr;$('head-field').hidden=pr||local;$('base-field').hidden=$('kind').value!=='branchChanges';$('confirm').disabled=!valid()||state.reading||state.busy||state.hasSources&&!state.ready;$('confirm').textContent=state.hasSources?R.confirm:R.startTechnical;$('technical').hidden=!state.hasSources;$('technical').disabled=!valid()||state.reading;$('files').disabled=!selected||state.reading;$('organize').disabled=!valid()||!state.hasSources||state.reading;$('organize').hidden=!state.hasSources;$('cancel-analysis').hidden=!state.busy;for(const id of ['paste','file','link'])$(id).disabled=!data||state.reading;$('save-material').disabled=!!state.reading;$('preparation-language').disabled=!!state.busy||!!state.reading||$('editor').open;
    if(data&&pr&&!data.prs&&!prsLoading){prsLoading=true;$('status').textContent=T.loadingPrList;api.postMessage({type:'prs',cwd:data.cwd});}repositoryActions();}
  function selectChanged(){state.ready=false;$('error').hidden=true;update();api.postMessage({type:'selection',...choice()});}
  for(const id of ['kind','head','base','pr'])$(id).onchange=selectChanged;
  $('target-pr').onchange=()=>{$('kind').value='pr';selectChanged();};$('target-branch').onchange=()=>{$('kind').value=$('scope-mode').value;selectChanged();};$('scope-mode').onchange=()=>{$('kind').value=$('scope-mode').value;selectChanged();};
  $('repository').onchange=()=>{selected=$('repository').value;api.postMessage({type:'repository',cwd:selected});};
  $('confirm').onclick=()=>api.postMessage({type:'select',...choice(),confirmed:true});
  $('technical').onclick=()=>api.postMessage({type:'select',...choice(),technicalOnly:true});
  $('files').onclick=()=>api.postMessage({type:'select',cwd:data?data.cwd:selected,kind:'files'});
  $('browse').onclick=()=>api.postMessage({type:'browse'});$('retry').onclick=()=>{if(data&&$('kind').value==='pr'){data.prs=undefined;prsLoading=false;$('error').hidden=true;update();}else api.postMessage({type:'repository',cwd:selected||${json(defaultCwd)}});};
  function openEditor(kind,source){editorKind=kind;editorId=source?.id;$('editor-error').hidden=true;$('material-input').hidden=kind==='link';$('link-input').hidden=kind!=='link';$('revision-input').hidden=kind!=='revise';$('editor-title').textContent=kind==='link'?R.link:kind==='revise'?R.revise:kind==='source'?R.raw:R.paste;$('editor-context').textContent=source?.context||R.linksBlocked;$('material-name').value=source?.name||'';$('material-name').readOnly=!!source&&kind!=='revise';$('material-text').value=source?.text||'';$('material-link').value='';$('requirement-included').checked=source?.included!==false;$('requirement-reason').value=source?.reason||'';showMode(false);$('editor').showModal();$('preparation-language').disabled=true;}
  function showMode(preview){$('material-text').hidden=preview;$('preview').hidden=!preview;$('edit').classList.toggle('active',!preview);$('preview-button').classList.toggle('active',preview);if(preview)api.postMessage({type:'markdown',text:$('material-text').value,sequence:++previewSequence});}
  $('edit').onclick=()=>showMode(false);$('preview-button').onclick=()=>showMode(true);$('close-editor').onclick=()=>{if(state.reading)api.postMessage({type:'cancelAnalysis'});$('editor').close();update();};$('editor').addEventListener('close',()=>update());
  $('editor').addEventListener('cancel',()=>{if(state.reading)api.postMessage({type:'cancelAnalysis'});});
  $('paste').onclick=()=>openEditor('paste');$('link').onclick=()=>openEditor('link');$('file').onclick=()=>api.postMessage({type:'file',...choice()});
  $('model').onclick=()=>api.postMessage({type:'model'});$('organize').onclick=()=>api.postMessage({type:'organize',...choice()});$('cancel-analysis').onclick=()=>api.postMessage({type:'cancelAnalysis'});
  $('preparation-language').onclick=()=>api.postMessage({type:'language'});
  $('material-form').onsubmit=event=>{event.preventDefault();api.postMessage({type:editorKind==='revise'?'revise':editorKind==='link'?'link':'material',...choice(),id:editorId,name:$('material-name').value,text:$('material-text').value,address:$('material-link').value,included:$('requirement-included').checked,reason:$('requirement-reason').value,revision:state.revision});};
  $('materials').onclick=event=>{const b=event.target.closest('[data-source]');const reload=event.target.closest('[data-reload]');if(b)api.postMessage({type:'source',id:b.dataset.source});if(reload)api.postMessage({type:'reloadSource',id:reload.dataset.reload,...choice()});};
  $('materials').onchange=event=>{if(event.target.matches('[data-material]'))api.postMessage({type:'include',id:event.target.dataset.material,selected:event.target.checked,...choice()});};
  $('understanding').onclick=event=>{const source=event.target.closest('[data-source]');const revise=event.target.closest('[data-revise]');if(source)api.postMessage({type:'source',id:source.dataset.source,version:Number(source.dataset.version)});if(revise)api.postMessage({type:'editRequirement',id:revise.dataset.revise});};
  window.addEventListener('message',event=>{const msg=event.data;
    if(msg.type==='loading'){repositoryLoading=true;data=undefined;selected=msg.selected;rememberPreparation();options($('repository'),msg.roots.map(root=>({value:root,label:root})),selected);prsLoading=false;$('status').textContent=T.loading;$('error').hidden=true;update();}
    else if(msg.type==='repository'){repositoryLoading=false;data=msg.data;selected=msg.selected;rememberPreparation();options($('repository'),msg.roots.map(root=>({value:root,label:root})),selected);options($('head'),data.refs.map(ref=>({value:ref,label:ref})),msg.selection?.headRef||data.current);options($('base'),data.refs.map(ref=>({value:ref,label:ref})),msg.selection?.baseRef||(data.refs.includes('origin/main')?'origin/main':data.refs.includes('main')?'main':''));if(msg.selection?.kind)$('kind').value=msg.selection.kind;options($('pr'),data.prs?.map(pr=>({value:pr.number,label:'PR #'+pr.number+' · '+pr.title}))||[],msg.selection?.prNumber);$('preparation-repository').textContent=data.repositoryIdentity||data.cwd;$('preparation-repository').title=data.cwd;$('source').textContent=data.cwd;$('status').textContent='';update();api.postMessage({type:'rendered',cwd:data.cwd,cards:document.querySelectorAll('main>section').length});if($('kind').value!=='pr')selectChanged();}
    else if(msg.type==='prs'&&data){data.prs=msg.prs;prsLoading=false;options($('pr'),msg.prs.map(pr=>({value:pr.number,label:'PR #'+pr.number+' · '+pr.title})),msg.selectedPr);$('status').textContent=msg.prs.length?'':T.noPrs;update();if($('pr').value)selectChanged();}
    else if(msg.type==='error'){repositoryLoading=false;prsLoading=false;$('error').textContent=msg.message;$('error').hidden=false;$('status').textContent='';$('confirm').disabled=true;repositoryActions();}
    else if(msg.type==='requirements'){state=msg.state;if(data)$('source').textContent=data.cwd+' · '+(state.scopeDescription||'');$('scope-summary').textContent=state.scopeSummary||'';$('scope-files').innerHTML=(state.scopeFiles||[]).map(path=>'<li>'+esc(path)+'</li>').join('')+(state.scopeMore?'<li>'+esc(C.scopeMore.replace('{0}',String(state.scopeMore)))+'</li>':'');$('materials').innerHTML=state.materials.map(s=>'<div class="material" title="'+esc(s.location)+'"><label><input type="checkbox" data-material="'+esc(s.id)+'" '+(s.selected?'checked':'')+'> '+esc(s.name)+'</label><span class="badge">v'+s.version+'</span><button class="secondary" data-source="'+esc(s.id)+'">'+R.raw+(s.kind==='paste'?' / '+R.edit:'')+'</button>'+(s.kind!=='paste'?'<button class="secondary" data-reload="'+esc(s.id)+'">'+R.reread+'</button>':'')+'</div>').join('');const count=state.materials.filter(s=>s.selected).length;$('material-count').hidden=!count;$('material-count').textContent=C.materialCount.replace('{0}',String(count));$('empty-materials').hidden=!!state.materials.length;$('understanding-count').hidden=!state.requirementCount;$('understanding-count').textContent=C.understandingCount.replace('{0}',String(state.requirementCount||0));$('understanding').innerHTML=state.html;$('requirement-status').hidden=!!state.ready&&!!state.requirementCount&&!state.error&&!state.busy;$('requirement-status').textContent=state.busy?R.analyzing:state.hasSources?(state.ready&&!state.error?R.ready:R.failed):R.empty;$('requirement-error').hidden=!state.error;$('requirement-error').textContent=state.error||'';$('model-label').textContent=state.modelLabel;$('model').title=state.modelLabel;update();api.postMessage({type:'requirementsRendered',revision:state.revision,materials:state.materials.length,items:document.querySelectorAll('#understanding .item').length,unsafeNodes:document.querySelectorAll('#understanding script,#understanding img').length,ready:state.ready,error:state.error});}
    else if(msg.type==='markdown'&&msg.sequence===previewSequence){$('preview').innerHTML=msg.html;}
    else if(msg.type==='source'){openEditor(msg.readOnly?'paste':'source',{id:msg.id,name:msg.name,text:msg.text,context:msg.context});$('save-material').hidden=!!msg.readOnly;$('material-text').readOnly=!!msg.readOnly;}
    else if(msg.type==='editRequirement'){openEditor('revise',msg.item);$('save-material').hidden=false;$('material-text').readOnly=false;}
    else if(msg.type==='editorSaved'){$('editor').close();$('material-text').readOnly=false;$('save-material').hidden=false;}
    else if(msg.type==='editorError'){$('editor-error').textContent=msg.message;$('editor-error').hidden=false;}
  });
  for(const id of ['paste','link'])$(id).addEventListener('click',()=>{$('save-material').hidden=false;$('material-text').readOnly=false;});
  window.addEventListener('error',event=>api.postMessage({type:'clientError',message:event.message}));
  window.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('editor').open)api.postMessage({type:'cancel'});});
  rememberPreparation();api.postMessage({type:'ready'});})();</script></body></html>`;
}
