import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { analyzeBusinessReviewPhase, businessReviewInputFits } from '../ai/analyzer';
import { businessBaseline, businessBlockers, businessRecord, coverageComplete, type BusinessModelPhase } from '../review/businessReview';
import { runBusinessReview } from '../review/businessReviewEngine';
import { BusinessReviewSource } from '../review/businessReviewSource';
import { ReviewSession } from '../review/reviewSession';
import { WorkspaceStateReviewStore } from '../review/reviewStore';
import { acceptRequirementUnderstanding, addRequirementMaterial, confirmRequirements, createRequirementsDraft, parseRequirementUnderstanding, requirementScopeKey } from '../review/requirements';
import type { ReviewSet } from '../scope/types';
import { BusinessReviewPanel, businessReportReferences } from '../ui/businessReviewPanel';
import { WorkbenchPanel, type WorkbenchActions, type WorkbenchState } from '../ui/workbenchPanel';

function within<T>(work: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 30_000);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export async function runBusinessReviewHostChecks(cwd: string, set: ReviewSet): Promise<string[]> {
  const entries = new Map<string, unknown>();
  const memento: vscode.Memento = {
    keys: () => [...entries.keys()],
    get: <T>(key: string, fallback?: T) => entries.has(key) ? entries.get(key) as T : fallback,
    update: async (key, value) => { entries.set(key, structuredClone(value)); },
  };
  const store = new WorkspaceStateReviewStore(memento);
  const session = new ReviewSession(store, 'host-fixture');
  const reloaded = new ReviewSession(store, 'host-fixture');
  const cts = new vscode.CancellationTokenSource();
  let workbench: vscode.WebviewPanel | undefined;
  try {
    await session.start(set, cwd);
    const draft = createRequirementsDraft();
    const text = 'Restore an order only after reserving inventory.';
    const sourceId = addRequirementMaterial(draft, { kind: 'paste', name: 'Order rule', location: 'Controlled host fixture', format: 'markdown', text });
    const scope = requirementScopeKey(cwd, set);
    acceptRequirementUnderstanding(draft, parseRequirementUnderstanding({
      summary: 'Keep restoration and stock reservation consistent.',
      requirements: [{ id: 'RQ-1', title: 'Reserve before restore', text, origins: [{ sourceId, version: 1, line: 1, endLine: 1, quote: text }] }],
      checks: [], questions: [{
        id: 'Q-1', text: 'Should restoration reuse the original reservation identity or create a new one?',
        origins: [{ sourceId, version: 1, line: 1, endLine: 1, quote: text }],
      }],
    }, draft, scope, 'host-controlled-business'));
    confirmRequirements(draft, scope, true);
    await session.setRequirements(draft);
    const source = new BusinessReviewSource(cwd, set);
    await source.assertCurrent(draft);
    let activePhase: BusinessModelPhase = 'plan';
    const calls: BusinessModelPhase[] = [];
    const model: vscode.LanguageModelChat = {
      id: 'host-controlled-business', name: 'Controlled business response', vendor: 'test', family: 'test', version: '1', maxInputTokens: 16_000,
      countTokens: async (value) => typeof value === 'string' ? Math.ceil(value.length / 4) : 0,
      sendRequest: async (messages, options) => {
        calls.push(activePhase);
        assert.equal(options?.modelOptions?.temperature, 0);
        const body = messages.at(-1)!.content.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart).map((part) => part.value).join('');
        const input = businessRecord(JSON.parse(body));
        const evidence = Array.isArray(input.evidence) ? input.evidence.map(businessRecord) : [];
        const cite = (text: string) => {
          const ref = evidence.find((item) => typeof item.text === 'string' && item.text.includes(text));
          assert.ok(ref, `Actual native model input must contain: ${text}`);
          return { evidenceId: ref.id, quote: text };
        };
        const refs = () => [cite('await inventory.release(order.id);'), cite('await order.restore();')];
        let output: unknown;
        if (activePhase === 'plan') output = { units: [{ id: 'U-orders', goal: 'Cancellation and restoration lifecycle', files: set.files.map((file) => file.path), requirementIds: ['RQ-1'] }] };
        else if (activePhase === 'discover') {
          assert.equal(evidence.some((item) => typeof item.text === 'string' && item.text.includes('local unsaved work')), false);
          output = { summary: 'Track the lifecycle across both operations.', candidates: [], requests: [] };
        } else if (activePhase === 'global') output = {
          summary: 'Independently found a combined stock lifecycle gap.',
          candidates: [{ kind: 'implementation', title: 'Restore does not recreate released stock', cause: 'The order lifecycle does not close the stock lifecycle', trigger: 'Cancel then restore', impact: 'Stock is promised twice', requirementIds: ['RQ-1'], evidence: refs() }], requests: [],
        };
        else if (activePhase === 'verify') output = { decisions: [{
          candidateIds: (input.candidates as { id: string }[]).map((candidate) => candidate.id), kind: 'implementation', status: 'confirmed', severity: 'high', attribution: 'unknown',
          title: 'Restore does not recreate released stock', cause: 'The order lifecycle does not close the stock lifecycle', trigger: 'Cancel then restore', impact: 'Stock is promised twice',
          requirementIds: ['RQ-1'], evidence: refs(), counterEvidence: [], counterRationale: 'No reservation guard exists in the supplied controlled restore route.', critical: null,
        }] };
        else output = {
          requirements: [{ id: 'RQ-1', status: 'violated', rationale: 'The current restore path does not reserve stock.', evidence: refs(), critical: null }],
          premises: [{ id: 'Q-1', status: 'unknown', rationale: 'Reservation identity is unspecified; either choice still requires an actual reservation.', evidence: [], critical: null }],
          priorCritical: [],
        };
        return { text: (async function* () { yield JSON.stringify(output); })(), stream: (async function* () {})() };
      },
    };
    const run = await within(runBusinessReview(set, businessBaseline(cwd, set, draft), {
      modelId: model.id, token: cts.token, now: Date.now, cancel: () => cts.cancel(), isCurrent: () => true,
      read: source.read, readFresh: source.readFresh, resolve: (request) => source.resolve(request, cts.token),
      fits: (phase, payload) => businessReviewInputFits(model, phase, payload, cts.token),
      request: (phase, payload) => { activePhase = phase; return analyzeBusinessReviewPhase(model, phase, payload, cts.token, () => {}); },
      update: (run) => session.setBusinessReview(run),
    }), 'native M3 model-adapter workflow');
    assert.equal(run.status, 'completed');
    assert.deepEqual(calls, ['plan', 'discover', 'global', 'verify', 'assess']);
    assert.equal(run.findings[0].status, 'confirmed');
    assert.equal(run.requirements[0].status, 'violated');
    assert.equal(run.premises[0].status, 'unknown');
    assert.ok(run.coverage.every(coverageComplete));
    assert.equal(session.canSubmitConclusion('approve'), false);
    await source.assertCurrent(draft, run);
    await reloaded.start(set, cwd);
    assert.equal(reloaded.businessReview?.id, run.id);
    assert.equal(reloaded.businessReview?.confirmed, false);

    let finishReport!: () => void;
    let failReport!: (error: Error) => void;
    const reportReady = new Promise<void>((resolve, reject) => { finishReport = resolve; failReport = reject; });
    const noop = () => {};
    BusinessReviewPanel.show(run, {
      recheck: noop, cancel: noop, prepare: noop, confirm: () => session.confirmBusinessReview(), note: noop, source: noop,
      onRendered: (report) => {
        if (report.error) failReport(new Error(report.error));
        else if (report.references === businessReportReferences(run).length && report.references >= 3 && report.quotationBlocks >= 6) finishReport();
      },
    });
    await within(reportReady, 'native M3 report script and source-reference rendering');
    let finishWorkbench!: () => void;
    const workbenchReady = new Promise<void>((resolve) => { finishWorkbench = resolve; });
    const state: WorkbenchState = {
      structureVersion: 1, label: set.label, files: [], findings: [], coverage: session.totalCoverage(),
      gatePassed: session.canSubmitConclusion('approve'), feedbackAllowed: session.canSubmitConclusion('comment'),
      requirementStatus: session.requirementStatus, globalDone: false, hasGlobalReport: false,
      modelLabel: model.name, repoName: 'Host fixture', projects: [], languages: [],
      businessReview: { running: false, hasReport: true, progress: 'Controlled workflow complete; verified defect remains.', blockers: businessBlockers(run) },
    };
    const actions: WorkbenchActions = {
      open: noop, openFocus: noop, focusDoc: noop, disposeFinding: noop, locate: noop,
      globalAnalysis: noop, cancelGlobalAnalysis: noop, showGlobal: noop,
      businessReview: noop, cancelBusinessReview: noop, showBusinessReview: noop,
      exportReport: noop, submit: noop, pickModel: noop, pickLanguage: noop, pickBranch: noop,
      pickProject: noop, pickScope: noop, pickScopeKind: noop, pickProjectCwd: noop, pickLanguageId: noop,
      openDynMenu: noop, applyDynMenu: noop,
      onRendered: (report) => {
        if (report.businessControls === 3 && !report.running && report.showEnabled && report.feedbackEnabled) finishWorkbench();
      },
    };
    workbench = vscode.window.createWebviewPanel('codereview.workbench', 'Business host fixture', vscode.ViewColumn.One, { enableScripts: true });
    WorkbenchPanel.adopt(workbench, () => state, actions);
    await within(workbenchReady, 'native M3 workbench controls and non-approval feedback state');
    return [
      'native M3 exact-source five-phase workflow, independent global finding and persistence (controlled model response, not semantic quality evaluation)',
      'native M3 report/source rendering and workbench feedback/approval controls',
    ];
  } finally {
    workbench?.dispose();
    BusinessReviewPanel.closeIfOpen();
    cts.cancel(); cts.dispose(); session.dispose(); reloaded.dispose();
  }
}
