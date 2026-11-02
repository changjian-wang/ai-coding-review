import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewExtensionApi } from '../extension';
import { businessRecord, type BusinessReviewRun } from '../review/businessReview';
import type { RequirementsDraft } from '../review/requirements';
import { m } from '../i18n';

interface CenterProbe {
  id: number;
  body: string;
  stage: string;
  notePresent: boolean;
  noteEnabled: boolean;
  noteTitle: string;
  conflictText: string;
  publishEnabled: boolean;
  inspectorText: string;
}
interface PreparationProbe {
  id: number;
  ready: boolean;
  busy: boolean;
  committing: boolean;
  scopeReady: boolean;
  cwd: string;
  head: string;
  technical: boolean;
}

async function waitFor(test: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const end = Date.now() + 20_000;
  while (!await test()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export async function runFlowConsistencyHostChecks(
  cwd: string, business: { run: BusinessReviewRun; draft: RequirementsDraft },
): Promise<string[]> {
  const extension = vscode.extensions.getExtension<ReviewExtensionApi>('changjian-wang.ai-coding-review');
  assert.ok(extension);
  const api = (await extension.activate()).test;
  assert.ok(api);
  const config = vscode.workspace.getConfiguration('codereview');
  const previousLanguage = config.inspect<string>('language')?.workspaceValue;
  const preparationPrefix = 'codereview.requirementPreparation.v1:';
  const previousPreparations = new Map(api.workspaceState.keys().filter(key => key.startsWith(preparationPrefix))
    .map(key => [key, api.workspaceState.get<unknown>(key)]));
  const replies = new Map<number, CenterProbe>();
  const preparations = new Map<number, PreparationProbe>();
  const checks: string[] = [];
  const exec = promisify(execFile);
  const git = async (...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();
  let panel: vscode.WebviewPanel | undefined;
  let subscription: vscode.Disposable | undefined;
  let update: vscode.Memento['update'] | undefined;
  let releaseAssessment: (() => void) | undefined;
  let other: string | undefined;
  let request = 0;
  try {
    await config.update('language', 'en', vscode.ConfigurationTarget.Workspace);
    await api.loadBranch(cwd, 'feature', 'main');
    await api.session.setRequirements(business.draft);
    await api.session.setBusinessReview(business.run);
    api.session.snapshot!.conclusionDraft = undefined;
    api.session.setWorkspaceView({ stage: 'review', selection: { kind: 'finding', id: business.run.findings[0].id }, inspector: 'judgment' });
    panel = vscode.window.createWebviewPanel('codereview.workbench', 'Flow consistency fixture',
      vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    subscription = panel.webview.onDidReceiveMessage((message: { flowReply?: CenterProbe; flowPreparation?: PreparationProbe }) => {
      if (message.flowReply) replies.set(message.flowReply.id, message.flowReply);
      if (message.flowPreparation) preparations.set(message.flowPreparation.id, message.flowPreparation);
    });
    await api.restorePanel(panel, {});
    const installCenter = () => {
      const anchor = "paint();send('ready');";
      if (panel!.webview.html.includes('FLOW_CONSISTENCY_PROBE')) return;
      assert.ok(panel!.webview.html.includes(anchor));
      panel!.webview.html = panel!.webview.html.replace(anchor, `
        const FLOW_CONSISTENCY_PROBE=true;
        window.addEventListener('message',event=>{
          const message=event.data;if(message.type!=='flowProbe')return;
          if(message.action==='edit'){
            if($('draft-body').hidden)$('show-draft-edit').click();
            $('draft-body').value=message.body;$('draft-body').dispatchEvent(new Event('input',{bubbles:true}));
          }else if(message.action==='append'||message.action==='doubleAppend'){
            const button=document.querySelector('[data-center-action="appendFinding"]');button.click();if(message.action==='doubleAppend')button.click();
          }else if(message.action==='seedBuffer'){
            const draft=data.conclusion.draft;
            buffers[draft.id]={scope:data.view.scopeKey,binding:draft.bindingKey,revision:draft.revision+message.offset,body:message.body,verdict:draft.verdict};store();
          }
          requestAnimationFrame(()=>api.postMessage({type:'flowProbeReply',flowReply:{
            id:message.id,body:$('draft-body').value,stage:data.view.stage,
            notePresent:!!document.querySelector('[data-center-action="note"]'),
            noteEnabled:!!document.querySelector('[data-center-action="note"]')&&!document.querySelector('[data-center-action="note"]').disabled,
            noteTitle:document.querySelector('[data-center-action="note"]')?.title||'',
            conflictText:$('draft-buffer-conflict-body').textContent,
            publishEnabled:!$('publish-draft').disabled,inspectorText:$('inspector-body').innerText
          }}));
        });${anchor}`);
    };
    const probe = async (action = '', fields: Record<string, unknown> = {}) => {
      const id = ++request;
      await panel!.webview.postMessage({ type: 'flowProbe', id, action, ...fields });
      await waitFor(() => replies.has(id), 'flow center probe');
      return replies.get(id)!;
    };
    const language = async (value: 'en' | 'zh-CN') => {
      await api.setLanguage(value);
      await waitFor(() => panel!.webview.html.includes(`lang="${value}"`) && !panel!.webview.html.includes('FLOW_CONSISTENCY_PROBE'), 'language replaces the actual center');
      installCenter();
      return probe();
    };
    const installPreparation = () => {
      const anchor = "rememberPreparation();api.postMessage({type:'ready'});";
      assert.ok(panel!.webview.html.includes(anchor));
      panel!.webview.html = panel!.webview.html.replace(anchor, `
        window.addEventListener('message',event=>{
          const message=event.data;if(message.type!=='flowPreparationProbe')return;
          if(message.action==='alternate'){
            $('head').value='flow-alternate';$('base').value='main';$('scope-mode').value='branchChanges';
            $('target-branch').checked=true;$('target-branch').dispatchEvent(new Event('change'));
          }else if(message.action==='technical'){if(!$('technical').checked)$('technical').click();}
          else if(message.action==='confirm')$('confirm').click();
          else if(message.action==='cancel')window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
          requestAnimationFrame(()=>api.postMessage({type:'requirementsRendered',flowPreparation:{
            id:message.id,ready:state.ready,busy:state.busy,committing:state.committing,scopeReady:state.scopeReady,
            cwd:data?.cwd||'',head:$('head').value,technical:state.technicalOnly
          }}));
        });${anchor}`);
    };
    const prep = async (action = '') => {
      const id = ++request;
      await panel!.webview.postMessage({ type: 'flowPreparationProbe', id, action });
      await waitFor(() => preparations.has(id), 'flow preparation probe');
      return preparations.get(id)!;
    };
    installCenter();
    await probe();

    await api.action({ action: 'stage', value: 'conclusion' });
    await waitFor(async () => (await probe()).stage === 'conclusion', 'manual conclusion');
    const manual = '# Saved manual text\n\nKeep user-authored material.';
    await probe('edit', { body: manual });
    await waitFor(() => api.session.conclusionDraft?.body === manual, 'manual draft save');
    await api.action({ action: 'select', kind: 'finding', id: business.run.findings[0].id });
    await waitFor(async () => (await probe()).notePresent, 'finding append control');
    await probe('doubleAppend');
    await waitFor(() => !!api.session.conclusionDraft?.body.includes(business.run.findings[0].title), 'one inclusion saved');
    const appended = api.session.conclusionDraft!.body;
    assert.equal(appended.split(business.run.findings[0].title).length - 1, 1, 'A rapid double click must not duplicate a finding');
    assert.ok(appended.includes(manual));
    await waitFor(async () => (await probe()).body === appended, 'canonical appended text visible');
    assert.equal((await language('zh-CN')).body, appended, 'Language switching must not restore an acknowledged old buffer');
    await probe('edit', { body: appended + '\n\nContinued after language switch.' });
    await waitFor(() => api.session.conclusionDraft?.body === appended + '\n\nContinued after language switch.', 'later edit preserves appended finding');
    checks.push('native saved manual text + finding inclusion + language switch + later save retain all content; double inclusion is idempotent');

    await language('en');
    const saved = api.session.conclusionDraft!.body;
    await probe('seedBuffer', { offset: 0, body: '# Genuine unsaved text' });
    assert.equal((await language('zh-CN')).body, '# Genuine unsaved text', 'A current-revision unsaved buffer must survive reload');
    assert.equal(api.session.conclusionDraft!.body, saved, 'Restoring unsaved content must not silently save it');
    await api.session.generateConclusionDraft('# New canonical saved version');
    await waitFor(async () => (await probe()).body === '# New canonical saved version', 'fresh canonical draft');
    await probe('seedBuffer', { offset: -1, body: '# Older conflicting local text' });
    const conflict = await language('en');
    assert.equal(conflict.body, '# New canonical saved version');
    assert.ok(conflict.conflictText.includes('# Older conflicting local text'));
    checks.push('native current-revision unsaved text restores; stale buffers remain readable without overwriting newer saved text');

    const draft = api.session.conclusionDraft!;
    await api.action({ action: 'savePreview', draft: { id: draft.id, revision: draft.revision, body: draft.body, verdict: 'request-changes' } });
    await waitFor(() => api.session.conclusionPreviewCurrent, 'feedback preview shown');
    const feedback = await probe();
    assert.equal(feedback.publishEnabled, true);
    assert.ok(feedback.inspectorText.includes(m().reviewCenter.feedbackReady));
    assert.ok(!feedback.inspectorText.includes(m().businessReview.incomplete));
    assert.equal(api.session.canSubmitConclusion('approve'), false);
    const changeDraft = api.session.conclusionDraft!;
    await api.action({ action: 'savePreview', draft: { id: changeDraft.id, revision: changeDraft.revision, body: changeDraft.body, verdict: 'comment' } });
    await waitFor(() => api.session.conclusionPreviewCurrent, 'comment preview shown');
    const comment = await probe();
    assert.equal(comment.publishEnabled, true);
    assert.ok(comment.inspectorText.includes(m().reviewCenter.feedbackReady));
    assert.ok(!comment.inspectorText.includes(m().businessReview.incomplete));
    checks.push('native requested-changes/comment permissions explain allowed feedback rather than incorrectly claiming the completed workflow is incomplete');

    const tree = await git('rev-parse', 'feature^{tree}');
    const alternate = await git('-c', 'user.name=Flow fixture', '-c', 'user.email=test@example.invalid',
      'commit-tree', tree, '-p', 'feature', '-m', 'flow alternate');
    await git('branch', 'flow-alternate', alternate);
    await api.session.generateConclusionDraft('# Original scope and manual conclusion');
    const originalScope = api.session.reviewSet;
    const originalSnapshot = api.session.snapshot;
    const originalRun = api.session.businessReview!.id;
    const originalDraft = api.session.conclusionDraft!;
    const pending = api.action({ action: 'stage', value: 'prepare' });
    await waitFor(() => api.openingPanel() === panel, 'scope-switch preparation');
    installPreparation();
    await waitFor(async () => { const p = await prep(); return p.head === 'feature' && p.scopeReady && !p.busy && !p.committing; }, 'original scope loaded');
    await prep('alternate');
    await waitFor(async () => { const p = await prep(); return p.head === 'flow-alternate' && p.scopeReady && !p.busy && !p.committing; }, 'alternate scope ready');
    await prep('technical');
    await waitFor(async () => { const p = await prep(); return p.ready && p.technical && !p.busy && !p.committing; }, 'explicit technical scope choice');
    update = api.workspaceState.update;
    api.workspaceState.update = async (key, value: unknown) => {
      const source = value && typeof value === 'object' && 'source' in value ? value.source : undefined;
      if (source && typeof source === 'object' && 'headRef' in source && source.headRef === 'flow-alternate') {
        throw new Error('Controlled candidate-scope storage failure');
      }
      await update!.call(api.workspaceState, key, value);
    };
    await prep('confirm');
    await waitFor(() => panel!.webview.html.includes('id="handoff-error"'), 'atomic transfer failed visibly');
    assert.equal(api.session.reviewSet, originalScope);
    assert.equal(api.session.snapshot, originalSnapshot);
    assert.equal(api.session.businessReview!.id, originalRun);
    installPreparation();
    await waitFor(async () => { const p = await prep(); return p.scopeReady && !p.committing && !p.busy; }, 'failed preparation idle');
    await prep('cancel');
    await pending;
    api.workspaceState.update = update; update = undefined;
    assert.equal(api.session.reviewSet, originalScope);
    assert.equal(api.session.conclusionDraft?.id, originalDraft.id);
    assert.equal(api.session.conclusionDraft?.body, originalDraft.body);
    installCenter();
    assert.equal((await probe()).body, originalDraft.body, 'Cancellation must render the original manual draft, not only retain it on the host');
    checks.push('native failed candidate persistence + cancel restores the exact original scope, report and manual draft without committing the failed scope');

    other = await mkdtemp(path.join(tmpdir(), 'acr-flow-repository-'));
    await mkdir(path.join(other, 'src'));
    await exec('git', ['init', '--initial-branch=main'], { cwd: other });
    await writeFile(path.join(other, 'src', 'other.ts'), 'export const other = true;\n');
    await exec('git', ['add', '.'], { cwd: other });
    await exec('git', ['-c', 'user.name=Flow fixture', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'other'], { cwd: other });
    other = await realpath(other);
    const openingOther = vscode.commands.executeCommand('codereview.openInNewWindow', other);
    await waitFor(() => api.openingPanel() === panel, 'explicit other repository prepares in the live center');
    installPreparation();
    await waitFor(async () => (await prep()).cwd === other, 'explicit target repository is shown');
    assert.equal(api.session.reviewSet, originalScope, 'Browsing another repository alone must not replace the current review');
    await waitFor(async () => !(await prep()).committing, 'other repository preparation idle');
    await prep('cancel');
    await openingOther;
    assert.equal(api.session.reviewSet, originalScope);
    installCenter();
    assert.equal((await probe()).body, originalDraft.body);
    checks.push('native explicit repository entry honors its target while an existing center is open; cancellation preserves the original review');

    api.session.snapshot!.businessReview = undefined;
    api.session.snapshot!.conclusionDraft = undefined;
    let assessing = false;
    const gate = new Promise<void>(resolve => { releaseAssessment = resolve; });
    const model: vscode.LanguageModelChat = {
      id: 'flow-held-model', name: 'Controlled flow model', vendor: 'test', family: 'test', version: '1', maxInputTokens: 32_000,
      countTokens: async value => typeof value === 'string' ? Math.ceil(value.length / 4) : 1,
      sendRequest: async messages => {
        const text = (message: vscode.LanguageModelChatMessage) => message.content
          .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart).map(part => part.value).join('');
        const instructions = messages.slice(0, -1).map(text).join('\n'), input = businessRecord(JSON.parse(text(messages.at(-1)!)));
        const evidence = Array.isArray(input.evidence) ? input.evidence.map(businessRecord) : [];
        const cite = (quote: string) => {
          const ref = evidence.find(item => typeof item.text === 'string' && item.text.includes(quote)); assert.ok(ref);
          return { evidenceId: ref.id, quote };
        };
        const refs = () => [cite('await inventory.release(order.id);'), cite('await order.restore();')];
        let output: unknown;
        if (instructions.includes('Organize the supplied scope')) output = { units: [{ id: 'U-flow', goal: 'Controlled lifecycle', files: originalScope!.files.map(file => file.path), requirementIds: ['RQ-1'] }] };
        else if (instructions.includes('Inspect this business unit')) output = { summary: 'Controlled unit.', candidates: [], requests: [] };
        else if (instructions.includes('Independently discover cross-unit')) output = { summary: 'Controlled gap.', requests: [], candidates: [{
          kind: 'implementation', title: 'Held flow issue', cause: 'Controlled cause', trigger: 'Cancel and restore', impact: 'Controlled stock conflict', requirementIds: ['RQ-1'], evidence: refs(),
        }] };
        else if (instructions.includes('Independently adjudicate')) output = { decisions: [{
          candidateIds: (input.candidates as { id: string }[]).map(item => item.id), kind: 'implementation', status: 'confirmed', severity: 'high', attribution: 'unknown',
          title: 'Held flow issue', cause: 'Controlled cause', trigger: 'Cancel and restore', impact: 'Controlled stock conflict',
          requirementIds: ['RQ-1'], evidence: refs(), counterEvidence: [], counterRationale: 'Controlled absence of a guard.', critical: null,
        }] };
        else {
          assessing = true; await gate;
          output = { requirements: [{ id: 'RQ-1', status: 'violated', rationale: 'Controlled gap.', evidence: refs(), critical: null }],
            premises: [{ id: 'Q-1', status: 'unknown', rationale: 'Controlled unknown identity.', evidence: [], critical: null }], priorCritical: [] };
        }
        return { text: (async function* () { yield JSON.stringify(output); })(), stream: (async function* () {})() };
      },
    };
    api.useReviewModel(model);
    const running = vscode.commands.executeCommand('codereview.businessReview');
    await waitFor(() => assessing && !!api.session.businessReview?.findings.length, 'real assessment held');
    const finding = api.session.businessReview!.findings[0];
    await api.action({ action: 'select', kind: 'finding', id: finding.id });
    await waitFor(async () => { const p = await probe(); return p.notePresent && !p.noteEnabled; }, 'note action disabled while running');
    assert.equal((await probe()).noteTitle, m().businessReview.running);
    assert.throws(() => api.session.recordBusinessNote(finding.id, 'Do not lose this input'), new RegExp(m().businessReview.running.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await vscode.commands.executeCommand('codereview.cancelBusinessReview');
    await waitFor(() => api.session.businessReview?.status === 'cancelled', 'cancellation stored');
    assert.ok(releaseAssessment);
    releaseAssessment(); releaseAssessment = undefined;
    await running;
    assert.equal(api.session.businessReview?.status, 'cancelled');
    assert.equal(api.session.canSubmitConclusion('approve'), false);
    checks.push('native in-flight note action is disabled with an accurate backend reason; a late assessment cannot reverse cancellation');

    await api.loadBranch(other, 'main');
    await api.action({ action: 'stage', value: 'conclusion' });
    assert.equal(!!api.session.businessReview, false);
    assert.equal(api.session.globalConfirmed, false);
    assert.ok(api.session.conclusionDraft?.body.includes(m().reviewCenter.unreviewedBody));
    assert.ok(!api.session.conclusionDraft?.body.includes('global conclusion verified'));
    assert.equal(api.session.canSubmitConclusion('approve'), false);
    checks.push('native no-report conclusion explicitly states that no reviewed conclusion exists and cannot approve');
    return checks;
  } finally {
    releaseAssessment?.(); api.useReviewModel();
    if (update) api.workspaceState.update = update;
    subscription?.dispose(); panel?.dispose();
    await config.update('language', previousLanguage, vscode.ConfigurationTarget.Workspace);
    await api.loadBranch(cwd, 'feature', 'main');
    await Promise.all([...new Set([...previousPreparations.keys(),
      ...api.workspaceState.keys().filter(key => key.startsWith(preparationPrefix))])]
      .map(key => api.workspaceState.update(key, previousPreparations.get(key))));
    if (other) await rm(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
