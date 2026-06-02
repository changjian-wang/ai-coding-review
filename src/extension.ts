import * as vscode from 'vscode';
import { ReviewSession } from './review/reviewSession';
import { WorkspaceStateReviewStore, type Annotation } from './review/reviewStore';
import { pickModel } from './ai/modelPicker';
import { ModelProvider } from './ai/modelProvider';
import {
  analyzeFile,
  analyzeGlobal,
  generateFixDiff,
  translateToChinese,
  explainCode,
  AnalysisError,
  type GlobalContextFile,
} from './ai/analyzer';
import { pickScope } from './scope/scopePicker';
import { submitPrReview } from './gh/ghClient';
import { GlobalReportPanel } from './ui/globalReportPanel';
import { runWithProgress } from './ui/progressSteps';
import { WorkbenchPanel, type WorkbenchState, type WorkbenchFile } from './ui/workbenchPanel';
import { DocumentPanel, type DocModel } from './ui/documentPanel';
import { renderDocument, type DocumentRender } from './ui/documentRenderer';

let session: ReviewSession;
const models = new ModelProvider();
let workbenchSelected: string | undefined;
/** Cache of rendered (highlighted) file content, keyed by relative path. */
const docRenderCache = new Map<string, DocumentRender>();

export function activate(context: vscode.ExtensionContext): void {
  const repo = workspaceFolderName() ?? 'unknown';
  const store = new WorkspaceStateReviewStore(context.workspaceState);
  session = new ReviewSession(store, repo);

  context.subscriptions.push(
    session,
    vscode.window.registerTreeDataProvider('codereview.home', new EmptyHomeProvider()),
    vscode.commands.registerCommand('codereview.startReview', startReview),
    vscode.commands.registerCommand('codereview.pickModel', selectModel),
    vscode.commands.registerCommand('codereview.openWorkbench', openWorkbench),
    vscode.commands.registerCommand('codereview.openFile', openFileInPanel),
    vscode.commands.registerCommand('codereview.analyzeFile', analyzeCurrentFile),
    vscode.commands.registerCommand('codereview.globalAnalysis', runGlobalAnalysis),
    vscode.commands.registerCommand('codereview.showGlobalReport', showGlobalReport),
    vscode.commands.registerCommand('codereview.submitConclusion', submitConclusion),
    vscode.commands.registerCommand('codereview.locateFinding', locateInFile),
    vscode.commands.registerCommand('codereview.jumpToNextUnseen', jumpToNextUnseenCurrent),
  );

  // Keep the workbench webview in sync with session progress.
  context.subscriptions.push(session.onDidChange(() => WorkbenchPanel.refreshIfOpen()));
}

/** Empty provider for the launcher view so its welcome buttons show. */
class EmptyHomeProvider implements vscode.TreeDataProvider<never> {
  getTreeItem(): vscode.TreeItem {
    return new vscode.TreeItem('');
  }
  getChildren(): never[] {
    return [];
  }
}

async function startReview(): Promise<void> {
  const cwd = workspaceFolderPath();
  if (!cwd) {
    void vscode.window.showErrorMessage('Code Review：请先打开一个 Git 仓库工作区。');
    return;
  }

  const source = await pickScope(cwd);
  if (!source) {
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Code Review：加载源码…' },
    async () => {
      try {
        const reviewSet = await source.load(cwd);
        await session.start(reviewSet);
        workbenchSelected = undefined;
        docRenderCache.clear();
        void vscode.commands.executeCommand('setContext', 'codereview.active', true);
        openWorkbench();
        void vscode.window.showInformationMessage(
          `Code Review：${reviewSet.label} · ${reviewSet.files.length} 个文件`,
        );
      } catch (err) {
        const message = String((err as Error)?.message ?? err);
        void vscode.window.showErrorMessage(`Code Review：${message}`);
      }
    },
  );
}

async function selectModel(): Promise<void> {
  const choice = await pickModel();
  if (choice) {
    models.set(choice);
    WorkbenchPanel.refreshIfOpen();
    void vscode.window.showInformationMessage(`Code Review 分析模型：${choice.label}`);
  }
}

/** Opens (or reveals) the Review Workbench webview. */
function openWorkbench(): void {
  if (!session.reviewSet) {
    void vscode.window.showInformationMessage('Code Review：请先开始一次审查（选择范围）。');
    return;
  }
  WorkbenchPanel.show(buildWorkbenchState, {
    open: (path) => void openFileInPanel(path),
    analyze: (path) => void analyzeByPath(path),
    confirmFinding: (path, id) => session.toggleFindingConfirmed(path, id),
    locate: (path, line) => void locateInFile(path, line),
    jumpNext: jumpToNextUnseenCurrent,
    globalAnalysis: () => void runGlobalAnalysis(),
    showGlobal: showGlobalReport,
    submit: () => void submitConclusion(),
    pickModel: () => void selectModel(),
  });
}

/** Maps a ReviewFile's diff status to a workbench change badge. */
function changeBadge(status?: string, additions?: number, deletions?: number): WorkbenchFile['change'] {
  if (status === 'added') {
    return 'add';
  }
  if (status === 'deleted') {
    return 'del';
  }
  if (status === 'modified' || status === 'renamed') {
    return 'role';
  }
  if (additions && !deletions) {
    return 'add';
  }
  if (deletions && !additions) {
    return 'del';
  }
  if (additions || deletions) {
    return 'role';
  }
  return undefined;
}

/** Snapshots the current session into the serializable workbench state. */
function buildWorkbenchState(): WorkbenchState {
  const reviewSet = session.reviewSet;
  const files: WorkbenchFile[] = (reviewSet?.files ?? []).map((f) => {
    const { seen, total } = session.coverage(f.path);
    const findings = session.findings(f.path);
    const fileState = session.fileState(f.path);
    return {
      path: f.path,
      name: f.path.split('/').pop() ?? f.path,
      dir: f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '',
      seen,
      total,
      analyzed: !!fileState?.analyzed,
      ready: session.fileReady(f.path),
      fullySeen: session.fileFullySeen(f.path),
      unconfirmed: session.unconfirmedCount(f.path),
      findings: findings.length,
      change: changeBadge(f.status, f.additions, f.deletions),
      active: workbenchSelected === f.path,
    };
  });

  const selectedFindings = workbenchSelected
    ? session.findings(workbenchSelected).map((f) => ({
        id: f.id,
        line: f.line,
        severity: f.severity,
        title: f.title,
        detail: f.detail,
        suggestion: f.suggestion,
        confirmed: session.isFindingConfirmed(workbenchSelected!, f.id),
      }))
    : [];

  return {
    label: reviewSet?.label ?? '（未开始）',
    files,
    selected: workbenchSelected,
    findings: selectedFindings,
    coverage: session.totalCoverage(),
    gatePassed: session.gatePassed(),
    globalDone: session.globalConfirmed,
    hasGlobalReport: !!session.globalReport,
    modelLabel: models.label,
    conclusion: session.conclusion
      ? {
          label: session.conclusion.label,
          target: session.conclusion.target,
          prNumber: session.conclusion.prNumber,
          submittedAt: session.conclusion.submittedAt,
        }
      : undefined,
  };
}

/** Opens a review file in the document webview beside the workbench. */
async function openFileInPanel(relPath: string): Promise<void> {
  workbenchSelected = relPath;
  const text = await readReviewFileText(relPath);
  const render = renderFor(relPath, text);
  session.setTotalLines(relPath, render.totalLines);
  DocumentPanel.show(buildDocModel(relPath, render), docActions());
  WorkbenchPanel.refreshIfOpen();
}

/** Renders (and caches) the highlighted/markdown content for a file. */
function renderFor(relPath: string, text: string): DocumentRender {
  const cached = docRenderCache.get(relPath);
  if (cached) {
    return cached;
  }
  const languageId = languageIdFor(relPath);
  const render = renderDocument(text, languageId, relPath.split('/').pop() ?? relPath);
  docRenderCache.set(relPath, render);
  return render;
}

/** Guesses a VS Code-style languageId from a file extension. */
function languageIdFor(relPath: string): string {
  const ext = relPath.includes('.') ? relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase() : '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
    cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'cpp', py: 'python', java: 'java',
    go: 'go', rs: 'rust', rb: 'ruby', php: 'php', sh: 'shellscript', ps1: 'powershell',
    sql: 'sql', json: 'json', jsonc: 'jsonc', yml: 'yaml', yaml: 'yaml', xml: 'xml',
    html: 'html', vue: 'vue', css: 'css', scss: 'scss', less: 'less', md: 'markdown',
    markdown: 'markdown', ini: 'ini', toml: 'toml',
  };
  return map[ext] ?? ext;
}

/** Builds the serializable model the document webview renders. */
function buildDocModel(relPath: string, render: DocumentRender): DocModel {
  const state = session.fileState(relPath);
  return {
    path: relPath,
    name: relPath.split('/').pop() ?? relPath,
    isMarkdown: render.isMarkdown,
    readingHtml: render.readingHtml,
    sourceLines: render.sourceLines,
    raw: deHighlight(render.sourceLines),
    seen: state?.seenLines ?? [],
    findings: session.findings(relPath).map((f) => ({
      id: f.id,
      line: f.line,
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      suggestion: f.suggestion,
      confirmed: session.isFindingConfirmed(relPath, f.id),
    })),
    annotations: session.annotations(relPath).map((a) => ({
      id: a.id,
      kind: a.kind,
      startLine: a.startLine,
      endLine: a.endLine,
      sourceText: a.sourceText,
      content: a.content,
    })),
  };
}

/** Recovers raw source lines by stripping highlight markup. */
function deHighlight(lines: string[]): string[] {
  return lines.map((l) =>
    l
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&'),
  );
}

/** Pushes an updated model into the document panel if it shows this file. */
function refreshDocPanel(relPath: string): void {
  const render = docRenderCache.get(relPath);
  if (render && DocumentPanel.currentPath === relPath) {
    DocumentPanel.update(buildDocModel(relPath, render));
  }
}

/** Wires the document webview's actions back to the session / model. */
function docActions() {
  return {
    seen: (path: string, lines: number[]) => session.markSeen(path, lines),
    translate: (path: string, startLine: number, endLine: number, text: string) =>
      void annotateWithTranslation(path, startLine, endLine, text),
    explain: (path: string, startLine: number, endLine: number, text: string) =>
      void annotateWithExplanation(path, startLine, endLine, text),
    note: (path: string, startLine: number, endLine: number, text: string) =>
      void annotateWithNote(path, startLine, endLine, text),
    removeAnnotation: (path: string, id: string) => {
      session.removeAnnotation(path, id);
      refreshDocPanel(path);
    },
    confirmFinding: (path: string, id: string) => {
      session.toggleFindingConfirmed(path, id);
      refreshDocPanel(path);
    },
    locate: (path: string, line: number) => void locateInFile(path, line),
    analyze: (path: string) => void analyzeByPath(path),
    jumpNext: (path: string) => jumpToNextUnseen(path),
  };
}

function newAnnotationId(): string {
  return `anno-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Translates the selected text and stores it as a persisted annotation. */
async function annotateWithTranslation(
  path: string,
  startLine: number,
  endLine: number,
  text: string,
): Promise<void> {
  const model = await models.resolve();
  if (!model) {
    void vscode.window.showErrorMessage('Code Review：未找到可用的 Copilot 模型。');
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Code Review：翻译中…', cancellable: true },
    async (_p, token) => {
      try {
        const content = await translateToChinese(model, text, token);
        const annotation: Annotation = {
          id: newAnnotationId(),
          kind: 'translate',
          startLine,
          endLine,
          sourceText: text,
          content,
          createdAt: Date.now(),
        };
        session.addAnnotation(path, annotation);
        refreshDocPanel(path);
      } catch (err) {
        reportError(err);
      }
    },
  );
}

/** Explains the selected code and stores it as a persisted annotation. */
async function annotateWithExplanation(
  path: string,
  startLine: number,
  endLine: number,
  text: string,
): Promise<void> {
  const model = await models.resolve();
  if (!model) {
    void vscode.window.showErrorMessage('Code Review：未找到可用的 Copilot 模型。');
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Code Review：解释中…', cancellable: true },
    async (_p, token) => {
      try {
        const content = await explainCode(model, text, token);
        const annotation: Annotation = {
          id: newAnnotationId(),
          kind: 'explain',
          startLine,
          endLine,
          sourceText: text,
          content,
          createdAt: Date.now(),
        };
        session.addAnnotation(path, annotation);
        refreshDocPanel(path);
      } catch (err) {
        reportError(err);
      }
    },
  );
}

/** Prompts for note text and stores it as a persisted annotation. */
async function annotateWithNote(
  path: string,
  startLine: number,
  endLine: number,
  text: string,
): Promise<void> {
  const note = await vscode.window.showInputBox({
    title: 'Code Review · 添加批注',
    prompt: startLine > 0 ? `第 ${startLine}${endLine > startLine ? `–${endLine}` : ''} 行` : '选区批注',
    placeHolder: '输入批注内容…',
  });
  if (!note) {
    return;
  }
  const annotation: Annotation = {
    id: newAnnotationId(),
    kind: 'note',
    startLine,
    endLine,
    sourceText: text,
    content: note,
    createdAt: Date.now(),
  };
  session.addAnnotation(path, annotation);
  refreshDocPanel(path);
}

/**
 * Reads the current text of a review file, preferring an already-open document
 * (which includes unsaved edits) over the on-disk copy.
 */
async function readReviewFileText(relPath: string): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return '';
  }
  const uri = vscode.Uri.joinPath(folder.uri, relPath);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (open) {
    return open.getText();
  }
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    return doc.getText();
  } catch {
    return '';
  }
}

async function analyzeCurrentFile(): Promise<void> {
  const rel = DocumentPanel.currentPath ?? workbenchSelected;
  if (!rel) {
    void vscode.window.showWarningMessage('Code Review：请先在工作台中选择要分析的文件。');
    return;
  }
  await analyzeByPath(rel);
}

/** Analyzes a specific review file by its relative path. */
async function analyzeByPath(rel: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }
  const model = await models.resolve();
  if (!model) {
    void vscode.window.showErrorMessage('Code Review：未找到可用的 Copilot 模型。');
    return;
  }

  let document: vscode.TextDocument;
  try {
    const uri = vscode.Uri.joinPath(folder.uri, rel);
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    void vscode.window.showWarningMessage(`Code Review：无法打开 ${rel}`);
    return;
  }

  const fileName = rel.split('/').pop() ?? rel;
  await runWithProgress(`Code Review：分析 ${rel}`, async (token, report) => {
    try {
      report(`调用模型分析 ${fileName}…`);
      const findings = await analyzeFile(model, document, token);
      report('写入发现…');
      session.setFindings(rel, findings);
      refreshDocPanel(rel);
      void vscode.window.showInformationMessage(
        findings.length
          ? `Code Review：${rel} 发现 ${findings.length} 个问题。`
          : `Code Review：${rel} 未发现问题。`,
      );
    } catch (err) {
      reportError(err);
    }
  });
}

async function runGlobalAnalysis(): Promise<void> {
  const reviewSet = session.reviewSet;
  if (!reviewSet) {
    void vscode.window.showWarningMessage('Code Review：尚未开始审查。');
    return;
  }
  const unready = reviewSet.files.filter((f) => !session.fileFullySeen(f.path));
  if (unready.length) {
    const pick = await vscode.window.showWarningMessage(
      `还有 ${unready.length} 个文件未读完，仍要进行全局分析吗？`,
      '继续',
      '取消',
    );
    if (pick !== '继续') {
      return;
    }
  }
  const model = await models.resolve();
  if (!model) {
    void vscode.window.showErrorMessage('Code Review：未找到可用的 Copilot 模型。');
    return;
  }

  await runWithProgress('Code Review：全局逻辑分析', async (token, report) => {
    try {
      const context: GlobalContextFile[] = [];
      for (const f of reviewSet.files) {
        report(`读取 ${f.path}…`);
        context.push({
          path: f.path,
          findings: session.findings(f.path),
          content: await readReviewFileText(f.path),
        });
      }
      report('调用模型进行跨文件分析…');
      const globalReport = await analyzeGlobal(model, context, token);
      session.setGlobalReport(globalReport);
      showGlobalReport();
    } catch (err) {
      reportError(err);
    }
  });
}

function showGlobalReport(): void {
  const report = session.globalReport;
  if (!report) {
    void vscode.window.showInformationMessage('Code Review：尚无全局结论，请先运行全局分析。');
    return;
  }
  const cov = session.totalCoverage();
  const reviewSet = session.reviewSet;
  const findingsCount = reviewSet
    ? reviewSet.files.reduce((sum, f) => sum + session.findings(f.path).length, 0)
    : 0;
  GlobalReportPanel.show(
    report,
    session.globalConfirmed,
    locateInFile,
    () => session.confirmGlobal(),
    generateCandidateDiff,
    {
      seen: cov.seen,
      total: cov.total,
      filesReady: cov.filesReady,
      filesTotal: cov.filesTotal,
      findings: findingsCount,
    },
    () => void vscode.commands.executeCommand('codereview.openWorkbench'),
  );
}

/** Generates a candidate unified diff for a fix spot and opens it in an editor. */
async function generateCandidateDiff(fix: {
  file: string;
  line: number;
  title: string;
  detail: string;
  suggestion?: string;
}): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }
  const model = await models.resolve();
  if (!model) {
    void vscode.window.showErrorMessage('Code Review：未找到可用的 Copilot 模型。');
    return;
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Code Review：生成 ${fix.file} 候选 diff…`,
      cancellable: true,
    },
    async (_p, token) => {
      try {
        const content = await readReviewFileText(fix.file);
        const diff = await generateFixDiff(model, fix.file, content, fix, token);
        const diffDoc = await vscode.workspace.openTextDocument({
          language: 'diff',
          content: diff || '（模型未返回 diff）',
        });
        await vscode.window.showTextDocument(diffDoc, { preview: true, viewColumn: vscode.ViewColumn.Active });
      } catch (err) {
        reportError(err);
      }
    },
  );
}

async function locateInFile(relPath: string, line: number): Promise<void> {
  if (DocumentPanel.currentPath !== relPath) {
    await openFileInPanel(relPath);
  }
  DocumentPanel.scrollTo(line);
}

/** Computes the next not-yet-seen line in a file and scrolls the panel to it. */
function jumpToNextUnseen(relPath: string): void {
  const state = session.fileState(relPath);
  if (!state) {
    return;
  }
  const total = state.totalLines;
  if (total <= 0) {
    void vscode.window.showInformationMessage('Code Review：文件尚未加载完成。');
    return;
  }
  const seen = new Set(state.seenLines);
  let target = -1;
  for (let l = 1; l <= total; l++) {
    if (!seen.has(l)) {
      target = l;
      break;
    }
  }
  if (target < 0) {
    void vscode.window.showInformationMessage('Code Review：本文件已全部通读。');
    return;
  }
  DocumentPanel.scrollTo(target);
}

/** Jumps to the next unseen line in the file currently shown in the panel. */
function jumpToNextUnseenCurrent(): void {
  const rel = DocumentPanel.currentPath ?? workbenchSelected;
  if (!rel) {
    void vscode.window.showInformationMessage('Code Review：请先在工作台中选择一个文件。');
    return;
  }
  jumpToNextUnseen(rel);
}

async function submitConclusion(): Promise<void> {
  if (!session.reviewSet) {
    void vscode.window.showWarningMessage('Code Review：尚未开始审查。');
    return;
  }
  if (!session.gatePassed()) {
    const c = session.totalCoverage();
    const reasons: string[] = [];
    if (c.filesReady < c.filesTotal) {
      reasons.push(`还有 ${c.filesTotal - c.filesReady} 个文件未读完并分析`);
    }
    if (!session.globalConfirmed) {
      reasons.push('尚未确认全局结论');
    }
    void vscode.window.showWarningMessage(`Code Review 门禁未通过：${reasons.join('；')}。`);
    return;
  }

  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(check) 通过（Approve）', value: 'approve' as const },
      { label: '$(request-changes) 要求修改（Request Changes）', value: 'changes' as const },
      { label: '$(comment) 仅评论（Comment）', value: 'comment' as const },
    ],
    { title: 'Code Review · 提交结论', placeHolder: '选择本次审查的结论' },
  );
  if (!choice) {
    return;
  }

  const cleanLabel = choice.label.replace(/\$\([^)]+\)\s*/, '');
  const conclusionVerdict =
    choice.value === 'approve' ? 'approve' : choice.value === 'changes' ? 'request-changes' : 'comment';
  const prMatch = session.reviewSet.scopeId.match(/^pr-(\d+)$/);
  if (prMatch) {
    const prNumber = Number(prMatch[1]);
    const confirm = await vscode.window.showWarningMessage(
      `将把审查结论写回 PR #${prNumber}：${cleanLabel}。确认提交？`,
      { modal: true },
      '提交到 GitHub',
    );
    if (confirm !== '提交到 GitHub') {
      return;
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
      return;
    }
    const c = session.totalCoverage();
    const body = `Reviewed via Code Review Gate — ${c.filesReady}/${c.filesTotal} 文件已逐行通读并确认，全局结论已核对。`;
    try {
      await submitPrReview(cwd, prNumber, conclusionVerdict, body);
      session.setConclusion({
        verdict: conclusionVerdict,
        label: cleanLabel,
        target: 'pr',
        prNumber,
        submittedAt: Date.now(),
      });
      void vscode.window.showInformationMessage(`Code Review：已写回 PR #${prNumber}（${cleanLabel}）。`);
    } catch (err) {
      reportError(err);
    }
    return;
  }

  session.setConclusion({
    verdict: conclusionVerdict,
    label: cleanLabel,
    target: 'local',
    submittedAt: Date.now(),
  });
  void vscode.window.showInformationMessage(`Code Review 结论已记录：${cleanLabel}`);
}

function reportError(err: unknown): void {
  const message =
    err instanceof AnalysisError ? err.message : String((err as Error)?.message ?? err);
  void vscode.window.showErrorMessage(`Code Review：${message}`);
}

function workspaceFolderPath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function workspaceFolderName(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.name;
}

export function deactivate(): void {
  // nothing to clean up beyond context.subscriptions
}
