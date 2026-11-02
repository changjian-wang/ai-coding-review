import * as vscode from 'vscode';
import type {
  GlobalReport,
} from '../ai/types';
import { esc, nonce as makeNonce } from './html';
import { m, resolveLanguage } from '../i18n';
import { DocumentPanel } from './documentPanel';
import { renderRequirementMarkdown } from './requirementMarkdown';



/**
 * Callbacks + state the panel needs, bundled into one object so the call site
 * isn't a long positional argument list (and so adding a handler doesn't shift
 * every other argument).
 */
export interface GlobalReportHandlers {
  onGotoFiles(): void;
}

/** Read-only archive; historical reports never control the current review gate. */
export class GlobalReportPanel {
  private static current?: GlobalReportPanel;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private handlers: GlobalReportHandlers;
  private lastReport?: GlobalReport;

  private constructor(panel: vscode.WebviewPanel, handlers: GlobalReportHandlers) {
    this.panel = panel;
    this.handlers = handlers;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: unknown) => {
        if (!msg || typeof msg !== 'object' || !('type' in msg) || msg.type !== 'gotoFiles') {
          void vscode.window.showWarningMessage(m().reviewCenter.legacyReportBoundary);
          return;
        }
        this.handlers.onGotoFiles();
      },
      null,
      this.disposables,
    );
  }

  /** Creates or reveals the panel and renders the report. */
  static show(
    report: GlobalReport,
    handlers: GlobalReportHandlers,
  ): GlobalReportPanel {
    // Open as a TAB in the SAME group as the code (document) view, so the report
    // and the file are tabs you switch between — not a split that has to be
    // resized. Falls back to the active column when no document is open.
    const column = DocumentPanel.viewColumn ?? vscode.ViewColumn.Active;
    if (GlobalReportPanel.current) {
      const existing = GlobalReportPanel.current;
      existing.handlers = handlers;
      existing.panel.reveal(column);
      existing.update(report);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      'codereview.globalReport',
      m().reviewCenter.legacyReportTitle,
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const instance = new GlobalReportPanel(panel, handlers);
    GlobalReportPanel.current = instance;
    instance.update(report);
    return instance;
  }

  static closeIfOpen(): void {
    GlobalReportPanel.current?.panel.dispose();
  }

  static get isOpen(): boolean { return !!GlobalReportPanel.current; }

  /** Re-renders the open report in the current language (after a language switch). */
  static refreshIfOpen(): void {
    const c = GlobalReportPanel.current;
    if (c && c.lastReport) {
      c.update(c.lastReport);
    }
  }

  private update(report: GlobalReport): void {
    this.lastReport = report;
    this.panel.webview.html = this.renderLegacyReport(report);
  }


  private renderLegacyReport(report: GlobalReport): string {
    const token = makeNonce(), t = m().reviewCenter, g = m().globalPanel;
    const markdown = [
      `## ${t.legacyRecommendation}: ${m().recommendation[report.recommendation]}`, report.conclusion,
      `## ${g.sectionReview}`,
      ...report.verdicts.flatMap((verdict) => [
        `### ${verdict.title}`, `${g.fileLevelSays}: ${verdict.before}`, `${g.globalResolves}: ${verdict.after}`,
        verdict.evidence ?? '', verdict.file ? `${verdict.file}:${verdict.line ?? 1}` : '',
      ]),
      `## ${g.sectionFixAdvisory}`,
      ...report.fixSpots.flatMap((spot) => [`### ${spot.title}`, `${spot.file}:${spot.line}`, spot.detail, spot.suggestion ?? '']),
      `## ${g.basisEvidenceTitle}`, ...report.evidence,
    ].join('\n\n');
    return `<!doctype html><html lang="${resolveLanguage()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${token}'">
      <style>body{margin:0;padding:24px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:13px/1.9 var(--vscode-font-family)}main{max-width:980px;margin:auto;overflow-wrap:anywhere}h1{font-size:21px}h2{font-size:16px;margin-top:24px}h3{font-size:13px}.boundary{padding:10px 12px;border-left:2px solid var(--vscode-editorWarning-foreground);color:var(--vscode-descriptionForeground)}button{padding:7px 12px;border:0;border-radius:4px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}pre{overflow:auto;white-space:pre-wrap}table{display:block;max-width:100%;overflow:auto}</style>
      </head><body><main><h1>${esc(t.legacyReportTitle)}</h1><p class="boundary">${esc(t.legacyReportBoundary)}</p><button id="return-center">${esc(t.returnCenter)}</button>${renderRequirementMarkdown(markdown)}</main>
      <script nonce="${token}">const api=acquireVsCodeApi();document.getElementById('return-center').addEventListener('click',()=>api.postMessage({type:'gotoFiles'}));</script></body></html>`;
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (GlobalReportPanel.current === this) {
      GlobalReportPanel.current = undefined;
    }
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
  }
}
