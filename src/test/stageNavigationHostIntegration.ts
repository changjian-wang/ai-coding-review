import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ReviewExtensionApi } from '../extension';
import type { BusinessReviewRun } from '../review/businessReview';
import { addRequirementMaterial, selectRequirementMaterial, type RequirementsDraft } from '../review/requirements';
import { DocumentPanel } from '../ui/documentPanel';
import { WorkspaceStateReviewStore } from '../review/reviewStore';
import { repositoryStorageId } from '../review/repositoryIdentity';

interface NavigationReport { cards: number; reviewEnabled: boolean; conclusionEnabled: boolean; materials: number; hasReview: boolean }

async function waitFor(test: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!test()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function inspect(panel: vscode.WebviewPanel): Promise<NavigationReport> {
  let report: NavigationReport | undefined;
  const observations: unknown[] = [];
  const subscription = panel.webview.onDidReceiveMessage((message: {
    navigationCheck?: NavigationReport; navigationState?: unknown; type?: string; ready?: boolean; error?: string; materials?: number; message?: string;
  }) => {
    if (message.navigationCheck) report = message.navigationCheck;
    if (message.navigationState) observations.push(message.navigationState);
    if (message.type === 'requirementsRendered' || message.type === 'clientError') observations.push(message);
  });
  const anchor = "rememberPreparation();api.postMessage({type:'ready'});";
  assert.ok(panel.webview.html.includes(anchor), 'Returning to prepare must render the complete production form in the workbench');
  panel.webview.html = panel.webview.html.replace(anchor, `
    window.addEventListener('message',event=>{
      const message=event.data;
      if(message.type==='requirements')api.postMessage({type:'requirementsRendered',navigationState:{
        ready:message.state.ready,scopeReady:message.state.scopeReady,scopeLoading:message.state.scopeLoading,
        scopeError:message.state.scopeError,error:message.state.error,busy:message.state.busy,kind:$('kind').value,
        head:$('head').value,base:$('base').value}});
      if(message.type==='requirements'&&message.state.scopeReady&&!message.state.busy){
        api.postMessage({type:'requirementsRendered',materials:message.state.materials.length,items:0,unsafeNodes:0,ready:message.state.ready,
          navigationCheck:{cards:document.querySelectorAll('main>section').length,
            reviewEnabled:!$('return-review').disabled,conclusionEnabled:!$('return-conclusion').disabled,
            materials:message.state.materials.length,hasReview:api.getState().preparationHasReview===true}});
      }else if(message.type==='navigationReturn')$('return-'+message.stage).click();
      else if(message.type==='navigationEscape')window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
      else if(message.type==='navigationExclude'){
        const material=document.querySelector('[data-material]');
        material.checked=false;material.dispatchEvent(new Event('change',{bubbles:true}));
      }
    });
    ${anchor}`);
  try { await waitFor(() => !!report, 'same-panel preparation render'); return report!; }
  catch (error) { throw new Error(`${String(error)}: ${JSON.stringify(observations.slice(-5))}`); }
  finally { subscription.dispose(); }
}

function tabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('codereview.'));
}

export async function runStageNavigationHostChecks(
  cwd: string, business: { run: BusinessReviewRun; draft: RequirementsDraft },
): Promise<string[]> {
  DocumentPanel.closeIfOpen();
  const extension = vscode.extensions.getExtension<ReviewExtensionApi>('changjian-wang.ai-coding-review');
  assert.ok(extension);
  const api = (await extension.activate()).test;
  assert.ok(api);
  await api.loadBranch(cwd, 'feature', 'main');
  await api.session.setRequirements(business.draft);
  await api.session.setBusinessReview(business.run);
  await api.open();
  await waitFor(() => api.document().loaded && api.document().embedded, 'initial navigation source');
  const original = api.session.snapshot;
  const originalSet = api.session.reviewSet;
  const originalRequirements = structuredClone(api.session.requirements);
  const originalRun = api.session.businessReview!.id;
  const findingId = api.session.businessReview!.findings[0].id;
  await api.action({ action: 'select', kind: 'finding', id: findingId });
  const groups = vscode.window.tabGroups.all.length;
  const tab = tabs()[0];
  let owner: vscode.WebviewPanel | undefined;

  const enter = async (materials = business.draft.materials.length) => {
    const pending = api.action({ action: 'stage', value: 'prepare' });
    await waitFor(() => !!api.openingPanel(), 'same-panel preparation handoff');
    const panel = api.openingPanel()!;
    if (owner) assert.equal(panel, owner, 'Repeated stage navigation must reuse the exact same webview panel');
    owner = panel;
    const report = await inspect(panel);
    assert.equal(report.cards, 3);
    assert.equal(report.reviewEnabled, true);
    assert.equal(report.conclusionEnabled, true);
    assert.equal(report.materials, materials);
    assert.equal(report.hasReview, true);
    assert.equal(tabs().length, 1, `No second preparation, document or placeholder tab may appear: ${JSON.stringify(tabs().map((tab) => ({ label: tab.label, input: tab.input })))}`);
    assert.equal(tabs()[0], tab);
    assert.equal(vscode.window.tabGroups.all.length, groups);
    return { panel, pending };
  };
  const leave = async (entry: Awaited<ReturnType<typeof enter>>, stage: 'review' | 'conclusion' | 'escape') => {
    await entry.panel.webview.postMessage(stage === 'escape' ? { type: 'navigationEscape' } : { type: 'navigationReturn', stage });
    await entry.pending;
    await waitFor(() => !api.openingPanel() && entry.panel.webview.html.includes('id="review-source"'), 'same-panel review restoration');
    assert.equal(tabs().length, 1);
    assert.equal(vscode.window.tabGroups.all.length, groups);
    assert.equal(api.session.snapshot, original);
    assert.equal(api.session.reviewSet, originalSet);
    assert.equal(api.session.businessReview!.id, originalRun);
  };

  const first = await enter();
  await api.session.setBusinessReview({ ...api.session.businessReview!, status: 'running', phase: 'discover' });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(first.panel.webview.html.includes('id="repository"'), 'Background review updates must not overwrite preparation');
  assert.ok(!first.panel.webview.html.includes('id="prepare-main"'), 'There must not be a preparation placeholder in this form');
  await leave(first, 'review');
  assert.equal(api.session.businessReview?.status, 'running', 'Navigation must not cancel or restart an unchanged running review');
  assert.deepEqual(api.session.requirements, originalRequirements);
  assert.deepEqual(api.session.workspaceView.selection, { kind: 'finding', id: findingId });
  await waitFor(() => api.document().loaded && api.document().embedded, 'source after review round trip');

  await api.session.setBusinessReview(business.run);
  await api.action({ action: 'stage', value: 'conclusion' });
  const saved = api.session.conclusionDraft!;
  await api.session.saveConclusionDraft(saved.id, saved.revision, '# Kept exact draft\n\nNo tests were executed.', 'comment');
  const draftId = api.session.conclusionDraft!.id;
  await leave(await enter(), 'conclusion');
  assert.equal(api.session.workspaceView.stage, 'conclusion');
  assert.equal(api.session.conclusionDraft?.id, draftId);
  assert.equal(api.session.conclusionDraft?.body, '# Kept exact draft\n\nNo tests were executed.');
  await leave(await enter(), 'escape');
  assert.equal(api.session.workspaceView.stage, 'conclusion', 'Escape returns to the stage from which preparation was opened');

  const edited = await enter();
  await edited.panel.webview.postMessage({ type: 'navigationExclude' });
  await waitFor(() => api.session.requirements?.materials[0].selected === false, 'saved preparation edit');
  await leave(edited, 'review');
  assert.equal(api.session.businessReview?.status, 'stale', 'Real material edits must still invalidate the old analysis');
  assert.equal(api.session.requirements?.materials[0].versions[0].text, business.draft.materials[0].versions[0].text);

  const pendingDraft = structuredClone(api.session.requirements!);
  const pendingMaterial = addRequirementMaterial(pendingDraft, {
    kind: 'paste', name: 'Saved while no scope was ready', location: 'Native fixture', format: 'markdown', text: 'Pending material must survive navigation.',
  });
  selectRequirementMaterial(pendingDraft, pendingMaterial, false);
  const store = new WorkspaceStateReviewStore(api.workspaceState);
  await store.saveRequirementPreparation(repositoryStorageId(cwd, originalSet?.repositoryIdentity),
    { draft: pendingDraft, selection: { cwd, kind: 'branchChanges', headRef: 'feature', baseRef: 'main' } });
  await leave(await enter(2), 'review');
  assert.equal(api.session.requirements?.materials.find((material) => material.id === pendingMaterial)?.versions[0].text,
    'Pending material must survive navigation.');
  const disposable = await enter(2);
  disposable.panel.dispose();
  await disposable.pending;
  await waitFor(() => !api.openingPanel() && tabs().length === 0, 'closing the preparation-owned workbench');
  await store.saveRequirementPreparation(
    repositoryStorageId(cwd, originalSet?.repositoryIdentity),
    { draft: business.draft, selection: { cwd, kind: 'branchChanges', headRef: 'feature', baseRef: 'main' } },
  );
  await api.session.setRequirements(business.draft);
  await api.session.setBusinessReview(business.run);
  return [
    'native review → full preparation → review keeps one panel, the selected finding and requirements, including background running-review updates',
    'native conclusion → preparation → conclusion/Escape retains the exact draft without extra tabs or editor groups',
    'native preparation edits invalidate old findings while closing preparation releases the owning workbench cleanly',
    'a newer saved preparation draft is retained instead of being overwritten by the older active-session material',
  ];
}

export async function savePreparationForRestart(api: NonNullable<ReviewExtensionApi['test']>): Promise<string> {
  void api.action({ action: 'stage', value: 'prepare' });
  await waitFor(() => !!api.openingPanel(), 'preparation before native restart');
  const report = await inspect(api.openingPanel()!);
  assert.equal(report.hasReview, true);
  await api.session.persist();
  await api.workspaceState.update('codereview.host.preparationRestart', true);
  return 'native restart fixture saves the active full preparation page with its existing-review marker';
}

export async function restorePreparationAfterRestart(api: NonNullable<ReviewExtensionApi['test']>): Promise<string> {
  assert.equal(api.workspaceState.get('codereview.host.preparationRestart'), true);
  await waitFor(() => !!api.openingPanel(), 'serialized preparation after a real restart');
  const panel = api.openingPanel()!;
  panel.reveal(undefined, false);
  const report = await inspect(panel);
  assert.equal(report.hasReview, true);
  assert.equal(report.reviewEnabled, true, 'A restarted preparation page must recover the previous review before offering return');
  const snapshot = api.session.snapshot;
  const before = tabs().length;
  await panel.webview.postMessage({ type: 'navigationReturn', stage: 'review' });
  await waitFor(() => !api.openingPanel() && panel.webview.html.includes('id="review-source"'), 'restored preparation → existing review');
  assert.equal(tabs().length, before);
  assert.equal(api.session.snapshot, snapshot);
  assert.equal(api.session.workspaceView.stage, 'review');
  return 'real VS Code restart restores preparation with enabled return navigation and reuses the same panel for the recovered review';
}
