import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import { m } from '../i18n';
import { esc, escAttr } from '../ui/html';
import { currentBranch, listReviewRefs, repositoryRemoteIdentity, repositoryRoot } from './gitClient';
import { ensureAuth, ensureGhAvailable, listPrs } from '../gh/ghClient';
import type { PrSummary } from '../gh/types';
import type { ReviewSet } from './types';
import { BranchSnapshotScope, PrByNumberScope } from './scopes';
import {
  acceptRequirementUnderstanding, addRequirementMaterial, clearRequirementConfirmation, confirmRequirements, createRequirementsDraft,
  currentMaterial, requirementReadiness, requirementScopeKey, restoreRequirementsDraft, reviseRequirement,
  selectedMaterials, selectRequirementMaterial, updateRequirementMaterial, type RequirementsDraft, type RequirementUnderstanding,
} from '../review/requirements';
import { readRequirementFile, readRequirementLink } from '../review/requirementSources';
import { renderRequirementMarkdown } from '../ui/requirementMarkdown';
import { scopePreparationView } from '../ui/scopePreparationView';
import type { TokenUsage } from '../ai/analyzer';

export interface PreparedScopeChoice {
  cwd: string;
  kind: 'pr' | 'branchChanges' | 'branchFull' | 'files';
  prNumber?: number;
  headRef?: string;
  baseRef?: string;
  reviewSet?: ReviewSet;
  requirements?: RequirementsDraft;
}

interface RepositoryData {
  cwd: string;
  refs: string[];
  current: string;
  repositoryIdentity?: string;
  prs?: PrSummary[];
}

export interface ScopePreparationOptions {
  load?(cwd: string, identity?: string): Promise<{ draft: RequirementsDraft; selection?: PreparedScopeChoice } | undefined>;
  save?(cwd: string, identity: string | undefined, record: { draft: RequirementsDraft; selection?: PreparedScopeChoice }): Promise<void>;
  analyze?(draft: RequirementsDraft, scope: { key: string; description: string }, token: vscode.CancellationToken, usage: (record: TokenUsage) => void): Promise<RequirementUnderstanding>;
  loadScope?(selection: PreparedScopeChoice): Promise<ReviewSet>;
  modelLabel?(): string;
  pickModel?(): Promise<void>;
  onRendered?(report: { materials: number; items: number; unsafeNodes: number; ready: boolean; error?: string }): void;
  onDraftChange?(cwd: string, scope: ReviewSet, draft: RequirementsDraft): Promise<void>;
  onReturn?(stage: 'review' | 'conclusion'): void;
  fileScope?: { cwd: string; set: ReviewSet };
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

export async function loadPreparedScope(selection: PreparedScopeChoice): Promise<ReviewSet> {
  const set = selection.kind === 'pr' && selection.prNumber !== undefined
    ? await new PrByNumberScope(selection.prNumber).load(selection.cwd)
    : selection.headRef ? await new BranchSnapshotScope(selection.headRef, selection.baseRef).load(selection.cwd) : undefined;
  if (!set) throw new Error(m().scope.staleSelection);
  if (!set.files.length) throw new Error(m().scope.emptySnapshot);
  return set;
}

function understandingHtml(draft: RequirementsDraft): string {
  const u = draft.understanding;
  if (!u) return '';
  const t = m().requirements;
  const origin = (ref: { sourceId: string; version: number; line: number; endLine: number; quote: string }) => {
    const source = draft.materials.find((item) => item.id === ref.sourceId);
    return `<details><summary>${esc(source?.name ?? ref.sourceId)} · v${ref.version} · L${ref.line}–${ref.endLine}</summary><pre class="quote">${esc(ref.quote)}</pre><button class="secondary" data-source="${escAttr(ref.sourceId)}" data-version="${ref.version}">${esc(t.raw)}</button></details>`;
  };
  return `<div class="markdown">${renderRequirementMarkdown(u.summary)}</div>${u.requirements.some((item) => item.basis === 'human') ? `<p class="hint">${esc(t.humanNotice)}</p>` : ''}${!u.requirements.length ? `<p>${esc(t.noRequirements)}</p>` : ''}
    ${u.requirements.map((item) => `<article class="item ${item.included ? '' : 'excluded'}"><h3>${esc(item.id)} · ${esc(item.title)}</h3><small>${esc(item.basis === 'human' ? t.human : t.explicit)}${item.included ? '' : ` · ${esc(t.reason)}: ${esc(item.exclusionReason)}`}</small><div class="markdown">${renderRequirementMarkdown(item.text)}</div>${item.origins.map(origin).join('')}<button class="secondary" data-revise="${esc(item.id)}">${esc(t.revise)}</button></article>`).join('')}
    <details><summary>${esc(t.checks)} (${u.checks.length})</summary>${u.checks.map((check) => `<p>${esc(check.requirementIds.join(', '))} · ${esc(check.text)}</p>`).join('')}</details>
    <details><summary>${esc(t.questions)} (${u.questions.length})</summary>${u.questions.map((question) => `<article class="item"><p>${esc(question.text)}</p>${question.origins.map(origin).join('')}</article>`).join('')}</details>
    <details><summary>${esc(t.history)} (${draft.history.length})</summary>${draft.history.map((item) => `<p class="hint">${esc(new Date(item.at).toISOString())} · ${esc(item.action)}</p>`).join('')}
    ${draft.understandingHistory.map((previous) => `<details><summary>${esc(previous.modelId)} · ${esc(new Date(previous.createdAt).toISOString())}</summary>${previous.requirements.map((item) => `<article class="item"><strong>${esc(item.title)}</strong><div class="markdown">${renderRequirementMarkdown(item.text)}</div>${item.origins.map(origin).join('')}</article>`).join('')}</details>`).join('')}</details>
    <p class="hint">${esc(u.modelId)} · ${new Date(u.createdAt).toISOString()}</p>`;
}

export function createScopePreparation(
  defaultCwd: string, viewColumn?: vscode.ViewColumn, initialKind = 'pr', options: ScopePreparationOptions = {},
): { result: Promise<PreparedScopeChoice | undefined>; ready: Promise<boolean>; dispose(): void } {
  const t = m().scope;
  const panel = vscode.window.createWebviewPanel('codereview.scopePreparation', t.prepareTitle,
    viewColumn ?? vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  const roots = [...new Set([defaultCwd, ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)])];
  let data: RepositoryData | undefined;
  let draft = createRequirementsDraft();
  let selection: PreparedScopeChoice | undefined;
  let pinned: ReviewSet | undefined;
  let generation = 0;
  let analysis: vscode.CancellationTokenSource | undefined;
  let requestVersion = 0;
  let reading = false;
  let readAbort: AbortController | undefined;
  let storageBlocked = false;
  let errorMessage = '';
  let settled = false;
  let disposed = false;
  let selectedRoot = defaultCwd;
  let finish!: (value: PreparedScopeChoice | undefined) => void;
  let markReady!: (ready: boolean) => void;
  const result = new Promise<PreparedScopeChoice | undefined>((resolve) => { finish = resolve; });
  const ready = new Promise<boolean>((resolve) => { markReady = resolve; });
  const post = (message: object) => { if (!disposed) void panel.webview.postMessage(message); };
  const cancel = () => {
    requestVersion++; analysis?.cancel(); analysis?.dispose(); analysis = undefined;
    readAbort?.abort(); readAbort = undefined; reading = false;
  };
  const publish = () => {
    const key = pinned && data ? requirementScopeKey(data.cwd, pinned) : '';
    post({ type: 'requirements', state: {
      revision: draft.revision, hasSources: selectedMaterials(draft).length > 0,
      ready: !storageBlocked && !!key && requirementReadiness(draft, key).canConfirm,
      busy: !!analysis, reading, error: errorMessage,
      modelLabel: options.modelLabel?.() ?? 'Auto',
      scopeDescription: pinned
        ? `${pinned.label} · ${m().scope.snapshotNotice(pinned.source?.headRef ?? '', pinned.headSha.slice(0, 12))}${pinned.comparison ? ` / ${m().scope.base}: ${pinned.comparison.baseSha.slice(0, 12)}` : ''}`
        : '',
      usage: draft.usage,
      materials: draft.materials.map((source) => ({
        id: source.id, kind: source.kind, name: source.name, location: source.location, selected: source.selected, version: currentMaterial(source).version,
      })), html: understandingHtml(draft),
    } });
  };
  const notifyDraft = async () => {
    if (data && pinned) await options.onDraftChange?.(data.cwd, pinned, structuredClone(draft));
  };
  const save = async () => {
    if (!data || storageBlocked) throw new Error(m().requirements.loadFailed);
    await options.save?.(data.cwd, data.repositoryIdentity, { draft: structuredClone(draft), selection: selection ? { ...selection } : undefined });
    await notifyDraft();
  };
  const choose = (input: Record<string, unknown>) => {
    const next = validatePreparedScope(data, input);
    if (JSON.stringify(next) !== JSON.stringify(selection)) {
      cancel(); pinned = undefined;
      clearRequirementConfirmation(draft);
      selection = next;
    }
    return next;
  };
  const refreshFiles = async (stillCurrent: () => boolean): Promise<void> => {
    const files = selectedMaterials(draft).filter((source) => source.kind === 'file');
    const reads = await Promise.all(files.map(async (source) => ({ source, loaded: await readRequirementFile(source.location) })));
    if (!stillCurrent()) return;
    let changed = false;
    for (const { source, loaded } of reads) {
      if (loaded.text !== currentMaterial(source).text) {
        updateRequirementMaterial(draft, source.id, loaded.text);
        changed = true;
      }
    }
    if (changed) await save();
  };
  const organize = async (input: Record<string, unknown>, force = false) => {
    if (disposed) return;
    const selected = choose(input);
    const owner = data;
    const ownerDraft = draft;
    cancel();
    const version = requestVersion;
    const run = generation;
    const cts = new vscode.CancellationTokenSource();
    analysis = cts;
    errorMessage = '';
    publish();
    try {
      const set = selected.kind === 'files' && options.fileScope?.cwd === selected.cwd
        ? options.fileScope.set : await (options.loadScope ?? loadPreparedScope)(selected);
      if (disposed || run !== generation || version !== requestVersion) return;
      pinned = set;
      await notifyDraft();
      await refreshFiles(() => !disposed && run === generation && version === requestVersion);
      if (disposed || run !== generation || version !== requestVersion) return;
      const scopeKey = requirementScopeKey(selected.cwd, set);
      const readiness = requirementReadiness(draft, scopeKey);
      if (!selectedMaterials(draft).length || readiness.canConfirm && !force) return;
      clearRequirementConfirmation(draft);
      if (!options.analyze) throw new Error(m().requirements.noModel);
      const understanding = await options.analyze(structuredClone(draft), {
        key: scopeKey, description: `${set.repositoryIdentity ?? selected.cwd} / ${set.label} / head=${set.headSha} / base=${set.source?.baseTipSha ?? set.comparison?.baseSha ?? ''}`,
      }, cts.token, (usage) => {
        ownerDraft.usage.input += usage.input; ownerDraft.usage.output += usage.output; ownerDraft.usage.calls++;
      });
      if (disposed || run !== generation || version !== requestVersion || cts.token.isCancellationRequested || data !== owner || draft !== ownerDraft) return;
      acceptRequirementUnderstanding(draft, understanding);
      await save();
    } catch (error) {
      if (run === generation && version === requestVersion && !disposed) {
        errorMessage = String((error as Error).message);
        await save();
      }
    } finally {
      if (analysis === cts) analysis = undefined;
      cts.dispose();
      if (run === generation && version === requestVersion) publish();
    }
  };
  const load = async (selected: string) => {
    const run = ++generation;
    cancel(); data = undefined; selection = undefined; pinned = undefined; draft = createRequirementsDraft();
    storageBlocked = false; errorMessage = ''; reading = false;
    try {
      if (!roots.includes(selected)) throw new Error(t.staleSelection);
      selectedRoot = selected;
      post({ type: 'loading', selected, roots });
      const cwd = await realpath(await repositoryRoot(selected));
      const [refs, current, identity] = await Promise.all([listReviewRefs(cwd), currentBranch(cwd), repositoryRemoteIdentity(cwd)]);
      if (run !== generation || disposed) return;
      if (!refs.length) throw new Error(t.noBranches);
      data = { cwd, refs, current, repositoryIdentity: identity };
      try {
        const stored = await options.load?.(cwd, identity);
        if (run !== generation || disposed) return;
        if (stored) { draft = restoreRequirementsDraft(stored.draft); selection = stored.selection; }
      } catch (error) {
        storageBlocked = true;
        errorMessage = `${m().requirements.loadFailed} ${String((error as Error).message)}`;
      }
      post({ type: 'repository', data, roots, selected, selection });
      publish();
    } catch (error) {
      if (run === generation) post({ type: 'error', message: String((error as Error).message) });
    }
  };
  panel.onDidDispose(() => { disposed = true; generation++; cancel(); markReady(false); if (!settled) finish(undefined); });
  panel.webview.onDidReceiveMessage(async (input: Record<string, unknown>) => {
    const run = generation;
    let inputVersion: number | undefined;
    try {
      if (input.type === 'ready') { await load(defaultCwd); return; }
      if (input.type === 'rendered') { if (data && input.cwd === data.cwd) markReady(true); return; }
      if (input.type === 'requirementsRendered') {
        if ([input.materials, input.items, input.unsafeNodes].every((value) => typeof value === 'number')) {
          options.onRendered?.({
            materials: Number(input.materials), items: Number(input.items), unsafeNodes: Number(input.unsafeNodes),
            ready: input.ready === true, error: typeof input.error === 'string' ? input.error : undefined,
          });
        }
        return;
      }
      if (input.type === 'clientError') { throw new Error(`Webview: ${String(input.message)}`); }
      if (input.type === 'repository' && typeof input.cwd === 'string') { await load(input.cwd); return; }
      if (input.type === 'browse') {
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: t.browseRepository });
        if (run !== generation || disposed) return;
        if (picked?.[0]) { const cwd = picked[0].fsPath; if (!roots.includes(cwd)) roots.push(cwd); await load(cwd); }
        return;
      }
      if (input.type === 'prs') {
        const owner = data;
        if (!owner || input.cwd !== owner.cwd) throw new Error(t.staleSelection);
        owner.prs = undefined;
        try {
          await ensureGhAvailable(owner.cwd); await ensureAuth(owner.cwd);
          const prs = await listPrs(owner.cwd);
          if (run !== generation || disposed || owner !== data) return;
          owner.prs = prs;
          post({ type: 'prs', prs, selectedPr: selection?.prNumber });
        } catch (error) {
          if (run === generation && owner === data) post({ type: 'error', message: String((error as Error).message) });
        }
        return;
      }
      if (input.type === 'markdown' && typeof input.text === 'string') {
        if (input.text.length > 512_000) throw new Error(m().requirements.sourceTooLarge);
        post({ type: 'markdown', sequence: input.sequence, html: renderRequirementMarkdown(input.text) }); return;
      }
      if (input.type === 'source' && typeof input.id === 'string') {
        const source = draft.materials.find((item) => item.id === input.id);
        if (!source) throw new Error(m().requirements.invalidState);
        const version = typeof input.version === 'number' ? source.versions.find((item) => item.version === input.version) : currentMaterial(source);
        if (!version) throw new Error(m().requirements.invalidState);
        post({ type: 'source', id: source.id, name: source.name, text: version.text,
          context: `${source.location} / v${version.version} / ${new Date(version.readAt).toISOString()}${source.format === 'html' ? ` / ${m().requirements.htmlNotice}` : ''}`,
          readOnly: source.kind !== 'paste' || version.version !== currentMaterial(source).version });
        return;
      }
      if (input.type === 'cancelAnalysis') { cancel(); errorMessage = m().requirements.canceled; publish(); return; }
      if (input.type === 'cancel') { panel.dispose(); return; }
      if (input.type === 'return' && (input.stage === 'review' || input.stage === 'conclusion')) {
        if (!options.onReturn) throw new Error(m().scope.staleSelection);
        cancel(); settled = true; options.onReturn(input.stage); finish(undefined); panel.dispose(); return;
      }
      if (input.type === 'model') { cancel(); await options.pickModel?.(); if (run === generation) publish(); return; }
      if (input.type === 'editRequirement' && typeof input.id === 'string') {
        const item = draft.understanding?.requirements.find((entry) => entry.id === input.id);
        if (!item) throw new Error(m().requirements.stale);
        post({ type: 'editRequirement', item: { id: item.id, name: item.title, text: item.text, included: item.included, reason: item.exclusionReason } }); return;
      }
      if (input.type === 'select') {
        if (reading) throw new Error(m().requirements.busy);
        const selected = input.kind === 'files' && typeof input.cwd === 'string' && (input.cwd === selectedRoot || input.cwd === data?.cwd)
          ? { cwd: await realpath(selectedRoot), kind: 'files' as const }
          : choose(input);
        if (selected.kind === 'files' && input.confirmed !== true && input.technicalOnly !== true) { settled = true; finish(selected); panel.dispose(); return; }
        cancel();
        const previousKey = pinned && data ? requirementScopeKey(data.cwd, pinned) : '';
        const version = requestVersion;
        inputVersion = version;
        reading = true; publish();
        try {
          const set = selected.kind === 'files' && options.fileScope?.cwd === selected.cwd
            ? options.fileScope.set : await (options.loadScope ?? loadPreparedScope)(selected);
          if (run !== generation || version !== requestVersion || disposed) return;
          const key = requirementScopeKey(selected.cwd, set);
          pinned = set;
          if (input.technicalOnly === true) {
            clearRequirementConfirmation(draft);
            draft.technicalOnly = true;
            draft.history.push({ at: Date.now(), action: m().requirements.technicalNotice });
          } else {
            await refreshFiles(() => run === generation && version === requestVersion && !disposed);
            if (run !== generation || version !== requestVersion || disposed) return;
            if (previousKey && previousKey !== key && selectedMaterials(draft).length) throw new Error(m().requirements.scopeChanged);
            confirmRequirements(draft, key, input.confirmed === true);
          }
          if (!storageBlocked) await save();
          settled = true; finish({ ...selected, reviewSet: set, requirements: structuredClone(draft) }); panel.dispose();
        } finally { if (run === generation && version === requestVersion) { reading = false; publish(); } }
        return;
      }
      if (storageBlocked || !data) throw new Error(m().requirements.loadFailed);
      if (input.type === 'selection') {
        choose(input); inputVersion = requestVersion;
        await save();
        if (run === generation && inputVersion === requestVersion && !disposed) await organize(input);
        return;
      }
      if (input.type === 'organize') { await organize(input, true); return; }
      if (reading) throw new Error(m().requirements.busy);
      if (input.type === 'material' && typeof input.text === 'string') {
        cancel();
        inputVersion = requestVersion;
        if (typeof input.id === 'string') {
          if (draft.materials.find((source) => source.id === input.id)?.kind !== 'paste') throw new Error(m().requirements.invalidState);
          updateRequirementMaterial(draft, input.id, input.text);
        }
        else addRequirementMaterial(draft, {
          kind: 'paste', name: typeof input.name === 'string' && input.name.trim() ? input.name : m().requirements.content,
          location: m().requirements.paste, format: 'markdown', text: input.text,
        });
      } else if (input.type === 'include' && typeof input.id === 'string' && typeof input.selected === 'boolean') {
        cancel(); inputVersion = requestVersion; selectRequirementMaterial(draft, input.id, input.selected);
      } else if (input.type === 'revise' && typeof input.id === 'string' && typeof input.text === 'string' && typeof input.name === 'string'
        && typeof input.included === 'boolean' && typeof input.reason === 'string') {
        if (input.revision !== draft.revision) throw new Error(m().requirements.stale);
        cancel(); inputVersion = requestVersion; reviseRequirement(draft, input.id, input.name, input.text, input.included, input.reason);
        await save(); if (run === generation && inputVersion === requestVersion && !disposed) { post({ type: 'editorSaved' }); publish(); } return;
      } else if (input.type === 'file' || input.type === 'link' || input.type === 'reloadSource') {
        cancel(); reading = true; readAbort = new AbortController(); publish();
        const owner = data;
        const revision = draft.revision;
        const version = requestVersion;
        inputVersion = version;
        try {
          let loaded;
          const existing = input.type === 'reloadSource' ? draft.materials.find((source) => source.id === input.id) : undefined;
          if (input.type === 'reloadSource' && (!existing || existing.kind === 'paste')) throw new Error(m().requirements.invalidState);
          if (existing?.kind === 'file') loaded = await readRequirementFile(existing.location);
          else if (input.type === 'file') {
            const picked = await vscode.window.showOpenDialog({
              canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
              filters: { Markdown: ['md', 'markdown', 'txt'] }, title: m().requirements.localFile,
            });
            if (!picked?.[0]) return;
            loaded = await readRequirementFile(picked[0].fsPath);
          } else {
            const address = existing?.location ?? input.address;
            if (typeof address !== 'string') throw new Error(m().requirements.unsafeUrl);
            loaded = await readRequirementLink(owner.cwd, address.trim(), AbortSignal.any([readAbort.signal, AbortSignal.timeout(20_000)]));
          }
          if (run !== generation || version !== requestVersion || owner !== data || revision !== draft.revision || disposed) {
            throw new Error(m().requirements.stale);
          }
          if (existing) updateRequirementMaterial(draft, existing.id, loaded.text);
          else addRequirementMaterial(draft, loaded);
        } finally { if (run === generation && version === requestVersion) { reading = false; readAbort = undefined; publish(); } }
      } else throw new Error(m().requirements.invalidState);
      await save();
      if (run !== generation || inputVersion !== undefined && inputVersion !== requestVersion || disposed) return;
      post({ type: 'editorSaved' }); publish();
      if (input.kind && input.cwd) {
        try { await organize(input); } catch (error) { errorMessage = String((error as Error).message); publish(); }
      }
    } catch (error) {
      if (run === generation && (inputVersion === undefined || inputVersion === requestVersion) && !disposed) {
        errorMessage = String((error as Error).message);
        publish();
        post({ type: input.type === 'link' || input.type === 'material' || input.type === 'revise' ? 'editorError' : 'error', message: errorMessage });
      }
    }
  });
  panel.webview.html = scopePreparationView(defaultCwd, initialKind, !!options.onReturn, options.fileScope?.cwd);
  return { result, ready, dispose: () => panel.dispose() };
}
