import { m } from '../i18n';
import type { BusinessCitation } from './businessReview';
import type { ReviewSession } from './reviewSession';
import { ConclusionDraftDataError } from './conclusionDraft';
import {
  centerLegacyFindings, centerReferenceId, centerReferences, reviewCenterContextKey,
  type CenterAction, type CenterReference,
} from '../ui/reviewCenterState';

export interface CenterFileTarget {
  path: string;
  line?: number;
  endLine?: number;
  reference?: BusinessCitation;
  legacyId?: string;
}

export interface ReviewCenterServices {
  preparing(): boolean;
  restoreSource(): Promise<void>;
  openFile(target: CenterFileTarget): Promise<void>;
  openReference(id: string, reference: CenterReference): Promise<void>;
  prepare(): Promise<void>;
  run(): Promise<void>;
  cancel(): void;
  model(): Promise<void>;
  language(): Promise<void>;
  export(): Promise<void>;
  confirmReport(confirmed: boolean): Promise<void>;
  note(id: string): Promise<void>;
  fix(target: { path?: string; id: string; business: boolean }): Promise<void>;
  defaultBody(): string;
  findingBody(id: string): string;
  confirmReplace(): Promise<boolean>;
  confirmRemoteCheck(): Promise<boolean>;
  publish(input: { id: string; revision: number; previewKey: string }): Promise<void>;
  legacyAnalyze(): Promise<void>;
  legacyGlobal(): Promise<void>;
}

export class ReviewCenterController {
  constructor(private readonly session: ReviewSession, private readonly services: ReviewCenterServices) {}

  private current(contextKey: string): void {
    if (contextKey !== reviewCenterContextKey(this.session)) throw new ConclusionDraftDataError(m().reviewCenter.staleSelection);
  }

  private async file(target: CenterFileTarget): Promise<void> {
    if (!this.session.hasReviewFile(target.path)) throw new ConclusionDraftDataError(m().reviewCenter.staleSelection);
    this.session.setWorkspaceView({ stage: 'review', source: { kind: 'file', path: target.path } });
    await this.services.openFile(target);
  }

  private async reference(id: string): Promise<void> {
    const reference = centerReferences(this.session).get(id);
    if (!reference) throw new ConclusionDraftDataError(m().businessReview.invalidCitation);
    if (reference.kind === 'business' && reference.citation.kind === 'code' && reference.citation.side === 'head'
      && this.session.hasReviewFile(reference.citation.path)) {
      await this.file({
        path: reference.citation.path, line: reference.citation.line, endLine: reference.citation.endLine, reference: reference.citation,
      });
      return;
    }
    this.session.setWorkspaceView({ stage: 'review', source: { kind: 'reference', id } });
    await this.services.openReference(id, reference);
  }

  private async primary(): Promise<void> {
    const selection = this.session.workspaceView.selection;
    const run = this.session.businessReview;
    if (selection.kind === 'finding') {
      const finding = run?.findings.find((finding) => finding.id === selection.id);
      const ref = finding?.evidence.find((ref) => ref.kind === 'code' && ref.side === 'head') ?? finding?.evidence[0] ?? finding?.counterEvidence[0];
      if (ref) await this.reference(centerReferenceId({ kind: 'business', citation: ref }));
    } else if (selection.kind === 'unit') {
      const path = run?.units.find((unit) => unit.id === selection.id)?.files[0];
      if (path) await this.file({ path });
    } else if (selection.kind === 'legacy') {
      const item = centerLegacyFindings(this.session).get(selection.id);
      if (item) await this.file({ path: item.path, line: item.finding.line, endLine: item.finding.endLine, legacyId: item.finding.id });
    } else if (selection.kind === 'critical') {
      const ref = run?.priorCriticalVerdicts.find((item) => item.id === selection.id)?.evidence[0];
      if (ref) await this.reference(centerReferenceId({ kind: 'business', citation: ref }));
    }
  }

  private async ensureDraft(): Promise<void> {
    if (!this.session.conclusionDraft) await this.session.generateConclusionDraft(this.services.defaultBody());
  }

  async handle(message: CenterAction): Promise<{ preview?: boolean }> {
    if (message.action === 'ready') {
      if (this.session.workspaceView.stage === 'conclusion') await this.ensureDraft();
      else if (this.session.workspaceView.stage === 'prepare') await this.services.prepare();
      else if (!this.session.workspaceViewError) await this.services.restoreSource();
      return {};
    }
    this.current(message.contextKey);
    if (this.services.preparing()) throw new ConclusionDraftDataError(m().reviewCenter.preparePending);
    if (message.draft && message.action !== 'savePreview' && message.action !== 'generateDraft') {
      await this.session.saveConclusionDraft(message.draft.id, message.draft.revision, message.draft.body, message.draft.verdict);
      this.current(message.contextKey);
    }
    const value = message.value;
    switch (message.action) {
      case 'stage':
        if (value !== 'prepare' && value !== 'review' && value !== 'conclusion') throw new ConclusionDraftDataError(m().reviewCenter.staleSelection);
        this.session.setWorkspaceView({ stage: value });
        if (value === 'prepare') await this.services.prepare();
        else if (value === 'conclusion') await this.ensureDraft();
        else await this.services.restoreSource();
        break;
      case 'navigator':
        if (value !== 'business' && value !== 'findings' && value !== 'feedback' && value !== 'files') throw new ConclusionDraftDataError();
        this.session.setWorkspaceView({ navigator: value });
        break;
      case 'inspector':
        if (value !== 'judgment' && value !== 'evidence' && value !== 'handling') throw new ConclusionDraftDataError();
        this.session.setWorkspaceView({ inspector: value });
        break;
      case 'focus':
        if (value !== undefined && value !== 'true' && value !== 'false') throw new ConclusionDraftDataError();
        this.session.setWorkspaceView({ focus: value === undefined ? !this.session.workspaceView.focus : value === 'true' });
        break;
      case 'select': {
        const id = message.id;
        const kind = message.kind;
        if (kind === 'overview') {
          this.session.setWorkspaceView({ stage: 'review', selection: { kind: 'overview' } });
          break;
        }
        const run = this.session.businessReview;
        if (!id || !(kind === 'finding' && run?.findings.some((finding) => finding.id === id)
          || kind === 'unit' && run?.units.some((unit) => unit.id === id)
          || kind === 'critical' && run?.priorCritical.some((item) => item.id === id)
          || kind === 'legacy' && centerLegacyFindings(this.session).has(id))) throw new ConclusionDraftDataError(m().reviewCenter.staleSelection);
        if (kind !== 'finding' && kind !== 'unit' && kind !== 'critical' && kind !== 'legacy') throw new ConclusionDraftDataError();
        this.session.setWorkspaceView({ stage: 'review', selection: { kind, id } });
        await this.primary();
        break;
      }
      case 'file':
        if (!message.path) throw new ConclusionDraftDataError();
        await this.file({ path: message.path });
        break;
      case 'reference':
        if (!message.id) throw new ConclusionDraftDataError();
        await this.reference(message.id);
        break;
      case 'next': {
        const findings = this.session.businessReview?.findings ?? [];
        if (!findings.length) throw new ConclusionDraftDataError(m().reviewCenter.emptyFindings);
        const selected = this.session.workspaceView.selection;
        const at = selected.kind === 'finding' ? findings.findIndex((finding) => finding.id === selected.id) : -1;
        const next = findings[(at + 1) % findings.length];
        this.session.setWorkspaceView({ stage: 'review', navigator: 'findings', selection: { kind: 'finding', id: next.id } });
        await this.primary();
        break;
      }
      case 'run': await this.services.run(); break;
      case 'cancel': this.services.cancel(); break;
      case 'model': await this.services.model(); break;
      case 'language': await this.services.language(); break;
      case 'export': await this.services.export(); break;
      case 'confirmReport':
        if (value !== 'true' && value !== 'false') throw new ConclusionDraftDataError();
        await this.services.confirmReport(value === 'true');
        break;
      case 'note':
        if (!message.id || !this.session.businessReview?.findings.some((finding) => finding.id === message.id)) throw new ConclusionDraftDataError();
        await this.services.note(message.id);
        break;
      case 'fix':
        if (!message.id) throw new ConclusionDraftDataError();
        await this.services.fix({ path: message.path, id: message.id, business: !message.path });
        break;
      case 'generateDraft':
        if (this.session.snapshot?.conclusionDraft !== undefined && !await this.services.confirmReplace()) return {};
        this.current(message.contextKey);
        await this.session.generateConclusionDraft(this.services.defaultBody());
        this.session.setWorkspaceView({ stage: 'conclusion' });
        break;
      case 'appendFinding': {
        if (!message.id || !this.session.businessReview?.findings.some((finding) => finding.id === message.id)) throw new ConclusionDraftDataError();
        await this.ensureDraft();
        const draft = this.session.conclusionDraft!;
        await this.session.saveConclusionDraft(draft.id, draft.revision, `${draft.body}\n\n${this.services.findingBody(message.id)}`, draft.verdict);
        this.session.setWorkspaceView({ stage: 'conclusion' });
        break;
      }
      case 'savePreview': {
        const edit = message.draft;
        if (!edit) throw new ConclusionDraftDataError();
        const draft = await this.session.saveConclusionDraft(edit.id, edit.revision, edit.body, edit.verdict);
        this.current(message.contextKey);
        await this.session.prepareConclusionPreview(draft.id, draft.revision);
        return { preview: true };
      }
      case 'previewRendered':
        if (!message.id || message.revision === undefined || !message.previewKey) throw new ConclusionDraftDataError();
        this.session.acknowledgeConclusionPreview(message.id, message.revision, message.previewKey);
        break;
      case 'publish':
        if (!message.id || message.revision === undefined || !message.previewKey) throw new ConclusionDraftDataError();
        await this.services.publish({ id: message.id, revision: message.revision, previewKey: message.previewKey });
        break;
      case 'checkPublication':
        if (!message.id || !await this.services.confirmRemoteCheck()) return {};
        this.current(message.contextKey);
        await this.session.acknowledgePublicationUncertainty(message.id);
        break;
      case 'legacyAnalyze': await this.services.legacyAnalyze(); break;
      case 'legacyGlobal': await this.services.legacyGlobal(); break;
      default: throw new ConclusionDraftDataError(m().reviewCenter.staleSelection);
    }
    return {};
  }
}
