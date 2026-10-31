import type { Messages } from '../i18n';
import type { ReviewConcern, ReviewRequirement, ReviewVerdict } from '../review/reviewWorkflow';
import type { InboundMessage } from './workbenchPanel';
import type { CenterDocument, CenterFinding, ReviewCenterMeta, ReviewCenterMessage, ReviewCenterUpdate } from './reviewCenter';

interface CenterLocalState {
  scopeKey: string;
  navigation: 'business' | 'findings' | 'files';
  search: string;
  finding?: string;
  concern?: string;
  codeView: 'source' | 'diff' | 'reading' | 'bilingual';
  focus: boolean;
  fileLimit: number;
  notes: string;
  notesDirty?: boolean;
  edit?: { id: string; title: string; text: string; revision: number; original: ReviewRequirement; saving?: boolean };
}

interface CenterWebviewApi {
  postMessage(message: InboundMessage): void;
  getState(): CenterLocalState | undefined;
  setState(state: CenterLocalState): void;
}

declare function acquireVsCodeApi(): CenterWebviewApi;
type CenterAction<T> = T extends { type: 'center' } ? Omit<T, 'type' | 'scopeKey' | 'runId'> : never;

export function reviewCenterClient(
  initial: ReviewCenterUpdate,
  t: Messages['reviewCenter'],
  compose: (base: string, notes: string, heading: string, comments?: string) => string,
): void {
  const api = acquireVsCodeApi();
  if (!initial.center) throw new Error(t.invalidAction);
  let common = initial.state;
  let meta: ReviewCenterMeta = initial.center;
  let files = initial.files ?? [];
  let source: CenterDocument | undefined = initial.document ?? undefined;
  const saved = api.getState();
  let local: CenterLocalState = saved?.scopeKey === meta.workflow.scopeKey ? saved : {
    scopeKey: meta.workflow.scopeKey, navigation: 'business', search: '',
    codeView: 'source', focus: false, fileLimit: 200, notes: meta.workflow.notes,
  };
  let sourceKey = '';
  let sourceGeneration = 0;
  let sourcePath = '';
  let sourceReadRequest: string | undefined;
  let menuKind: string | undefined;
  let selectedLines: { path: string; start: number; end: number; text: string; revision: string } | undefined;
  let notesTimer: number | undefined;
  let noticeTimer: number | undefined;
  let visibility: IntersectionObserver | undefined;
  let observed = new WeakSet<Element>();
  let seenTimer: number | undefined;
  let seenPath = '';
  let seenRevision = '';
  let pendingReveal: number | undefined;
  const seen = new Set<number>();
  const sourcePositions = new Map<string, number>();

  function element(id: string): HTMLElement {
    const node = document.getElementById(id);
    if (!node) throw new Error(t.invalidAction);
    return node;
  }
  function input(id: string): HTMLInputElement | HTMLTextAreaElement {
    const node = element(id);
    if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) throw new Error(t.invalidAction);
    return node;
  }
  const shell = element('center-shell');
  const main = element('center-main');
  const navigation = element('center-nav');
  const inspector = element('center-inspector');
  const dialogNode = element('center-dialog');
  if (!(dialogNode instanceof HTMLDialogElement)) throw new Error(t.invalidAction);
  const dialog = dialogNode;
  function esc(value: string | number): string {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmt(value: string, ...args: (string | number)[]): string {
    return value.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)] ?? ''));
  }
  function post(message: InboundMessage): void { api.postMessage(message); }
  function center(message: CenterAction<ReviewCenterMessage>): void {
    post({ type: 'center', scopeKey: meta.workflow.scopeKey, runId: meta.workflow.run.id, ...message });
  }
  function persist(): void { api.setState(local); }
  function badge(text: string, tone = ''): string { return `<span class="badge ${tone}">${esc(text)}</span>`; }
  function titleFor(verdict: ReviewVerdict): string {
    return verdict === 'approve' ? t.approve : verdict === 'request-changes' ? t.requestChanges : t.comment;
  }
  function currentFinding(): CenterFinding | undefined { return meta.findings.find((item) => item.ref === local.finding); }
  function currentConcern(): ReviewConcern | undefined { return meta.workflow.run.business?.concerns.find((item) => item.id === local.concern); }
  function reportText(): string { return compose(meta.reportBase, local.notes, t.notes, meta.commentPreview); }
  function notice(message: string, error = false): void {
    const node = element('center-notice');
    node.textContent = message;
    node.hidden = false;
    if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => { node.hidden = true; }, 6500);
    if (error && dialog.open) {
      let box = dialog.querySelector<HTMLElement>('.dialog-error');
      if (!box) {
        box = document.createElement('p');
        box.className = 'error-box error dialog-error';
        dialog.querySelector('.dialog-body')?.prepend(box);
      }
      box.textContent = message;
    }
    if (error && local.edit?.saving) { local.edit.saving = false; render(); }
  }
  function openDialog(title: string, body: string, footer = `<button data-action="close">${esc(t.cancel)}</button>`): void {
    if (dialog.open) dialog.close();
    dialog.innerHTML = `<div class="dialog-head"><h2>${esc(title)}</h2><button class="link" data-action="close" aria-label="${esc(t.cancel)}">×</button></div><div class="dialog-body">${body}</div><div class="dialog-actions">${footer}</div>`;
    dialog.showModal();
  }
  function status(item: CenterFinding): [string, string] {
    if (!item.current) return [t.historical, ''];
    if (item.verification?.status === 'overturned') return [t.overturn, 'green'];
    if (item.verification?.status === 'unresolved') return [t.unresolved, 'amber'];
    if (item.disposition) return [item.disposition === 'fixed' ? t.fixed : item.disposition === 'commented' ? t.commented : t.ignored, 'blue'];
    return [t.confirmed, 'red'];
  }
  function chooseFinding(ref: string): void {
    const finding = meta.findings.find((item) => item.ref === ref);
    if (!finding) return notice(t.noFindings, true);
    local.finding = ref;
    local.concern = undefined;
    persist();
    post({ type: 'select', path: finding.path });
    render();
  }
  function nextFinding(): void {
    const items = [
      ...(meta.workflow.run.business?.concerns ?? []).filter((item) => item.status === 'open').map((item) => ({ kind: 'concern' as const, id: item.id })),
      ...meta.findings.filter((item) => item.current && !item.disposition && item.verification?.status !== 'overturned').map((item) => ({ kind: 'finding' as const, id: item.ref })),
    ];
    if (!items.length) return notice(t.noFindings);
    const index = items.findIndex((item) => item.kind === 'finding' ? item.id === local.finding : item.id === local.concern);
    const next = items[(index + 1) % items.length];
    if (next.kind === 'finding') chooseFinding(next.id);
    else chooseConcern(next.id);
  }
  function chooseConcern(id: string): void {
    local.concern = id;
    local.finding = undefined;
    const proof = currentConcern()?.evidence[0];
    if (proof) center({ action: 'evidence', path: proof.file, line: proof.line });
    render();
  }

  function renderHeader(): void {
    const wf = meta.workflow;
    const running = wf.run.status === 'running';
    const busy = running || meta.busy;
    const hasRequirements = wf.understanding.requirements.some((item) => item.included);
    const tokens = common.tokenUsage;
    const tokenLabel = tokens ? new Intl.NumberFormat(document.documentElement.lang, { notation: 'compact', maximumFractionDigits: 1 }).format(tokens.input + tokens.output) : '';
    element('center-header').innerHTML = `<div class="brand">AI Coding Review</div><nav class="stages" aria-label="${esc(t.title)}">${(['prepare', 'review', 'conclusion'] as const).map((stage) => `<button data-action="stage" data-stage="${stage}" class="${wf.stage === stage ? 'active' : ''}" ${wf.stage === stage ? 'aria-current="step"' : ''}>${esc(t[stage])}</button>`).join('')}</nav><div class="commands">${tokens ? `<span class="badge" title="${esc(fmt(t.estimatedUsage, tokens.calls))}">${esc(fmt(t.estimatedTokens, tokenLabel))}</span>` : ''}<button class="link" data-action="project" ${busy || local.edit ? 'disabled' : ''}>${esc(common.repoName)}</button><button class="link" data-action="model">${esc(common.modelLabel)}</button><button class="link" data-action="language">${esc(t.language)}</button>${wf.stage !== 'prepare' || busy ? `<button class="primary" data-action="${busy ? 'cancel-run' : 'run'}" ${local.edit ? 'disabled' : ''}>${esc(busy ? running ? t.stop : t.cancel : ['partial', 'cancelled'].includes(wf.run.status) ? t.continue : wf.run.status === 'idle' ? t.start : t.rerun)}</button>` : ''}</div>`;
    element('center-context').innerHTML = `<div class="row"><span class="scope-label" title="${esc(`${t.codeSnapshot}: ${meta.headSha}${meta.baseSha ? ` / ${meta.baseSha}` : ''}`)}">${esc(common.label)} · ${files.filter((file) => !file.context).length}</span>${badge(hasRequirements ? fmt(t.baselineVersion, wf.baselineVersion) : t.technical, 'blue')}${wf.run.excluded.length ? badge(`${t.excluded}: ${wf.run.excluded.length}`) : ''}${wf.run.status === 'stale' ? badge(t.stale, 'amber') : ''}<span class="badge" title="${esc(fmt(t.viewedLines, common.coverage.seen, common.coverage.total))}">${common.coverage.seen}/${common.coverage.total}</span></div><div class="row"><span>${esc(t.runState[wf.run.status])}</span><button class="link" data-action="stage" data-stage="conclusion">${esc(t.conclusion)}</button></div>`;
    shell.dataset.stage = wf.stage;
    shell.inert = !!meta.submitting || !!meta.loadingScope;
    shell.setAttribute('aria-busy', String(!!meta.submitting || !!meta.loadingScope));
    if (meta.submitting || meta.loadingScope) {
      const operation = document.querySelector<HTMLElement>('.commands > .primary');
      if (operation) { operation.textContent = meta.submitting ? t.submitting : t.loadingTarget; operation.removeAttribute('data-action'); }
    }
    shell.classList.toggle('focused-code', local.focus && wf.stage === 'review');
  }

  function renderNavigation(): void {
    const needle = local.search.toLowerCase();
    const matches = (item: CenterFinding) => `${item.title} ${item.detail} ${item.path}`.toLowerCase().includes(needle);
    const item = (finding: CenterFinding) => {
      const [label, tone] = status(finding);
      return `<button class="nav-item ${local.finding === finding.ref ? 'active' : ''}" data-action="finding" data-ref="${esc(finding.ref)}"><strong>${esc(finding.title)}</strong><small>${esc(finding.path)} · ${esc(label)}${tone === 'amber' ? ' ?' : ''}</small></button>`;
    };
    let content = '';
    if (local.navigation === 'files') {
      const paths = files.filter((file) => file.path.toLowerCase().includes(needle));
      const shown = paths.slice(0, local.fileLimit);
      const fileRow = (file: typeof files[number]) => {
        const excluded = meta.workflow.run.excluded.find((item) => item.path === file.path);
        const failed = meta.workflow.run.failed.find((item) => item.path === file.path);
        const label = excluded ? excluded.reason : failed ? failed.error : meta.current && meta.workflow.run.completed.includes(file.path) ? t.runState.completed : t.runState.idle;
        return `<button class="nav-item file-item ${common.selected === file.path ? 'active' : ''}" data-action="file" data-path="${esc(file.path)}" title="${esc(file.path)}">${esc(file.path)}<small>${esc(label)}</small></button>`;
      };
      content = `<div class="nav-title">${esc(t.scopeFiles)} · ${paths.filter((file) => !file.context).length}</div>${shown.filter((file) => !file.context).map(fileRow).join('')}${shown.some((file) => file.context) ? `<div class="nav-title">${esc(t.contextFiles)}</div>${shown.filter((file) => file.context).map(fileRow).join('')}` : ''}${paths.length > local.fileLimit ? `<button class="link" data-action="more">${esc(t.loadMore)}</button>` : ''}<p class="hint">${esc(t.contextBoundary)}</p>`;
    } else {
      const findings = meta.findings.filter(matches);
      const concerns = (meta.workflow.run.business?.concerns ?? []).filter((entry) => `${entry.title} ${entry.detail}`.toLowerCase().includes(needle));
      if (concerns.length) content += `<div class="nav-title">${esc(t.criticalConcerns)}</div>${concerns.map((entry) => `<button class="nav-item ${local.concern === entry.id ? 'active' : ''}" data-action="concern" data-id="${esc(entry.id)}"><strong>${esc(entry.title)}</strong><small>${esc(entry.status === 'resolved' ? t.resolved : entry.critical ? t.critical : t.question)}</small></button>`).join('')}`;
      const chains = meta.workflow.run.business?.chains ?? [];
      if (local.navigation === 'business' && chains.length) {
        const shown = new Set<string>();
        for (const chain of chains) {
          const members = findings.filter((entry) => !shown.has(entry.ref) && (chain.findingRefs.includes(entry.ref) || chain.files.includes(entry.path)));
          if (!members.length && !chain.title.toLowerCase().includes(needle)) continue;
          members.forEach((entry) => shown.add(entry.ref));
          content += `<div class="chain-title">${esc(chain.title)}</div><p class="hint">${esc(chain.description)}</p>${members.map(item).join('')}`;
        }
        content += findings.filter((entry) => !shown.has(entry.ref)).map(item).join('');
      } else {
        content += findings.slice(0, local.fileLimit).map(item).join('');
        if (findings.length > local.fileLimit) content += `<button class="link" data-action="more">${esc(t.loadMore)}</button>`;
      }
      if (!findings.length && !concerns.length) content += `<p class="hint">${esc(t.noFindings)}</p>`;
    }
    navigation.innerHTML = `<div class="nav-head">${esc(t.title)}</div><div class="nav-tabs">${(['business', 'findings', 'files'] as const).map((tab) => `<button data-action="navigation" data-tab="${tab}" class="${local.navigation === tab ? 'active' : ''}">${esc(t[tab])}</button>`).join('')}</div><input id="center-search" type="search" aria-label="${esc(t.search)}" placeholder="${esc(t.search)}" value="${esc(local.search)}"><div class="nav-scroll">${!meta.current && meta.findings.length ? `<p class="hint">${esc(t.historical)}</p>` : ''}${content}</div>`;
  }

  function renderOrigins(requirement: ReviewRequirement): string {
    return `<details><summary>${esc(t.origins)} · ${requirement.origins.length}</summary>${requirement.origins.map((origin) => {
      const material = meta.workflow.materials.find((entry) => entry.id === origin.sourceId);
      const current = material?.selected && material.version === origin.version;
      return `<div class="proof"><p>${esc(material?.label ?? origin.sourceId)} · v${origin.version} · L${origin.line}${current ? '' : ` · ${esc(t.stale)}`}</p><blockquote>${esc(origin.quote)}</blockquote><button class="link" data-action="source" data-id="${esc(origin.sourceId)}" data-version="${origin.version}">${esc(t.read)}</button></div>`;
    }).join('')}</details>`;
  }
  function requirementRow(requirement: ReviewRequirement): string {
    const edit = local.edit?.id === requirement.id ? local.edit : undefined;
    const disabled = meta.busy || meta.workflow.run.status === 'running' || !!local.edit;
    return `<article class="requirement ${requirement.included ? '' : 'excluded'}" data-requirement="${esc(requirement.id)}"><div class="row"><h3>${esc(requirement.title)}</h3>${badge(requirement.basis === 'human' ? t.human : t.source, 'blue')}${!requirement.included ? badge(t.excluded) : ''}</div>${edit ? `<form id="requirement-editor" class="requirement-editor"><label class="field" for="requirement-title">${esc(t.editTitle)}</label><input id="requirement-title" required value="${esc(edit.title)}"><label class="field" for="requirement-text">${esc(t.editBody)}</label><textarea id="requirement-text" required rows="6">${esc(edit.text)}</textarea>${edit.revision !== meta.workflow.revision ? `<p class="error-box">${esc(t.errors.staleResult)}</p>` : ''}<div class="row actions"><button type="button" data-action="cancel-edit" ${edit.saving ? 'disabled' : ''}>${esc(t.cancel)}</button><button class="primary" type="submit" ${edit.saving ? 'disabled' : ''}>${esc(t.save)}</button></div></form>` : `<div class="requirement-body">${meta.requirementHtml[requirement.id] ?? esc(requirement.text)}</div>`}${!requirement.included ? `<p class="hint">${esc(requirement.exclusionReason ?? '')}</p>` : ''}${renderOrigins(requirement)}${!edit ? `<div class="row actions"><button class="link" data-action="edit" data-id="${esc(requirement.id)}" ${disabled ? 'disabled' : ''}>${esc(t.edit)}</button><button class="link" data-action="${requirement.included ? 'exclude' : 'include'}" data-id="${esc(requirement.id)}" ${disabled ? 'disabled' : ''}>${esc(requirement.included ? t.exclude : t.include)}</button></div>` : ''}</article>`;
  }
  function renderPreparation(): void {
    const wf = meta.workflow;
    const selected = wf.materials.filter((item) => item.selected);
    const requirements = [...wf.understanding.requirements];
    if (local.edit && !requirements.some((item) => item.id === local.edit?.id)) requirements.unshift(local.edit.original);
    const included = wf.understanding.requirements.some((item) => item.included);
    const disabled = meta.busy || wf.run.status === 'running';
    const understandingReady = wf.understanding.status === 'ready';
    main.innerHTML = `<div class="prepare"><h1>${esc(t.prepareTitle)}</h1><section class="card"><div class="section-heading"><h2>1 · ${esc(t.target)}</h2><button class="link" data-action="scope" ${disabled || local.edit ? 'disabled' : ''}>${esc(t.chooseTarget)}</button></div><p>${esc(common.repoName)} · ${esc(common.label)}</p><p class="hint">${esc(common.branch ?? '')}</p></section><section class="card"><div class="section-heading"><h2>2 · ${esc(t.materials)} <span class="muted">${esc(t.optional)}</span></h2></div><div class="row"><button data-action="text" ${disabled ? 'disabled' : ''}>${esc(t.addText)}</button><button data-action="file-source" ${disabled ? 'disabled' : ''}>${esc(t.addFile)}</button><button data-action="link-source" ${disabled ? 'disabled' : ''}>${esc(t.addLink)}</button></div><p class="hint">${esc(t.materialPrivacy)}</p><details class="extra"><summary>${esc(t.materialFormats.split('.')[0])}</summary><p>${esc(t.materialFormats)}</p></details><div class="source-list">${selected.map((item) => `<div class="source-row"><button data-action="source" data-id="${esc(item.id)}" data-version="${item.version}">${esc(item.label)} · v${item.version}</button><button class="link" data-action="remove-source" data-id="${esc(item.id)}" ${disabled ? 'disabled' : ''}>${esc(t.remove)}</button></div>`).join('')}</div></section><section class="card"><div class="section-heading"><h2>3 · ${esc(t.understanding)}</h2><button class="link" data-action="human" ${disabled ? 'disabled' : ''}>${esc(t.addHuman)}</button></div>${wf.understanding.status === 'pending' ? `<p class="hint" role="status">${esc(t.understandingBusy)}</p>` : wf.understanding.status === 'failed' ? `<div class="error-box error">${esc(wf.understanding.error === 'interrupted' ? t.interrupted : wf.understanding.error ?? t.errors.understandingFailed)}<div><button class="link" data-action="understand">${esc(t.understandingRetry)}</button></div></div>` : ''}${wf.understanding.summary ? `<p class="hint">${esc(wf.understanding.summary)}</p>` : ''}${requirements.length ? requirements.map(requirementRow).join('') : `<p class="hint">${esc(t.noRequirements)}</p>`}${wf.understanding.checks.length ? `<details class="extra"><summary>${esc(t.checks)}</summary><ul>${wf.understanding.checks.map((item) => `<li>${esc(item.text)}</li>`).join('')}</ul></details>` : ''}${wf.understanding.questions.length ? `<details class="extra"><summary>${esc(t.questions)}</summary><ul>${wf.understanding.questions.map((item) => `<li>${esc(item.text)}</li>`).join('')}</ul></details>` : ''}${wf.retiredRequirements?.length || wf.baselineHistory.length ? `<details class="extra"><summary>${esc(t.history)}</summary>${(wf.retiredRequirements ?? []).map((item) => `<p>${esc(item.title)}: ${esc(item.text)}</p>`).join('')}${wf.baselineHistory.map((item) => `<p>${esc(fmt(t.baselineVersion, item.version))}</p>`).join('')}</details>` : ''}</section><div class="prepare-footer"><p class="hint">${esc(local.edit ? t.unsavedEdit : included ? t.confirmationBoundary : t.technical)}</p><button class="primary" data-action="run" ${disabled || local.edit || !understandingReady ? 'disabled' : ''}>${esc(included && !meta.requirementsConfirmed ? t.confirmStart : t.start)}</button></div></div>`;
  }

  function sourceRow(index: number): string {
    if (!source) return '';
    const diff = local.codeView === 'diff' && source.diffLines;
    const row = diff ? source.diffLines?.[index] : undefined;
    const line = row ? row.newLine : index + 1;
    const old = row?.oldLine;
    const kind = row?.kind ?? 'context';
    const html = kind === 'deleted' ? row?.html ?? '' : source.sourceLines[(line ?? 1) - 1] ?? '';
    const visibleLine = line ?? (source.deleted ? old : undefined);
    return `<div class="code-line ${diff ? '' : 'source'} ${kind === 'added' ? 'added' : kind === 'deleted' ? 'deleted' : ''}" ${visibleLine ? `data-line="${visibleLine}"` : ''}>${diff ? `<span class="ln">${old ?? ''}</span>` : ''}<span class="ln">${line ?? old ?? ''}</span><span class="change">${kind === 'added' ? '+' : kind === 'deleted' ? '-' : ''}</span><code>${html || ' '}</code></div>`;
  }
  function flushSeen(): void {
    if (seenTimer !== undefined) window.clearTimeout(seenTimer);
    while (seen.size) {
      const lines = [...seen].slice(0, 1000);
      lines.forEach((line) => seen.delete(line));
      center({ action: 'seen', path: seenPath, revision: seenRevision, lines });
    }
    seenTimer = undefined;
  }
  function observeSource(): void {
    if (!source || source.deleted || !document.getElementById('source-lines')) return;
    if (seenPath !== source.path || seenRevision !== source.revision) {
      flushSeen();
      seenPath = source.path;
      seenRevision = source.revision;
    }
    const generation = sourceGeneration;
    visibility ??= new IntersectionObserver((entries) => {
      if (generation !== sourceGeneration || document.visibilityState !== 'visible') return;
      for (const entry of entries) {
        if (entry.isIntersecting && entry.target instanceof HTMLElement) {
          const line = Number(entry.target.dataset.line);
          if (line > 0) seen.add(line);
        }
      }
      if (seenTimer !== undefined) window.clearTimeout(seenTimer);
      seenTimer = window.setTimeout(flushSeen, 100);
    }, { root: element('source-scroll'), threshold: 0.1 });
    main.querySelectorAll('.code-line[data-line]').forEach((node) => {
      if (!observed.has(node)) { observed.add(node); visibility?.observe(node); }
    });
  }
  function revealSource(): void {
    if (pendingReveal === undefined) return;
    const row = main.querySelector<HTMLElement>(`.code-line[data-line="${pendingReveal}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      pendingReveal = undefined;
    }
  }
  function renderMarkers(): void {
    main.querySelectorAll('.finding-marker').forEach((node) => node.remove());
    main.querySelectorAll('.code-line.focused').forEach((node) => node.classList.remove('focused'));
    const finding = currentFinding();
    const concern = currentConcern();
    const proof = concern?.evidence.find((item) => item.file === source?.path);
    if (!source || (!finding && !proof) || (finding && finding.path !== source.path)) return;
    const modelFinding = source.findings.find((item) => item.id === finding?.id);
    const line = modelFinding?.line ?? finding?.line ?? proof?.line;
    const node = line ? main.querySelector<HTMLElement>(`.code-line[data-line="${line}"]`) : undefined;
    if (!node) return;
    node.classList.add('focused');
    const marker = document.createElement('button');
    marker.className = 'finding-marker';
    marker.dataset.action = 'focus-judgment';
    marker.textContent = `${finding?.id ?? concern?.id ?? ''} · ${t.viewJudgment}`;
    node.after(marker);
  }
  function renderSource(): void {
    if (!element('center-main').querySelector('#source-scroll')) {
      main.innerHTML = `<div class="source-tools"><span id="source-path" class="source-path"></span><div id="view-controls" class="view-controls"></div></div><div id="source-status"></div><div id="source-scroll" class="source-scroll"></div><div id="selection-tools" class="selection-tools" hidden></div>`;
      sourceKey = '';
    }
    element('source-path').textContent = source?.path ?? t.selectFile;
    if (source && sourcePath !== source.path) {
      const scroll = element('source-scroll');
      if (sourcePath) sourcePositions.set(sourcePath, scroll.scrollTop);
      sourcePath = source.path;
      local.codeView = source.defaultToDiff ? 'diff' : source.isMarkdown ? 'reading' : 'source';
      sourceKey = '';
    }
    const controls = source ? [
      ...(source.diffLines ? [['diff', t.diff]] : []),
      ['source', source.deleted ? t.deletedSource : t.sourceCode],
      ...(source.isMarkdown ? [['reading', t.read]] : []),
      ...(source.translationHtml ? [['bilingual', t.translateWhole]] : []),
    ] : [];
    element('view-controls').innerHTML = controls.map(([view, label]) => `<button class="${local.codeView === view ? 'active' : ''}" data-action="code-view" data-view="${view}">${esc(label)}</button>`).join('') + (source ? `<button data-action="open-document">${esc(t.openDocument)}</button><button data-action="focus">${local.focus ? '↔' : '⤢'}</button>` : '');
    const wf = meta.workflow;
    const limitations = [...wf.run.limitations, ...wf.run.failed.filter((item) => item.path === common.selected).map((item) => `${item.path}: ${item.error}`)];
    element('source-status').innerHTML = `${meta.progress ? `<div class="status-strip">${esc(meta.progress)}</div>` : ''}${wf.interrupted ? `<div class="status-strip">${esc(t.interrupted)}</div>` : ''}${wf.run.status === 'stale' ? `<div class="status-strip">${esc(t.stale)}</div>` : ''}${limitations.length ? `<div class="status-strip"><ul>${limitations.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div>` : ''}`;
    const scroll = element('source-scroll');
    if (!source) {
      scroll.innerHTML = `<div class="empty">${esc(meta.busy ? t.openingSource : t.selectFile)}</div>`;
      sourceKey = '';
      return;
    }
    const key = `${source.path}:${source.revision}:${local.codeView}:${source.diffLines?.length ?? 0}`;
    if (key !== sourceKey) {
      sourceKey = key;
      sourceGeneration++;
      visibility?.disconnect();
      visibility = undefined;
      observed = new WeakSet();
      const generation = sourceGeneration;
      if (local.codeView === 'reading' && source.readingHtml) {
        scroll.innerHTML = `<article class="reading">${source.readingHtml}</article>`;
      } else if (local.codeView === 'bilingual' && source.translationHtml) {
        scroll.innerHTML = `<div class="reading bilingual"><article>${source.readingHtml ?? esc(source.raw.join('\n'))}</article><article>${source.translationHtml}</article></div>`;
      } else {
        const total = local.codeView === 'diff' && source.diffLines ? source.diffLines.length : source.sourceLines.length;
        const plan = source.renderPlan;
        let next = Math.min(plan.initial, total);
        scroll.innerHTML = `<div id="source-lines">${Array.from({ length: next }, (_, index) => sourceRow(index)).join('')}</div><details id="source-annotations" class="annotations"></details>`;
        const append = () => {
          if (generation !== sourceGeneration || !source) return;
          const end = Math.min(total, next + (plan.perFrame || total));
          element('source-lines').insertAdjacentHTML('beforeend', Array.from({ length: end - next }, (_, offset) => sourceRow(next + offset)).join(''));
          next = end;
          renderMarkers();
          observeSource();
          revealSource();
          if (next < total) window.requestAnimationFrame(append);
        };
        if (next < total) window.requestAnimationFrame(append);
      }
      scroll.scrollTop = sourcePositions.get(source.path) ?? 0;
      observeSource();
    }
    const annotations = document.getElementById('source-annotations');
    if (annotations) {
      annotations.hidden = source.annotations.length === 0;
      annotations.innerHTML = `<summary>${esc(t.annotations)} · ${source.annotations.length}</summary>${source.annotations.map((item) => `<article>${source?.annotationHtml[item.id] ?? esc(item.content)}<button class="link" data-action="remove-annotation" data-id="${esc(item.id)}">${esc(t.remove)}</button></article>`).join('')}`;
    }
    renderMarkers();
    revealSource();
  }

  function evidenceLinks(evidence: readonly { file: string; line: number }[]): string {
    return evidence.map((item) => `<button class="link" data-action="evidence" data-path="${esc(item.file)}" data-line="${item.line}">${esc(item.file)}:${item.line}</button>`).join('<br>');
  }
  function renderInspector(): void {
    const finding = currentFinding();
    const concern = currentConcern();
    const inactive = (finding ? !finding.current : !meta.current || !meta.workflow.run.globalComplete || !!meta.workflow.run.unreviewedConcerns?.includes(concern?.id ?? '')) || meta.workflow.run.status === 'running';
    if (!finding && !concern) {
      inspector.innerHTML = `<div class="inspector-head">${esc(t.currentJudgment)}</div><div class="empty">${esc(t.noFindings)}</div>`;
      return;
    }
    const title = finding?.title ?? concern?.title ?? '';
    const detail = finding?.detail ?? concern?.detail ?? '';
    const verification = finding?.verification;
    const statusText = finding ? status(finding) : [concern?.status === 'resolved' ? t.resolved : t.unresolved, concern?.critical && concern.status === 'open' ? 'amber' : 'blue'];
    inspector.innerHTML = `<div class="inspector-head"><span>${esc(t.currentJudgment)}</span><button class="link" data-action="next" title="${esc(t.next)} (F8)">${esc(t.next)}</button></div><div class="inspector-scroll"><div class="row">${badge(finding?.id ?? concern?.id ?? '')}${badge(finding ? verification?.status === 'overturned' ? t.reasonable : t.implementation : concern?.kind === 'requirement' ? t.requirement : t.question, String(statusText[1]))}${badge(String(statusText[0]), String(statusText[1]))}${concern?.critical && concern.status === 'open' ? badge(t.critical, 'amber') : ''}${inactive ? badge(t.historical, 'amber') : ''}</div><h2 class="inspector-title" id="judgment-title" tabindex="-1">${esc(title)}</h2><p class="inspector-summary">${esc(detail)}</p>${finding?.suggestion ? `<section class="inspector-section"><h3>${esc(t.fix)}</h3><p>${esc(finding.suggestion)}</p></section>` : ''}${concern ? `<section class="inspector-section"><p>${esc(concern.impact)}</p></section>` : ''}${verification?.rationale ? `<section class="inspector-section"><h3>${esc(t.evidence)}</h3><p>${esc(verification.rationale)}</p>${evidenceLinks(verification.evidence)}</section>` : ''}${concern?.evidence.length ? `<section class="inspector-section"><h3>${esc(t.evidence)}</h3>${evidenceLinks(concern.evidence)}</section>` : ''}${finding?.dispositionReason ? `<section class="inspector-section"><h3>${esc(t.dispositions)}</h3><p>${esc(finding.dispositionReason)}</p></section>` : ''}</div><div class="inspector-actions"><div class="row">${finding && verification?.status !== 'unresolved' && verification?.status !== 'overturned' ? `<button class="primary" data-action="fix" ${inactive ? 'disabled' : ''}>${esc(t.fix)}</button><button data-action="comment-finding" ${inactive ? 'disabled' : ''}>${esc(t.commentFinding)}</button><button class="link" data-action="ignore-finding" ${inactive ? 'disabled' : ''}>${esc(t.ignore)}</button>` : `<button data-action="add-evidence" ${meta.workflow.run.status === 'running' ? 'disabled' : ''}>${esc(t.addEvidence)}</button>`}</div></div>`;
  }

  function renderConclusion(): void {
    const wf = meta.workflow;
    const verdict = wf.verdict;
    const blockers = [...meta.blockers[verdict], ...(local.edit ? [t.unsavedEdit] : [])];
    const notesFocused = document.activeElement?.id === 'review-notes';
    const previousPosition = main.querySelector('.conclusion')?.scrollTop ?? 0;
    main.innerHTML = `<div class="conclusion"><h1>${esc(t.reportTitle)}</h1><p class="hint">${esc(common.repoName)} · ${esc(common.label)}</p>${common.conclusion?.verdict === verdict ? `<p class="error-box">${esc(fmt(common.conclusion.target === 'pr' ? t.submitted : t.recorded, common.conclusion.label))}</p>` : ''}${wf.run.limitations.length ? `<p class="hint">${esc(t.limitations)} · ${wf.run.limitations.length}</p>` : ''}<label class="field" for="review-notes">${esc(t.notes)} · ${esc(t.optional)}</label><textarea id="review-notes" maxlength="64000" rows="3">${esc(local.notes)}</textarea><section class="card"><div class="section-heading"><h2>${esc(t.reportPreview)}</h2><div class="row"><button class="link" data-action="copy">${esc(t.copy)}</button><button class="link" data-action="save-report">${esc(t.download)}</button></div></div><pre id="report-preview" class="report">${esc(reportText())}</pre></section></div>`;
    const scroller = main.querySelector<HTMLElement>('.conclusion');
    if (scroller) scroller.scrollTop = previousPosition;
    if (notesFocused) input('review-notes').focus({ preventScroll: true });
    inspector.innerHTML = `<div class="inspector-head">${esc(t.conclusion)}</div><div class="inspector-scroll">${(['approve', 'request-changes', 'comment'] as const).map((value) => `<label class="verdict-option"><input type="radio" name="review-verdict" value="${value}" ${verdict === value ? 'checked' : ''}><span>${esc(titleFor(value))}<small>${esc(value === 'approve' ? t.approvalNote : t.feedbackNote)}</small></span></label>`).join('')}${blockers.length ? `<section class="blockers" role="status"><strong>${esc(t.blocked)}</strong><ul>${blockers.map((item) => `<li>${esc(item)}</li>`).join('')}</ul><button class="link" data-action="stage" data-stage="${meta.requirementsConfirmed && meta.current ? 'review' : 'prepare'}">${esc(meta.requirementsConfirmed && meta.current ? t.backReview : t.backPrepare)}</button></section>` : ''}</div><div class="inspector-actions"><button class="primary" data-action="submit" ${blockers.length || meta.busy || wf.run.status === 'running' ? 'disabled' : ''}>${esc(fmt(t.submit, titleFor(verdict)))}</button></div>`;
  }

  function render(): void {
    const active = document.activeElement;
    const focusedId = active?.id;
    const selection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : undefined;
    renderHeader();
    if (meta.workflow.stage !== 'review') {
      const scroller = document.getElementById('source-scroll');
      if (source && scroller) sourcePositions.set(source.path, scroller.scrollTop);
      sourceGeneration++;
      visibility?.disconnect();
      visibility = undefined;
      observed = new WeakSet();
      flushSeen();
      selectedLines = undefined;
      sourceKey = '';
    }
    if (meta.workflow.stage === 'prepare') {
      navigation.innerHTML = '';
      inspector.innerHTML = '';
      const top = main.querySelector('.prepare')?.scrollTop ?? 0;
      renderPreparation();
      const estimate = document.createElement('p');
      estimate.className = 'hint';
      const roots = files.filter((file) => !file.context).length;
      estimate.textContent = fmt(t.requestEstimate, roots + 2, roots * 2 + 2);
      main.querySelector('.prepare-footer')?.before(estimate);
      const target = main.querySelector('.prepare .card .hint');
      if (target) target.textContent = `${common.branch ?? ''} · ${t.codeSnapshot}: ${meta.headSha === 'live' ? t.workspaceSnapshot : meta.headSha.slice(0, 12)}${meta.baseSha ? ` / ${meta.baseSha.slice(0, 12)}` : ''}`;
      const scroller = main.querySelector<HTMLElement>('.prepare');
      if (scroller) scroller.scrollTop = top;
    } else {
      renderNavigation();
      if (meta.workflow.stage === 'conclusion') {
        renderConclusion();
        if (local.notes.trim() !== meta.workflow.notes.trim()) main.querySelector('.conclusion > .error-box')?.remove();
        const target = document.createElement('p');
        target.className = 'hint';
        target.textContent = meta.prNumber === undefined ? t.localApprovalBody : fmt(t.prApprovalBody, meta.prNumber);
        inspector.querySelector('.inspector-actions')?.prepend(target);
      }
      else {
        renderSource();
        renderInspector();
        if (currentFinding()?.applied) {
          const undo = document.createElement('button');
          undo.dataset.action = 'undo-fix';
          undo.textContent = t.undoFix;
          undo.disabled = meta.busy === true || meta.workflow.run.status === 'running';
          inspector.querySelector('.inspector-actions .row')?.append(undo);
        }
      }
    }
    if (focusedId) {
      const next = document.getElementById(focusedId);
      if (next instanceof HTMLElement) {
        next.focus({ preventScroll: true });
        if (selection?.[0] !== null && selection?.[0] !== undefined && selection[1] !== null
          && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) next.setSelectionRange(selection[0], selection[1]);
      }
    }
    persist();
  }

  function editRequirement(id: string): void {
    if (local.edit && local.edit.id !== id) return notice(t.unsavedEdit, true);
    const requirement = meta.workflow.understanding.requirements.find((item) => item.id === id);
    if (!requirement) return notice(t.errors.invalidUnderstanding, true);
    local.edit ??= { id, title: requirement.title, text: requirement.text, revision: meta.workflow.revision, original: requirement };
    center({ action: 'editing', id });
    render();
    input('requirement-title').focus();
  }
  function materialDialog(human = false): void {
    openDialog(human ? t.addHuman : t.addText, `<form id="material-form" data-human="${human}"><label class="field" for="material-name">${esc(t.materialName)}</label><input id="material-name" ${human ? 'required' : ''}><label class="field" for="material-text">${esc(t.materialBody)}</label><textarea id="material-text" maxlength="64000" required></textarea><p class="hint">${esc(t.materialPrivacy)}</p></form>`, `<button data-action="close">${esc(t.cancel)}</button><button class="primary" type="submit" form="material-form">${esc(t.save)}</button>`);
  }

  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action]') : null;
    if (!button || (button instanceof HTMLButtonElement && button.disabled)) return;
    const action = button.dataset.action;
    if (action === 'close') { sourceReadRequest = undefined; menuKind = undefined; return dialog.close(); }
    if (action === 'stage') {
      const stage = button.dataset.stage;
      if (stage === 'prepare' || stage === 'review' || stage === 'conclusion') center({ action: 'stage', stage });
    } else if (action === 'scope') post({ type: 'pickScope' });
    else if (action === 'project') openDialog(t.project, common.projects.map((item) => `<button class="nav-item" data-action="choose-project" data-cwd="${esc(item.cwd)}">${esc(item.name)}${item.current ? ' ✓' : ''}</button>`).join(''));
    else if (action === 'choose-project') { post({ type: 'pickProjectCwd', cwd: button.dataset.cwd ?? '' }); dialog.close(); }
    else if (action === 'model') {
      menuKind = 'model';
      openDialog(t.model, `<p class="hint">${esc(t.openingSource)}</p>`);
      post({ type: 'openDynMenu', kind: 'model' });
    } else if (action === 'choose-model') {
      post({ type: 'applyDynMenu', kind: 'model', id: button.dataset.id ?? '' });
      menuKind = undefined;
      dialog.close();
    } else if (action === 'language') openDialog(t.language, common.languages.map((item) => `<button class="nav-item" data-action="choose-language" data-id="${esc(item.id)}">${esc(item.label)}${item.current ? ' ✓' : ''}</button>`).join(''));
    else if (action === 'choose-language') { post({ type: 'pickLanguageId', id: button.dataset.id ?? '' }); dialog.close(); }
    else if (action === 'navigation') {
      const tab = button.dataset.tab;
      if (tab === 'business' || tab === 'findings' || tab === 'files') { local.navigation = tab; render(); }
    } else if (action === 'more') { local.fileLimit += 200; renderNavigation(); }
    else if (action === 'finding') chooseFinding(button.dataset.ref ?? '');
    else if (action === 'file') post({ type: 'select', path: button.dataset.path ?? '' });
    else if (action === 'concern') {
      chooseConcern(button.dataset.id ?? '');
    } else if (action === 'next') nextFinding();
    else if (action === 'code-view') {
      const view = button.dataset.view;
      if (view === 'source' || view === 'diff' || view === 'reading' || view === 'bilingual') { local.codeView = view; renderSource(); persist(); }
    } else if (action === 'focus') { local.focus = !local.focus; renderHeader(); persist(); }
    else if (action === 'focus-judgment') element('judgment-title').focus({ preventScroll: false });
    else if (action === 'text' || action === 'human' || action === 'add-evidence') materialDialog(action === 'human');
    else if (action === 'file-source') center({ action: 'add-file' });
    else if (action === 'link-source') {
      openDialog(t.addLink, `<form id="link-form"><label class="field" for="material-url">${esc(t.materialUrl)}</label><input type="url" required id="material-url" placeholder="https://"><p class="hint">${esc(t.materialFormats)}</p></form>`, `<button data-action="close">${esc(t.cancel)}</button><button class="primary" type="submit" form="link-form">${esc(t.read)}</button>`);
    } else if (action === 'source') {
      const id = button.dataset.id ?? '';
      const version = Number(button.dataset.version);
      sourceReadRequest = `${id}:${version}`;
      openDialog(t.sourceReadTitle, `<p class="hint">${esc(t.openingSource)}</p>`);
      center({ action: 'read-source', id, version });
    } else if (action === 'remove-source') center({ action: 'remove-source', id: button.dataset.id ?? '' });
    else if (action === 'edit') editRequirement(button.dataset.id ?? '');
    else if (action === 'cancel-edit') { local.edit = undefined; center({ action: 'editing', id: '' }); render(); }
    else if (action === 'exclude') {
      openDialog(t.exclusionReason, `<form id="exclusion-form" data-id="${esc(button.dataset.id ?? '')}"><textarea id="exclusion-reason" required aria-label="${esc(t.exclusionReason)}"></textarea></form>`, `<button data-action="close">${esc(t.cancel)}</button><button class="primary" type="submit" form="exclusion-form">${esc(t.save)}</button>`);
    } else if (action === 'include') center({ action: 'include', id: button.dataset.id ?? '', included: true, reason: '', revision: meta.workflow.revision });
    else if (action === 'understand') center({ action: 'understand' });
    else if (action === 'run') {
      if (local.edit) return notice(t.unsavedEdit, true);
      center({ action: 'run', confirmed: meta.workflow.stage === 'prepare', resume: ['partial', 'cancelled'].includes(meta.workflow.run.status), revision: meta.workflow.revision });
    } else if (action === 'cancel-run') center({ action: 'cancel' });
    else if (action === 'fix' || action === 'undo-fix') {
      const finding = currentFinding();
      if (finding) center({ action, path: finding.path, id: finding.id, ref: finding.ref, global: finding.global === true });
    } else if (action === 'comment-finding' || action === 'ignore-finding') {
      const finding = currentFinding();
      if (finding) center({ action: 'dispose', path: finding.path, id: finding.id, ref: finding.ref, global: finding.global === true, kind: action === 'comment-finding' ? 'commented' : 'ignored' });
    } else if (action === 'evidence') center({ action: 'evidence', path: button.dataset.path ?? '', line: Number(button.dataset.line) });
    else if (action === 'open-document' && source) center({ action: 'open-document', path: source.path });
    else if (action === 'remove-annotation' && source) center({ action: 'remove-annotation', path: source.path, id: button.dataset.id ?? '' });
    else if (action === 'copy' || action === 'save-report') {
      center({ action, notes: local.notes, preview: reportText() });
    } else if (action === 'submit') {
      if (local.edit) return notice(t.unsavedEdit, true);
      center({ action: 'submit', verdict: meta.workflow.verdict, notes: local.notes, preview: reportText() });
    } else if (action === 'selection' && selectedLines) {
      const command = button.dataset.command;
      if (command === 'translate' || command === 'explain' || command === 'note' || command === 'comment') {
        center({ action: 'document-action', command, ...selectedLines });
        element('selection-tools').hidden = true;
      }
    }
  });

  document.addEventListener('submit', (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    event.preventDefault();
    const form = event.target;
    if (!form.reportValidity()) return;
    if (form.id === 'material-form') {
      center({ action: 'text', label: input('material-name').value, text: input('material-text').value, human: form.dataset.human === 'true' });
      dialog.close();
    } else if (form.id === 'link-form') {
      center({ action: 'link', url: input('material-url').value });
      dialog.close();
    } else if (form.id === 'exclusion-form') {
      center({ action: 'include', id: form.dataset.id ?? '', included: false, reason: input('exclusion-reason').value, revision: meta.workflow.revision });
      dialog.close();
    } else if (form.id === 'requirement-editor' && local.edit) {
      local.edit.title = input('requirement-title').value;
      local.edit.text = input('requirement-text').value;
      if (local.edit.title === local.edit.original.title && local.edit.text === local.edit.original.text) {
        local.edit = undefined;
        center({ action: 'editing', id: '' });
        return render();
      }
      local.edit.saving = true;
      center({ action: 'revise', id: local.edit.id, title: local.edit.title, text: local.edit.text, revision: local.edit.revision });
      render();
    }
  });

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    if (target.id === 'center-search') { local.search = target.value; local.fileLimit = 200; render(); }
    if (target.id === 'requirement-title' && local.edit) local.edit.title = target.value;
    if (target.id === 'requirement-text' && local.edit) local.edit.text = target.value;
    if (target.id === 'review-notes') {
      local.notes = target.value;
      local.notesDirty = true;
      if (local.notes.trim() !== meta.workflow.notes.trim()) main.querySelector('.conclusion > .error-box')?.remove();
      element('report-preview').textContent = reportText();
      if (notesTimer !== undefined) window.clearTimeout(notesTimer);
      notesTimer = window.setTimeout(() => center({ action: 'notes', text: local.notes }), 180);
    }
    persist();
  });
  document.addEventListener('change', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.name === 'review-verdict') {
      const verdict = event.target.value;
      if (verdict === 'approve' || verdict === 'request-changes' || verdict === 'comment') center({ action: 'verdict', verdict });
      const submit = inspector.querySelector<HTMLButtonElement>('[data-action=submit]');
      if (submit) submit.disabled = true;
      main.querySelector('.conclusion > .error-box')?.remove();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dialog.open) { sourceReadRequest = undefined; dialog.close(); }
    if (event.key === 'F8' && !dialog.open && meta.workflow.stage === 'review') { event.preventDefault(); nextFinding(); }
  });
  document.addEventListener('mouseup', (event) => {
    if (!source || source.deleted || meta.workflow.stage !== 'review' || !(event.target instanceof Element) || !event.target.closest('.source-scroll')) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const startNode = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const endNode = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
    const startRow = startNode?.closest<HTMLElement>('.code-line[data-line]');
    const endRow = endNode?.closest<HTMLElement>('.code-line[data-line]');
    const startCode = startRow?.querySelector('code');
    const endCode = endRow?.querySelector('code');
    if (!startRow || !endRow || !startCode?.contains(range.startContainer) || !endCode?.contains(range.endContainer)) return;
    const start = Number(startRow.dataset.line);
    const end = Number(endRow.dataset.line);
    if (!Number.isInteger(start) || end < start || !source.raw[start - 1] || source.raw[end - 1] === undefined) return;
    const prefix = document.createRange();
    prefix.selectNodeContents(startCode);
    prefix.setEnd(range.startContainer, range.startOffset);
    const suffix = document.createRange();
    suffix.selectNodeContents(endCode);
    suffix.setEnd(range.endContainer, range.endOffset);
    const selected = source.raw.slice(start - 1, end);
    selected[0] = selected[0].slice(prefix.toString().length);
    selected[selected.length - 1] = selected[selected.length - 1].slice(0, end === start ? suffix.toString().length - prefix.toString().length : suffix.toString().length);
    const text = selected.join('\n');
    if (!text.trim()) return;
    selectedLines = { path: source.path, start, end, text, revision: source.revision };
    const toolbar = element('selection-tools');
    toolbar.innerHTML = (['translate', 'explain', 'note', 'comment'] as const).map((command) => `<button data-action="selection" data-command="${command}">${esc(command === 'comment' ? t.reviewComment : t[command])}</button>`).join('');
    toolbar.style.top = `${Math.max(45, range.getBoundingClientRect().bottom - main.getBoundingClientRect().top + 5)}px`;
    toolbar.hidden = false;
  });

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    if ('scopeKey' in message && message.scopeKey !== meta.workflow.scopeKey) return;
    if (message.type === 'center-state' && 'state' in message) {
      const update = message as ReviewCenterUpdate;
      common = update.state;
      if (update.files) files = update.files;
      if (update.fileUpdates) {
        const changes = new Map(update.fileUpdates.map((item) => [item.path, item]));
        files = files.map((item) => changes.get(item.path) ?? item);
      }
      if (update.center) {
        if (update.center.workflow.scopeKey !== meta.workflow.scopeKey) {
          flushSeen();
          sourceGeneration++;
          visibility?.disconnect();
          visibility = undefined;
          observed = new WeakSet();
          source = undefined;
          sourceReadRequest = undefined;
          menuKind = undefined;
          selectedLines = undefined;
          sourcePositions.clear();
          if (notesTimer !== undefined) window.clearTimeout(notesTimer);
          if (dialog.open) dialog.close();
        }
        meta = update.center;
        if (local.scopeKey !== meta.workflow.scopeKey) {
          local = { scopeKey: meta.workflow.scopeKey, navigation: 'business', search: '', codeView: 'source', focus: false, fileLimit: 200, notes: meta.workflow.notes };
          sourceKey = '';
        }
        if (local.edit?.saving && meta.workflow.revision > local.edit.revision) {
          const current = meta.workflow.understanding.requirements.find((item) => item.id === local.edit?.id);
          if (current?.basis === 'human' && current.text === local.edit.text && current.title === local.edit.title.trim()) local.edit = undefined;
        }
        if (!local.notesDirty || meta.workflow.notes === local.notes) {
          local.notes = meta.workflow.notes;
          local.notesDirty = false;
        }
      }
      if (update.document !== undefined) source = update.document ?? undefined;
      if (update.documentPatch && source?.path === update.documentPatch.path && source.revision === update.documentPatch.revision) {
        source = { ...source, ...update.documentPatch, translationHtml: update.documentPatch.translationHtml ?? undefined };
      }
      if (local.finding && !meta.findings.some((item) => item.ref === local.finding)) local.finding = undefined;
      if (!local.finding && !local.concern && meta.findings.length) local.finding = meta.findings.find((item) => item.path === common.selected)?.ref ?? meta.findings[0].ref;
      render();
    } else if (message.type === 'dynMenu' && 'kind' in message && message.kind === 'model' && menuKind === 'model'
      && dialog.open && 'items' in message && Array.isArray(message.items)) {
      const items = message.items.filter((item): item is { id: string; label: string; current: boolean } =>
        item && typeof item === 'object' && typeof item.id === 'string' && typeof item.label === 'string' && typeof item.current === 'boolean');
      openDialog(t.model, items.map((item) => `<button class="nav-item" data-action="choose-model" data-id="${esc(item.id)}">${esc(item.label)}${item.current ? ' ✓' : ''}</button>`).join(''));
    } else if (message.type === 'notice' && 'message' in message && typeof message.message === 'string') {
      notice(message.message, 'kind' in message && message.kind === 'error');
    } else if (message.type === 'focusTree') {
      document.getElementById('center-search')?.focus();
    } else if (message.type === 'center-source' && 'id' in message && 'version' in message
      && 'html' in message && typeof message.html === 'string' && 'text' in message && typeof message.text === 'string'
      && 'title' in message && typeof message.title === 'string') {
      if (sourceReadRequest !== `${String(message.id)}:${String(message.version)}`) return;
      openDialog(message.title, `<div class="requirement-body">${message.html}</div><details class="extra"><summary>${esc(t.source)}</summary><pre class="raw-source">${esc(message.text)}</pre></details>`);
    } else if (message.type === 'center-copy-fallback' && 'text' in message && typeof message.text === 'string') {
      openDialog(t.copy, `<textarea id="copy-fallback" readonly aria-label="${esc(t.copy)}">${esc(message.text)}</textarea>`);
      input('copy-fallback').focus();
      input('copy-fallback').select();
    } else if (message.type === 'center-reveal' && 'line' in message && typeof message.line === 'number'
      && source && 'path' in message && message.path === source.path && 'revision' in message && message.revision === source.revision) {
      pendingReveal = message.line;
      revealSource();
    }
  });
  window.addEventListener('error', (event) => center({ action: 'client-error', message: event.message.slice(0, 4000) }));
  document.addEventListener('visibilitychange', () => {
    visibility?.disconnect();
    visibility = undefined;
    observed = new WeakSet();
    if (document.visibilityState === 'visible' && meta.workflow.stage === 'review') observeSource();
  });
  window.addEventListener('unhandledrejection', (event) => center({ action: 'client-error', message: String(event.reason).slice(0, 4000) }));
  if (!local.finding && meta.findings.length) local.finding = meta.findings[0].ref;
  render();
  center({ action: 'ready', editing: local.edit?.id ?? '' });
}
