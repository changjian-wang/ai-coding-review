import * as assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewExtensionApi } from '../extension';
import type { RequirementsDraft } from '../review/requirements';
import type { BusinessReviewRun } from '../review/businessReview';
import { businessHash } from '../review/businessReview';
import { centerReferenceId, centerReferences } from '../ui/reviewCenterState';
import { DocumentPanel } from '../ui/documentPanel';
import { restorePreparationAfterRestart, savePreparationForRestart } from './stageNavigationHostIntegration';

type HostApi = NonNullable<ReviewExtensionApi['test']>;
async function waitFor(test: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!test()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function hostApi(): Promise<HostApi> {
  const extension = vscode.extensions.getExtension<ReviewExtensionApi>('changjian-wang.ai-coding-review');
  assert.ok(extension);
  const api = await extension.activate();
  assert.ok(api?.test, 'Native tests need the mode-restricted test API');
  return api.test;
}

export async function runReviewCenterHostChecks(cwd: string, business: { run: BusinessReviewRun; draft: RequirementsDraft }): Promise<string[]> {
  DocumentPanel.closeIfOpen();
  const api = await hostApi();
  const set = await api.loadBranch(cwd, 'feature', 'main');
  await api.session.setRequirements(business.draft);
  await api.session.setBusinessReview(business.run);
  await api.open();
  await waitFor(() => api.document().loaded && api.document().embedded, 'production center embedded source handshake');
  const groups = vscode.window.tabGroups.all.length;
  const id = api.session.businessReview!.findings[0].id;
  await api.action({ action: 'select', kind: 'finding', id });
  await waitFor(() => api.document().loaded && api.document().path === 'src/cancel.ts', 'business finding primary source');
  assert.equal(api.document().revision, business.run.findings[0].evidence.find((ref) => ref.path === 'src/cancel.ts')?.sourceHash);
  await api.action({ action: 'file', path: 'src/value.ts' });
  await waitFor(() => api.document().loaded && api.document().path === 'src/value.ts', 'associated formal source');
  assert.equal(api.document().revision, businessHash('export const value = "feature";\n'));
  assert.deepEqual(api.session.workspaceView.selection, { kind: 'finding', id });
  const material = [...centerReferences(api.session).values()].find((ref) => ref.kind === 'business' && ref.citation.kind === 'material');
  assert.ok(material);
  const reference = centerReferenceId(material);
  await api.action({ action: 'reference', id: reference });
  await waitFor(() => api.document().loaded && api.document().readOnly, 'original requirement snapshot inside center');
  assert.deepEqual(api.session.workspaceView.selection, { kind: 'finding', id });
  assert.equal(vscode.window.tabGroups.all.length, groups, 'Reading code and evidence must not create editor groups');
  await api.action({ action: 'inspector', value: 'evidence' });
  await api.action({ action: 'stage', value: 'conclusion' });
  const draft = api.session.conclusionDraft!;
  const body = '# Controlled exact conclusion\n\n- Reservation is missing.\n- No tests were executed.';
  await api.action({ action: 'savePreview', draft: { id: draft.id, revision: draft.revision, body, verdict: 'request-changes' } });
  await waitFor(() => api.session.conclusionPreviewCurrent, 'visible native conclusion preview acknowledgement');
  await api.recordLocal();
  assert.equal(api.session.conclusion?.bodyHash, businessHash(body));
  assert.equal(api.session.conclusion?.target, 'local');
  await api.action({ action: 'stage', value: 'review' });
  await api.action({ action: 'reference', id: reference });
  await waitFor(() => api.document().loaded && api.document().readOnly, 'persisted associated source');
  await api.session.persist();
  await api.workspaceState.update('codereview.host.persistMarker', { head: set.headSha, id });
  await writeFile(path.join(cwd, 'host-m4-state.json'), JSON.stringify({
    head: set.headSha, id, reference, body, draftId: api.session.conclusionDraft!.id,
    storageKey: api.workspaceState.keys().find((key) => key.startsWith('codereview:review:') && key.endsWith(`@${set.headSha}`)),
    view: api.session.workspaceView, runId: api.session.businessReview?.id, repo: api.session.snapshot?.repo,
  }));
  const preparationRestart = await savePreparationForRestart(api);
  return [
    'production M4 single-panel source/associated-original navigation retains the finding without creating editor groups',
    'production M4 exact visible preview acknowledgement and local conclusion (no GitHub publication)',
    preparationRestart,
  ];
}

export async function runReviewCenterRestartChecks(cwd: string): Promise<string[]> {
  const expected = JSON.parse(await readFile(path.join(cwd, 'host-m4-state.json'), 'utf8')) as {
    head: string; id: string; reference: string; body: string; draftId: string; storageKey: string;
    view: unknown; runId: string; repo: string;
  };
  const api = await hostApi();
  const preparationRestart = await restorePreparationAfterRestart(api);
  const marker = api.workspaceState.get('codereview.host.persistMarker');
  const stored = api.workspaceState.get<{ businessReview?: { id: string }; workspaceView?: unknown; repo: string }>(expected.storageKey);
  assert.ok(marker, `Real workspaceState marker was not restored: ${JSON.stringify({ keys: api.workspaceState.keys(), expectedKey: expected.storageKey })}`);
  const set = api.session.reviewSet ?? await api.loadBranch(cwd, 'feature', 'main');
  assert.equal(api.session.businessReview?.id, expected.runId, JSON.stringify({
    storedRun: stored?.businessReview?.id, storedView: stored?.workspaceView, storedRepo: stored?.repo,
    activeRepo: api.session.snapshot?.repo, activeKeys: api.workspaceState.keys(),
  }));
  assert.equal(set.headSha, expected.head);
  assert.deepEqual(api.session.workspaceView.selection, { kind: 'finding', id: expected.id });
  assert.deepEqual(api.session.workspaceView.source, { kind: 'reference', id: expected.reference });
  assert.equal(api.session.workspaceView.inspector, 'evidence');
  assert.equal(api.session.workspaceView.stage, 'review');
  assert.equal(api.session.conclusionDraft?.id, expected.draftId);
  assert.equal(api.session.conclusionDraft?.body, expected.body);
  assert.equal(api.session.conclusionPreviewCurrent, false, 'A hidden saved preview must not inherit acknowledgement after restart');
  await api.open();
  await waitFor(() => api.document().loaded && api.document().readOnly && api.document().embedded, 'source restoration after a real VS Code restart');
  assert.equal(api.session.conclusionPreviewCurrent, false, 'The review stage must not acknowledge a hidden conclusion body');
  assert.equal(api.session.conclusion?.bodyHash, businessHash(expected.body));
  return [
    preparationRestart,
    'real VS Code restart restores issue, original source, inspector and saved draft from actual workspaceState',
    'restart preserves the local receipt but does not acknowledge a hidden conclusion preview',
  ];
}
