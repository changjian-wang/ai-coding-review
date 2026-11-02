import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ReviewExtensionApi } from '../extension';
import { businessRecord, coverageComplete, type BusinessModelPhase } from '../review/businessReview';
import { createRequirementsDraft } from '../review/requirements';
import type { ConclusionDraft } from '../review/conclusionDraft';

async function waitFor(test: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!test()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function runUnifiedReviewHostChecks(cwd: string): Promise<string[]> {
  const extension = vscode.extensions.getExtension<ReviewExtensionApi>('changjian-wang.ai-coding-review');
  assert.ok(extension);
  const api = (await extension.activate()).test;
  assert.ok(api);
  const calls: { phase: BusinessModelPhase; unit?: string }[] = [];
  let originalDraft: ConclusionDraft | undefined;
  let loaded = false;
  const historyTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('codereview.globalReport'));
  const model: vscode.LanguageModelChat = {
    id: 'controlled-unified-review', name: 'Controlled unified review', vendor: 'test', family: 'test', version: '1', maxInputTokens: 32_000,
    countTokens: async (value) => typeof value === 'string' ? Math.ceil(value.length / 4) : 1,
    sendRequest: async (messages) => {
      const text = (message: vscode.LanguageModelChatMessage) => message.content
        .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart).map((part) => part.value).join('');
      const instruction = messages.slice(0, -1).map(text).join('\n');
      const input = businessRecord(JSON.parse(text(messages.at(-1)!)));
      const phase: BusinessModelPhase = instruction.includes('Organize the supplied scope') ? 'plan'
        : instruction.includes('Inspect this business unit') ? 'discover'
          : instruction.includes('Independently discover cross-unit') ? 'global'
            : instruction.includes('Independently adjudicate') ? 'verify' : 'assess';
      const unit = input.unit ? businessRecord(input.unit) : undefined;
      calls.push({ phase, unit: unit ? String(unit.id) : undefined });
      let output: unknown;
      if (phase === 'plan') output = {
        units: (input.files as { path: string }[]).map((file, index) => ({
          id: `U-${index}`, goal: `Controlled unit for ${file.path}`, files: [file.path], requirementIds: [],
        })),
      };
      else if (phase === 'discover' || phase === 'global') output = { summary: 'Controlled integration result, not a semantic-quality claim.', candidates: [], requests: [] };
      else if (phase === 'verify') throw new Error('The clean integration fixture must not create fabricated candidates.');
      else output = { requirements: [], premises: [], priorCritical: [] };
      return { text: (async function* () { yield JSON.stringify(output); })(), stream: (async function* () {})() };
    },
  };
  try {
    const set = await api.loadBranch(cwd, 'feature', 'main');
    originalDraft = structuredClone(api.session.conclusionDraft);
    loaded = true;
    api.session.snapshot!.businessReview = undefined;
    const draft = createRequirementsDraft(); draft.technicalOnly = true;
    await api.session.setRequirements(draft);
    api.session.setGlobalReport({
      conclusion: 'Saved historical technical observation.', recommendation: 'comment', evidence: [], verdicts: [], fixSpots: [],
    });
    const history = api.session.globalReport;
    api.useReviewModel(model);
    await api.open();
    await api.action({ action: 'file', path: 'src/restore.ts' });
    await waitFor(() => api.document().loaded && api.document().path === 'src/restore.ts', 'unified review source');
    assert.ok(set.files.some((file) => !api.session.fileFullySeen(file.path)), 'The alias must be tested before every file is read');
    await vscode.commands.executeCommand('codereview.globalAnalysis');
    assert.equal(api.session.businessReview?.status, 'completed');
    assert.equal(api.session.businessReview?.globalCompleted, true, 'Scope alias must complete independent global discovery');
    assert.equal(api.session.businessReview?.coverage.every(coverageComplete), true, JSON.stringify(api.session.businessReview?.coverage));
    assert.equal(api.session.globalReport, history, 'Unified review must not write or replace legacy global-report state');
    assert.ok(calls.some((call) => call.phase === 'global'));
    const first = api.session.businessReview!.id;
    const before = calls.length;
    await vscode.commands.executeCommand('codereview.analyzeFile');
    assert.notEqual(api.session.businessReview!.id, first);
    assert.equal(api.session.businessReview!.status, 'completed');
    assert.equal(api.session.businessReview!.coverage.every(coverageComplete), true, 'Prioritized recheck must keep all source intervals covered');
    const focused = calls.slice(before);
    const prioritized = api.session.businessReview!.units.find((unit) => unit.files.includes('src/restore.ts'));
    assert.ok(prioritized);
    assert.equal(focused.find((call) => call.phase === 'discover')?.unit, prioritized.id);
    assert.ok(focused.some((call) => call.phase === 'global'));
    assert.equal(api.session.globalReport, history);
    assert.ok(set.files.every((file) => api.session.findings(file.path).length === 0), 'New findings must not be written into the retired file-analysis store');

    await vscode.commands.executeCommand('codereview.showGlobalReport');
    assert.equal(api.session.workspaceView.stage, 'conclusion');
    assert.equal(historyTabs().length, 0, 'The old conclusion command must not open another live report');
    const runId = api.session.businessReview!.id;
    const confirmed = api.session.globalConfirmed;
    await vscode.commands.executeCommand('codereview.viewLegacyReport');
    await waitFor(() => historyTabs().length === 1, 'explicit read-only legacy-report tab');
    assert.equal(api.session.businessReview!.id, runId);
    assert.equal(api.session.globalConfirmed, confirmed, 'Viewing history must not acknowledge or approve current work');
    await vscode.window.tabGroups.close(historyTabs());
    await vscode.commands.executeCommand('codereview.showBusinessReview');
    assert.equal(api.session.workspaceView.stage, 'review');
    assert.equal(api.session.workspaceView.selection.kind, 'overview');
    return [
      'production legacy scope/file commands use unified business review without the old read-every-file gate; prioritized recheck preserves complete coverage and global verification',
      'production conclusion aliases open one review center, while explicit legacy history is read-only and cannot approve or replace current findings',
    ];
  } finally {
    api.useReviewModel();
    await vscode.window.tabGroups.close(historyTabs());
    if (loaded && api.session.snapshot) {
      api.session.snapshot.conclusionDraft = originalDraft;
      await api.session.persist();
    }
  }
}
