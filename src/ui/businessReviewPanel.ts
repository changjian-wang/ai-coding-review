import * as vscode from 'vscode';
import { fmt, m, resolveLanguage } from '../i18n';
import {
  businessBlockers, businessHash, coverageComplete,
  type BusinessCitation, type BusinessReviewRun,
} from '../review/businessReview';
import { renderRequirementMarkdown } from './requirementMarkdown';
import { esc, escAttr, nonce } from './html';
import { DocumentPanel } from './documentPanel';

export function businessReportReferences(run: BusinessReviewRun): BusinessCitation[] {
  const origins = [...run.baseline.requirements, ...run.baseline.excluded, ...run.baseline.questions].flatMap((item) => item.origins.map((origin): BusinessCitation => {
    const source = run.baseline.materials.find((source) => source.sourceId === origin.sourceId && source.version === origin.version);
    return {
      evidenceId: `origin-${origin.sourceId}-${origin.version}-${origin.line}`, kind: 'material', side: 'material',
      sourceId: origin.sourceId, version: origin.version, sourceHash: source?.hash ?? '',
      path: source?.path ?? origin.sourceId, line: origin.line, endLine: origin.endLine, quote: origin.quote,
    };
  }));
  const seen = new Set<string>();
  return [
    ...origins, ...run.findings.flatMap((finding) => [...finding.evidence, ...finding.counterEvidence]),
    ...run.requirements.flatMap((item) => item.evidence), ...run.premises.flatMap((item) => item.evidence),
    ...run.priorCriticalVerdicts.flatMap((item) => item.evidence),
  ].filter((ref) => {
    const id = businessHash(JSON.stringify(ref));
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function citationMarkdown(refs: readonly BusinessCitation[]): string[] {
  return refs.flatMap((ref) => [
    `\`${ref.path}\` [${ref.side}${ref.version ? ` · v${ref.version}` : ''}] · L${ref.line}–${ref.endLine} · sha256 \`${ref.sourceHash}\``,
    '', ...ref.quote.split('\n').map((line) => `    ${line}`), '',
  ]);
}

export function businessReportMarkdown(run: BusinessReviewRun): string {
  const t = m().businessReview;
  const lines = [
    `# ${t.title}`, '', `${run.scope.repository} / ${run.scope.label}`,
    `head: ${run.scope.headSha}${run.scope.baseSha ? ` / base: ${run.scope.baseSha}` : ''}`,
    `\n**${t[run.status]}** · ${run.modelId} · ${new Date(run.startedAt).toISOString()}`,
    `\n${run.mode === 'technical' ? t.modeTechnical : t.modeRequirements}`,
    ...(run.requirements.some((item) => item.status === 'unknown') || run.premises.some((item) => item.status === 'unknown') ? [`\n${t.partialRequirements}`] : []),
    `\n> ${t.boundary}`, `\n> ${t.materialSnapshotBoundary}`, `\n> ${t.retryNote}`,
    '', `## ${t.limits}`, '',
    ...[...businessBlockers(run), ...run.limitations, ...run.errors].map((reason) => `- ${reason}`),
    '', `## ${t.coverage}`, '',
    ...run.coverage.map((entry) => `- \`${entry.path}\` [${entry.side}] — ${coverageComplete(entry) ? t.completed : t.coverageStates[entry.status]} · ${entry.characters} ${t.characters}${entry.error ? ` · ${entry.error}` : ''}`),
    '', `## ${t.units}`, '',
    ...run.units.map((unit) => `- **${unit.id}**: ${unit.goal}\n  - ${unit.files.join(', ')}${unit.requirementIds.length ? `\n  - ${unit.requirementIds.join(', ')}` : ''}`),
    '', `## ${t.requirementStatus}`, '',
  ];
  for (const verdict of run.requirements) {
    const rule = [...run.baseline.requirements, ...run.baseline.excluded].find((item) => item.id === verdict.id);
    lines.push(`### ${verdict.id} · ${rule?.title ?? verdict.id}`, '', `**${t[verdict.status]}**`, verdict.rationale, '', rule?.text ?? '');
    if (rule) {
      for (const origin of rule.origins) {
        const source = run.baseline.materials.find((source) => source.sourceId === origin.sourceId);
        lines.push(`\n${source?.path ?? origin.sourceId} · v${origin.version} · L${origin.line}–${origin.endLine}`);
        lines.push('', ...origin.quote.split('\n').map((line) => `    ${line}`), '');
      }
    }
    if (verdict.critical) lines.push(`\n**${t.criticalBlocked}** ${verdict.critical.dependsOn} / ${verdict.critical.impact} / ${verdict.critical.missingEvidence} / ${verdict.critical.question}`);
    lines.push('', `**${t.evidenceLabel}**`, '', ...citationMarkdown(verdict.evidence));
  }
  lines.push('', `## ${t.premiseStatus}`, '');
  for (const premise of run.premises) {
    const question = run.baseline.questions.find((question) => question.id === premise.id);
    lines.push(`- **${premise.id} · ${t[premise.status]}**: ${question?.text ?? premise.id}\n\n${premise.rationale}`);
    if (premise.critical) lines.push(`  - ${premise.critical.dependsOn} / ${premise.critical.impact} / ${premise.critical.question}`);
    lines.push('', ...citationMarkdown(premise.evidence));
  }
  lines.push('', `## ${t.priorCritical}`, '');
  for (const item of run.priorCritical) {
    const verdict = run.priorCriticalVerdicts.find((verdict) => verdict.id === item.id);
    lines.push(`- **${item.title}**: ${verdict ? `${t[verdict.status]} · ${verdict.rationale}` : t.criticalBlocked}`);
    lines.push('', ...item.detail.split('\n').map((line) => `> ${line}`), '', ...citationMarkdown(verdict?.evidence ?? []));
  }
  lines.push('', `## ${t.findings}`, '');
  for (const finding of run.findings) {
    lines.push(`### ${finding.title}`, '', `**${t[finding.kind]} / ${t[finding.status]}** · ${t[finding.severity]} · ${t[finding.attribution]}`, '',
      finding.cause, '', finding.trigger, '', finding.impact, '', `${finding.requirementIds.join(', ')}`,
      '', `**${t.counterRationale}**`, finding.counterRationale, '');
    for (const [title, evidence] of [[t.evidenceLabel, finding.evidence], [t.counterEvidence, finding.counterEvidence]] as const) {
      lines.push(`**${title}**`, '');
      lines.push(...citationMarkdown(evidence));
    }
    if (finding.critical) lines.push(`**${t.criticalBlocked}** ${finding.critical.dependsOn} / ${finding.critical.impact} / ${finding.critical.missingEvidence} / ${finding.critical.question}`, '');
    const note = run.dispositions[finding.id];
    if (note) lines.push(`**${t.comment}**: ${note.reason}`, '');
  }
  return lines.join('\n');
}

export function businessConclusionSummary(run: BusinessReviewRun): string {
  const t = m().businessReview;
  return [
    `## ${t.title}`, '', `head: ${run.scope.headSha}${run.scope.baseSha ? ` / base: ${run.scope.baseSha}` : ''}`,
    '', `**${t[run.status]}**`, run.mode === 'technical' ? t.modeTechnical : t.modeRequirements,
    '', `${t.coverage}: ${run.coverage.filter(coverageComplete).length}/${run.coverage.length}`,
    `${t.requirementStatus}: ${(['supported', 'violated', 'unknown', 'not-applicable'] as const).map((status) => `${t[status]} ${run.requirements.filter((item) => item.status === status).length}`).join(' / ')}`,
    `${t.premiseStatus}: ${run.premises.filter((item) => item.status === 'clarified').length}/${run.premises.length}`,
    ...(run.requirements.some((item) => item.status === 'unknown') || run.premises.some((item) => item.status === 'unknown') ? [t.partialRequirements] : []),
    `${t.findings}: ${(['confirmed', 'unresolved', 'dismissed'] as const).map((status) => `${t[status]} ${run.findings.filter((item) => item.status === status).length}`).join(' / ')}`,
    `${t.priorCritical}: ${run.priorCriticalVerdicts.filter((item) => item.status === 'cleared').length}/${run.priorCritical.length}`,
    fmt(t.errorCount, run.limitations.length, run.errors.length),
    '', ...businessBlockers(run).filter((reason) => reason !== t.humanConfirm).map((reason) => `- ${reason}`),
    '', t.boundary, t.materialSnapshotBoundary, t.summaryLocal,
  ].join('\n');
}

export interface BusinessReviewPanelActions {
  recheck(): void;
  cancel(): void;
  prepare(): void;
  confirm(): void;
  note(id: string): void;
  source(ref: BusinessCitation): void;
  onRendered?(report: { references: number; quotationBlocks: number; error?: string }): void;
}

export class BusinessReviewPanel {
  private static current?: BusinessReviewPanel;
  private run: BusinessReviewRun;
  private actions: BusinessReviewPanelActions;
  private readonly panel: vscode.WebviewPanel;

  private constructor(panel: vscode.WebviewPanel, run: BusinessReviewRun, actions: BusinessReviewPanelActions) {
    this.panel = panel; this.run = run; this.actions = actions;
    panel.onDidDispose(() => { if (BusinessReviewPanel.current === this) BusinessReviewPanel.current = undefined; });
    panel.webview.onDidReceiveMessage((message: { type?: string; runId?: string; id?: string; references?: number; quotationBlocks?: number; error?: string }) => {
      if (message?.runId !== this.run.id) {
        console.warn('[codereview] Stale business report action was ignored.');
        return;
      }
      if (message.type === 'recheck') this.actions.recheck();
      else if (message.type === 'cancel') this.actions.cancel();
      else if (message.type === 'rendered') {
        if (message.error) void vscode.window.showErrorMessage(m().review.error(message.error));
        this.actions.onRendered?.({ references: Number(message.references), quotationBlocks: Number(message.quotationBlocks), error: message.error });
      }
      else if (message.type === 'prepare') this.actions.prepare();
      else if (message.type === 'confirm') this.actions.confirm();
      else if (message.type === 'note' && this.run.findings.some((finding) => finding.id === message.id)) this.actions.note(message.id!);
      else if (message.type === 'source') {
        const ref = businessReportReferences(this.run).find((ref) => businessHash(JSON.stringify(ref)) === message.id);
        if (ref) this.actions.source(ref);
        else void vscode.window.showWarningMessage(m().businessReview.invalidCitation);
      } else void vscode.window.showWarningMessage(m().businessReview.staleReport);
    });
  }

  static show(run: BusinessReviewRun, actions: BusinessReviewPanelActions): void {
    const current = BusinessReviewPanel.current;
    if (current) { current.update(run, actions); current.panel.reveal(DocumentPanel.viewColumn ?? vscode.ViewColumn.Active); return; }
    const panel = vscode.window.createWebviewPanel('codereview.businessReview', m().businessReview.title,
      DocumentPanel.viewColumn ?? vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    const instance = new BusinessReviewPanel(panel, run, actions);
    BusinessReviewPanel.current = instance;
    instance.update(run, actions);
  }

  static refreshIfOpen(run?: BusinessReviewRun): void {
    const current = BusinessReviewPanel.current;
    if (current && run) current.update(run, current.actions);
    else current?.panel.dispose();
  }

  static closeIfOpen(): void { BusinessReviewPanel.current?.panel.dispose(); }

  private update(run: BusinessReviewRun, actions: BusinessReviewPanelActions): void {
    this.run = run; this.actions = actions;
    this.panel.title = m().businessReview.title;
    const t = m().businessReview;
    const token = nonce();
    const refs = businessReportReferences(run);
    this.panel.webview.html = `<!doctype html><html lang="${resolveLanguage()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${token}'">
      <style>body{font:13px/1.9 var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px 24px;margin:0;overflow-wrap:anywhere}main{max-width:1000px;margin:auto}h1{font-size:22px}h2{font-size:17px;border-top:1px solid var(--vscode-panel-border);padding-top:18px}h3{font-size:14px}blockquote{border-left:2px solid var(--vscode-textLink-foreground);margin:10px 0;padding-left:12px;color:var(--vscode-descriptionForeground)}pre{white-space:pre-wrap;padding:10px;background:var(--vscode-textCodeBlock-background);overflow:auto;max-width:100%}code{font-family:var(--vscode-editor-font-family)}button{font:inherit;font-size:11px;border:0;padding:7px 11px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border-radius:3px;cursor:pointer}button:disabled{opacity:.55;cursor:default}.actions{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin:14px 0}.reference{padding:10px;border:1px solid var(--vscode-panel-border);margin:8px 0}.hint{color:var(--vscode-descriptionForeground);font-size:11px}.reference summary{cursor:pointer}button:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}@media(max-width:560px){body{padding:16px 12px}}</style></head><body><main>
      <div class="actions"><button data-action="${run.status === 'running' ? 'cancel' : 'recheck'}">${esc(run.status === 'running' ? t.cancel : t.resume)}</button><button data-action="prepare">${esc(m().requirements.openPreparation)}</button><button data-action="confirm" ${run.confirmed || run.status === 'running' || run.status === 'stale' ? 'disabled' : ''}>${esc(t.confirmReport)}</button></div>
      <p role="status" aria-live="polite">${esc(fmt(t.progress, t[run.phase], run.coverage.filter(coverageComplete).length, run.coverage.length, run.calls))}</p>
      <p class="hint">${esc(t.notTested)} · ${esc(t.noAssumedAttribution)}</p>
      ${renderRequirementMarkdown(businessReportMarkdown(run))}
      <h2>${esc(t.evidenceLabel)}</h2>${refs.map((ref) => `<details class="reference"><summary>${esc(ref.path)} [${ref.side}] · L${ref.line}–${ref.endLine}</summary><pre>${esc(ref.quote)}</pre><button data-action="source" data-id="${businessHash(JSON.stringify(ref))}">${esc(t.original)}</button></details>`).join('')}
      <h2>${esc(t.comment)}</h2>${run.findings.map((finding) => `<div class="actions"><span>${esc(finding.title)}</span><button data-action="note" data-id="${escAttr(finding.id)}" ${run.status === 'running' || run.status === 'stale' ? 'disabled' : ''}>${esc(t.comment)}</button></div>`).join('')}</main>
      <script nonce="${token}">(()=>{const api=acquireVsCodeApi();const id=${JSON.stringify(run.id).replace(/</g, '\\u003c')};try{const state=api.getState();if(state?.id===id)window.scrollTo(0,state.scroll||0);window.addEventListener('scroll',()=>api.setState({id,scroll:window.scrollY}));document.addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(button&&!button.disabled)api.postMessage({type:button.dataset.action,id:button.dataset.id,runId:id});});api.postMessage({type:'rendered',runId:id,references:document.querySelectorAll('.reference').length,quotationBlocks:document.querySelectorAll('main pre').length});}catch(error){api.postMessage({type:'rendered',runId:id,error:String(error)});}})();</script></body></html>`;
  }
}
