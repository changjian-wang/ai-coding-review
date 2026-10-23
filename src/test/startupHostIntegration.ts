import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ReviewExtensionApi } from '../extension';
import { m } from '../i18n';

interface PreparationReport {
  cards: number;
  language: string;
  prototypeChrome: boolean;
  targetChoices: number;
  loading: boolean;
  refresh: string;
  browse: string;
  saved: { preparationCwd: string };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 30_000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function openingPanel(api: NonNullable<ReviewExtensionApi['test']>): Promise<vscode.WebviewPanel> {
  await waitFor(() => !!api.openingPanel(), 'production preparation panel');
  return api.openingPanel()!;
}

async function inspectPreparation(panel: vscode.WebviewPanel): Promise<PreparationReport> {
  let finish!: (report: PreparationReport) => void;
  const reported = new Promise<PreparationReport>((resolve) => { finish = resolve; });
  const subscription = panel.webview.onDidReceiveMessage((message: { startupCheck?: PreparationReport }) => {
    if (message.startupCheck) finish(message.startupCheck);
  });
  const anchor = "rememberPreparation();api.postMessage({type:'ready'});";
  assert.ok(panel.webview.html.includes(anchor), 'The startup panel must render production preparation, not a loading shell');
  const automation = `
    window.addEventListener('message', event => {
      if (event.data.type === 'repository') {
        api.postMessage({type:'rendered',cwd:event.data.data.cwd,startupCheck:{
          cards:document.querySelectorAll('main>section').length,
          language:document.documentElement.lang,
          prototypeChrome:!!document.querySelector('.command .product-mark svg')&&document.querySelectorAll('.stages .stage-index').length===3,
          targetChoices:document.querySelectorAll('.scope-kind input[type=radio]').length,
          loading:!!document.getElementById('loadingElapsed'),
          refresh:document.getElementById('retry').textContent,
          browse:document.getElementById('browse').textContent,saved:api.getState()
        }});
      } else if (event.data.type === 'startupCancel') {
        window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
      } else if (event.data.type === 'startupConfirm') {
        const timer=setInterval(()=>{
          const confirm=document.getElementById('confirm');
          if (!confirm.disabled) { clearInterval(timer);confirm.click(); }
        },40);
      }
    });
  `;
  panel.webview.html = panel.webview.html.replace(anchor, `${automation}${anchor}`);
  try { return await within(reported, 'real preparation DOM and repository actions'); }
  finally { subscription.dispose(); }
}

function reviewTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('codereview.workbench'));
}

export async function runStartupHostChecks(cwd: string): Promise<string[]> {
  const extension = vscode.extensions.getExtension<ReviewExtensionApi>('changjian-wang.ai-coding-review');
  assert.ok(extension);
  const api = (await extension.activate()).test;
  assert.ok(api);
  await vscode.window.tabGroups.close(reviewTabs(), true);
  const selected = await api.loadBranch(cwd, 'feature', 'main');
  const groups = vscode.window.tabGroups.all.length;
  const opening = vscode.commands.executeCommand('codereview.openInNewWindow', cwd);
  const first = await openingPanel(api);
  const report = await inspectPreparation(first);
  assert.equal(report.cards, 3);
  assert.equal(report.language, 'zh-CN', 'A new profile must default to Simplified Chinese even with an English editor');
  assert.equal(report.prototypeChrome, true);
  assert.equal(report.targetChoices, 2);
  assert.equal(report.loading, false);
  assert.equal(report.refresh, m().scope.refreshRepository);
  assert.equal(report.browse, m().scope.browseRepository);
  assert.equal(report.saved.preparationCwd, cwd);
  assert.equal(api.session.reviewSet, selected, 'Preparation must not activate another scope before confirmation');
  assert.equal(reviewTabs().length, 1, 'Preparation must not leave a second workbench/loading tab');
  await vscode.commands.executeCommand('codereview.openInNewWindow', cwd);
  assert.equal(api.openingPanel(), first, 'Repeated opening must reveal the existing preparation panel');
  first.dispose();
  await within(Promise.resolve(opening), 'cancelled new-window entry');
  await waitFor(() => reviewTabs().length === 0, 'closed preparation tab acknowledgement');
  assert.equal(reviewTabs().length, 0);
  assert.equal(api.session.reviewSet, selected);
  await waitFor(() => vscode.window.tabGroups.all.length === groups, 'auxiliary group closing after cancellation');
  assert.equal(vscode.window.tabGroups.all.length, groups, 'Cancellation must not leave an empty auxiliary editor group');

  const configuration = vscode.workspace.getConfiguration('codereview');
  try {
    await configuration.update('language', 'en', vscode.ConfigurationTarget.Workspace);
    await api.setLanguage('zh-CN');
    assert.equal(vscode.workspace.getConfiguration('codereview').get('language'), 'zh-CN');
    assert.equal(vscode.workspace.getConfiguration('codereview').inspect('language')?.workspaceValue, 'zh-CN',
      'An explicit workspace preference must be changed at workspace scope, not masked by a global write');
  } finally {
    await configuration.update('language', undefined, vscode.ConfigurationTarget.Workspace);
  }

  const restored = vscode.window.createWebviewPanel('codereview.workbench', m().scope.prepareTitle,
    vscode.ViewColumn.One, { retainContextWhenHidden: true });
  const restoring = api.restorePanel(restored, report.saved);
  const recovered = await inspectPreparation(restored);
  assert.equal(recovered.cards, 3);
  assert.equal(recovered.loading, false);
  assert.equal(api.openingPanel(), restored);
  assert.equal(vscode.window.tabGroups.all.length, groups, 'Restoring preparation must not relocate an existing panel');
  await restored.webview.postMessage({ type: 'startupCancel' });
  await within(restoring, 'Escape cancellation of restored preparation');
  await waitFor(() => reviewTabs().length === 0, 'restored preparation tab closing');
  assert.equal(api.openingPanel(), undefined);
  assert.equal(reviewTabs().length, 0);

  const confirming = vscode.commands.executeCommand('codereview.openInNewWindow', cwd);
  const final = await openingPanel(api);
  await inspectPreparation(final);
  let disposed = false;
  const disposal = final.onDidDispose(() => { disposed = true; });
  try {
    await final.webview.postMessage({ type: 'startupConfirm' });
    await within(Promise.resolve(confirming), 'confirmed preparation handoff');
    assert.equal(disposed, false, 'Confirmation must adopt the same panel instead of replacing or moving it');
    assert.ok(final.webview.html.includes('id="review-source"'));
    assert.equal(reviewTabs().length, 1);
    assert.equal(api.session.reviewSet?.source?.headRef, 'feature');
    assert.equal(api.session.reviewSet?.source?.baseRef, 'main');
  } finally {
    disposal.dispose();
    final.dispose();
  }
  return [
    'Chinese-first production preparation uses the prototype header and segmented target; repeated opening and cancellation leave no loading tab or empty group',
    'language switching respects explicit workspace configuration instead of an ineffective global-only override',
    'saved preparation restores in place and Escape cancels it without activating a new review',
    'explicit confirmation adopts the same native panel as the review center without another tab or relocation',
  ];
}
