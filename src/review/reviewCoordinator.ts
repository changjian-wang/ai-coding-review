import * as vscode from 'vscode';
import { fmt, m } from '../i18n';
import { analyzeRequirementSources, AnalysisError } from '../ai/analyzer';
import type { FileAnalysisSummary, GlobalReport } from '../ai/types';
import { humanRequirementUnderstanding } from '../ai/reviewRequirements';
import { readRequirementLink } from './requirementSources';
import {
  applyRequirementUnderstanding, beginWorkflowRun, finishWorkflowRun, invalidateWorkflow,
  putRequirementMaterial, recordWorkflowFile, selectRequirementMaterial,
  workflowResultKey, WorkflowError, type ReviewWorkflowState,
} from './reviewWorkflow';
import type { ReviewSession } from './reviewSession';

export type WorkflowFileResult =
  | { kind: 'analyzed'; hashes: Record<string, string>; summary: FileAnalysisSummary; complete: boolean }
  | { kind: 'deleted'; hashes: Record<string, string>; limitations?: string[] }
  | { kind: 'excluded'; reason: string };

export interface ReviewCoordinatorServices {
  model(): Promise<vscode.LanguageModelChat | undefined>;
  repositoryStamp(token?: vscode.CancellationToken): Promise<string>;
  validateHashes(hashes: Readonly<Record<string, string>>): Promise<boolean>;
  analyzeFile(path: string, model: vscode.LanguageModelChat, workflow: ReviewWorkflowState, token: vscode.CancellationToken): Promise<WorkflowFileResult>;
  analyzeGlobal(model: vscode.LanguageModelChat, workflow: ReviewWorkflowState, token: vscode.CancellationToken): Promise<GlobalReport>;
  applyGlobal(report: GlobalReport): Promise<void>;
  showSource(path: string): void;
  changed(): void;
  notice(message: string, error?: boolean): void;
  errorText(error: unknown): string;
}

export class ReviewCoordinator {
  private reviewCts?: vscode.CancellationTokenSource;
  private understandingCts?: vscode.CancellationTokenSource;
  private sourceCts?: vscode.CancellationTokenSource;
  private preparing = false;
  private editor = '';
  private uiVersion = 0;
  private inputGeneration = 0;
  progress?: string;

  constructor(private readonly session: ReviewSession, private readonly services: ReviewCoordinatorServices) {}

  get version(): number { return this.uiVersion; }
  get busy(): boolean { return !!this.sourceCts || this.preparing; }
  get editing(): boolean { return !!this.editor; }

  private state(): ReviewWorkflowState {
    const state = this.session.workflow;
    if (!state) throw new WorkflowError('noReview');
    return state;
  }

  private changed(): void {
    this.uiVersion++;
    this.services.changed();
  }

  setEditor(id: string): void {
    this.editor = id;
    this.changed();
  }

  assertInputsAvailable(): void {
    if (this.reviewCts || this.sourceCts || this.state().run.status === 'running') throw new WorkflowError('running');
  }

  assertNoDraft(): void {
    if (this.editor) throw new Error(m().reviewCenter.unsavedEdit);
  }

  async putText(label: string, text: string, human = false, location?: string, kind: 'text' | 'file' | 'link' = 'text'): Promise<void> {
    this.assertInputsAvailable();
    if (human && !label.trim()) throw new WorkflowError('emptyMaterial');
    const generation = ++this.inputGeneration;
    const scope = this.state().scopeKey;
    this.understandingCts?.cancel();
    await this.session.updateWorkflow((state) => {
      putRequirementMaterial(state, {
        kind: human ? 'human' : kind, label: label.trim() || `${m().reviewCenter.materials} ${state.materials.length + 1}`,
        text, location,
      });
    });
    if (generation === this.inputGeneration && this.session.workflow?.scopeKey === scope) {
      void this.understand().catch((error: unknown) => this.services.notice(this.services.errorText(error), true));
    }
  }

  async removeSource(id: string): Promise<void> {
    this.assertInputsAvailable();
    const generation = ++this.inputGeneration;
    const scope = this.state().scopeKey;
    this.understandingCts?.cancel();
    await this.session.updateWorkflow((state) => selectRequirementMaterial(state, id, false));
    if (generation === this.inputGeneration && this.session.workflow?.scopeKey === scope && this.state().materials.some((item) => item.selected)) {
      void this.understand().catch((error: unknown) => this.services.notice(this.services.errorText(error), true));
    }
  }

  async putLink(url: string): Promise<void> {
    this.assertInputsAvailable();
    const state = this.state();
    const scope = state.scopeKey;
    const cts = new vscode.CancellationTokenSource();
    this.sourceCts = cts;
    this.changed();
    try {
      const source = await readRequirementLink(url, this.session.getCwd() ?? '', cts.token);
      if (cts.token.isCancellationRequested || this.session.workflow?.scopeKey !== scope) return;
      this.sourceCts = undefined;
      await this.putText(source.label, source.text, false, source.location, 'link');
    } finally {
      if (this.sourceCts === cts) this.sourceCts = undefined;
      cts.dispose();
      this.changed();
    }
  }

  async understand(): Promise<void> {
    if (this.reviewCts || this.sourceCts) throw new WorkflowError('running');
    this.understandingCts?.cancel();
    this.inputGeneration++;
    const source = structuredClone(this.state());
    const selected = source.materials.filter((item) => item.selected);
    if (!selected.length) return;
    const cts = new vscode.CancellationTokenSource();
    this.understandingCts = cts;
    const current = () => this.understandingCts === cts && !cts.token.isCancellationRequested
      && this.session.workflow?.scopeKey === source.scopeKey && this.session.workflow.revision === source.revision;
    try {
      await this.session.updateWorkflow((state) => {
        state.understanding.status = 'pending';
        state.understanding.error = undefined;
      });
      let understanding;
      if (selected.every((item) => item.kind === 'human')) {
        understanding = humanRequirementUnderstanding(source);
      } else {
        const model = await this.services.model();
        if (!model) throw new AnalysisError(m().model.noModel);
        if (!current()) return;
        understanding = await analyzeRequirementSources(model, source, cts.token);
      }
      if (!current()) return;
      await this.session.updateWorkflow((state) => applyRequirementUnderstanding(state, understanding, source.scopeKey));
    } catch (error) {
      if (current()) {
        await this.session.updateWorkflow((state) => {
          state.understanding.status = 'failed';
          state.understanding.error = this.services.errorText(error);
        });
        this.services.notice(this.services.errorText(error), true);
      }
    } finally {
      if (this.understandingCts === cts) this.understandingCts = undefined;
      cts.dispose();
      this.changed();
    }
  }

  async run(confirmed: boolean, resume: boolean, revision: number, onlyPaths?: ReadonlySet<string>): Promise<void> {
    this.assertInputsAvailable();
    this.assertNoDraft();
    const source = this.state();
    if (source.revision !== revision) throw new WorkflowError('staleResult');
    const scopeKey = source.scopeKey;
    const roots = this.session.reviewSet?.files.filter((file) => !file.context) ?? [];
    if (!roots.length) throw new WorkflowError('noReview');
    const cts = new vscode.CancellationTokenSource();
    this.reviewCts = cts;
    this.preparing = true;
    this.changed();
    let runId = '';
    const current = () => this.reviewCts === cts && !cts.token.isCancellationRequested
      && this.session.workflow?.scopeKey === scopeKey && this.session.workflow.revision === revision
      && (!runId || this.session.workflow.run.id === runId);
    try {
      const stamp = await this.services.repositoryStamp(cts.token);
      const model = await this.services.model();
      if (!model) throw new AnalysisError(m().model.noModel);
      if (!current()) return;
      const previous = this.state().run;
      const priorFindings = this.session.knownWorkflowFindings();
      const reusable = resume && previous.key === workflowResultKey(this.state()) && previous.repositoryStamp === stamp
        && await this.services.validateHashes(previous.hashes);
      if (!current()) return;
      await this.session.updateWorkflow((state) => {
        beginWorkflowRun(state, confirmed, model.id, reusable, onlyPaths);
        state.run.priorFindings = priorFindings;
        state.run.repositoryStamp = stamp;
      });
      await this.session.prepareWorkflowDispositions(`${this.state().run.key}:${stamp}`);
      if (!current()) return;
      runId = this.state().run.id;
      this.preparing = false;
      const candidates = onlyPaths ? this.session.reviewSet?.files.filter((file) => onlyPaths.has(file.path)) ?? [] : roots;
      const remaining = candidates.filter((file) => !this.state().run.completed.includes(file.path));
      if (remaining[0]) this.services.showSource(remaining[0].path);
      const deletions: { path: string; hashes: Record<string, string>; limitations: string[] }[] = [];
      for (const file of remaining) {
        if (!current()) return;
        this.progress = fmt(m().reviewCenter.reviewingFile, file.path);
        this.changed();
        try {
          const result = await this.services.analyzeFile(file.path, model, this.state(), cts.token);
          if (!current()) return;
          if (result.kind === 'excluded') {
            await this.session.updateWorkflow((state) => { state.run.excluded.push({ path: file.path, reason: result.reason }); });
          } else if (result.kind === 'deleted') {
            deletions.push({ path: file.path, hashes: result.hashes, limitations: result.limitations ?? [] });
            await this.session.updateWorkflow((state) => {
              if (Object.entries(result.hashes).some(([path, hash]) => state.run.hashes[path] && state.run.hashes[path] !== hash)) throw new WorkflowError('staleResult');
              Object.assign(state.run.hashes, result.hashes);
            });
          } else {
            const limits = result.summary.contextTruncated
              ? [m().analysis.contextBudgetReached((result.summary.contextLimitReasons ?? []).map((reason) => m().analysis.contextLimitReason[reason]).join(', '))]
              : [];
            await this.session.updateWorkflow((state) => recordWorkflowFile(state, runId, file.path, result.hashes, limits, result.complete));
            this.services.showSource(file.path);
          }
        } catch (error) {
          if (!current()) return;
          if (error instanceof WorkflowError && error.code === 'staleResult') throw error;
          await this.session.updateWorkflow((state) => { state.run.failed.push({ path: file.path, error: this.services.errorText(error) }); });
        }
      }
      if (!current()) return;
      if (!this.state().run.completed.length && !deletions.length) {
        await this.session.updateWorkflow((state) => {
          state.run.status = 'partial';
          state.run.limitations.push(m().reviewCenter.errors.noResults);
          state.run.completedAt = Date.now();
        });
        return;
      }
      this.progress = m().reviewCenter.reviewingGlobal;
      this.changed();
      const report = await this.services.analyzeGlobal(model, this.state(), cts.token);
      if (!current()) return;
      const business = report.business;
      if (!business) throw new WorkflowError('invalidBusinessReview');
      if (await this.services.repositoryStamp(cts.token) !== stamp || !await this.services.validateHashes(this.state().run.hashes)) {
        throw new WorkflowError('staleResult');
      }
      if (!current()) return;
      await this.services.applyGlobal(report);
      if (!current()) return;
      await this.session.flushWorkflowEvidence();
      if (!current()) return;
      await this.session.updateWorkflow((state) => {
        for (const file of deletions) recordWorkflowFile(state, runId, file.path, file.hashes, file.limitations, report.fullSourceFiles?.includes(file.path) === true);
        if (report.coverageLimits?.length) state.run.limitations.push(fmt(m().reviewCenter.globalLimited, report.coverageLimits.join(', ')));
        const required = roots.filter((file) => !state.run.excluded.some((item) => item.path === file.path)).map((file) => file.path);
        finishWorkflowRun(state, runId, required, business);
      });
    } catch (error) {
      if (current()) {
        await this.session.updateWorkflow((state) => {
          if (error instanceof WorkflowError && error.code === 'staleResult') invalidateWorkflow(state);
          else {
            state.run.status = 'partial';
            state.run.limitations.push(this.services.errorText(error));
          }
          state.run.completedAt = Date.now();
        });
        this.services.notice(this.services.errorText(error), true);
      }
    } finally {
      if (this.reviewCts === cts) {
        this.reviewCts = undefined;
        this.preparing = false;
        this.progress = undefined;
      }
      cts.dispose();
      this.changed();
    }
  }

  async validateCurrentResults(): Promise<void> {
    const state = this.state();
    try {
      if (state.run.repositoryStamp !== await this.services.repositoryStamp() || !await this.services.validateHashes(state.run.hashes)) {
        throw new WorkflowError('staleResults');
      }
    } catch (error) {
      await this.session.updateWorkflow(invalidateWorkflow);
      throw error;
    }
  }

  async cancel(): Promise<void> {
    this.inputGeneration++;
    const reviewing = this.reviewCts;
    const understanding = this.understandingCts;
    reviewing?.cancel();
    understanding?.cancel();
    this.sourceCts?.cancel();
    this.reviewCts = undefined;
    this.understandingCts = undefined;
    this.sourceCts = undefined;
    this.preparing = false;
    this.progress = undefined;
    if (reviewing && this.state().run.status === 'running') {
      await this.session.updateWorkflow((state) => { state.run.status = 'cancelled'; state.run.completedAt = Date.now(); });
    } else if (this.state().understanding.status === 'pending') {
      await this.session.updateWorkflow((state) => {
        state.understanding.status = 'failed';
        state.understanding.error = m().reviewCenter.runState.cancelled;
      });
    }
    this.changed();
  }

  interruptReview(): void {
    this.reviewCts?.cancel();
    this.reviewCts = undefined;
    this.preparing = false;
    this.progress = undefined;
  }

  resetScope(): void {
    this.inputGeneration++;
    this.reviewCts?.cancel();
    this.understandingCts?.cancel();
    this.sourceCts?.cancel();
    this.reviewCts = undefined;
    this.understandingCts = undefined;
    this.sourceCts = undefined;
    this.preparing = false;
    this.editor = '';
    this.progress = undefined;
    this.changed();
  }

  dispose(): void {
    this.reviewCts?.cancel();
    this.understandingCts?.cancel();
    this.sourceCts?.cancel();
  }
}
