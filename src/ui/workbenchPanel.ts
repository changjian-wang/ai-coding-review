import * as vscode from 'vscode';
import type { FindingSeverity } from '../ai/types';

/** A file row in the workbench sidebar. */
export interface WorkbenchFile {
  path: string;
  name: string;
  dir: string;
  seen: number;
  total: number;
  analyzed: boolean;
  ready: boolean;
  fullySeen: boolean;
  unconfirmed: number;
  findings: number;
  change?: 'add' | 'del' | 'role';
  active: boolean;
}

/** A finding shown in the inspector for the selected file. */
export interface WorkbenchFinding {
  id: string;
  line: number;
  severity: FindingSeverity;
  title: string;
  detail: string;
  suggestion?: string;
  confirmed: boolean;
}

/** Serializable snapshot the webview renders. */
export interface WorkbenchState {
  label: string;
  files: WorkbenchFile[];
  selected?: string;
  findings: WorkbenchFinding[];
  coverage: { seen: number; total: number; filesReady: number; filesTotal: number };
  gatePassed: boolean;
  globalDone: boolean;
  hasGlobalReport: boolean;
  modelLabel: string;
  conclusion?: {
    label: string;
    target: 'pr' | 'local';
    prNumber?: number;
    submittedAt: number;
  };
}

/** Actions the workbench can trigger in the extension host. */
export interface WorkbenchActions {
  open(path: string): void;
  analyze(path: string): void;
  confirmFinding(path: string, id: string): void;
  locate(path: string, line: number): void;
  jumpNext(): void;
  globalAnalysis(): void;
  showGlobal(): void;
  submit(): void;
  pickModel(): void;
}

type InboundMessage =
  | { type: 'select'; path: string }
  | { type: 'analyze'; path: string }
  | { type: 'confirm'; path: string; id: string }
  | { type: 'locate'; path: string; line: number }
  | { type: 'jumpNext' }
  | { type: 'global' }
  | { type: 'showGlobal' }
  | { type: 'submit' }
  | { type: 'pickModel' };

/**
 * The Review Workbench: a full webview panel that renders the prototype-style
 * left sidebar (file tree + coverage HUD + gate) and right inspector (findings
 * cards). Source code stays in the real editor opened beside this panel.
 */
export class WorkbenchPanel {
  private static current?: WorkbenchPanel;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly getState: () => WorkbenchState,
    private readonly actions: WorkbenchActions,
  ) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: InboundMessage) => this.handle(msg),
      null,
      this.disposables,
    );
  }

  static show(getState: () => WorkbenchState, actions: WorkbenchActions): WorkbenchPanel {
    if (WorkbenchPanel.current) {
      WorkbenchPanel.current.refresh();
      WorkbenchPanel.current.panel.reveal(vscode.ViewColumn.One);
      return WorkbenchPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'codereview.workbench',
      'Code Review · 工作台',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const instance = new WorkbenchPanel(panel, getState, actions);
    WorkbenchPanel.current = instance;
    instance.refresh();
    return instance;
  }

  static get isOpen(): boolean {
    return !!WorkbenchPanel.current;
  }

  /** Re-renders the panel from current session state, if open. */
  static refreshIfOpen(): void {
    WorkbenchPanel.current?.refresh();
  }

  refresh(): void {
    this.panel.webview.html = this.render(this.getState());
  }

  private handle(msg: InboundMessage): void {
    switch (msg.type) {
      case 'select':
        this.actions.open(msg.path);
        break;
      case 'analyze':
        this.actions.analyze(msg.path);
        break;
      case 'confirm':
        this.actions.confirmFinding(msg.path, msg.id);
        break;
      case 'locate':
        this.actions.locate(msg.path, msg.line);
        break;
      case 'jumpNext':
        this.actions.jumpNext();
        break;
      case 'global':
        this.actions.globalAnalysis();
        break;
      case 'showGlobal':
        this.actions.showGlobal();
        break;
      case 'submit':
        this.actions.submit();
        break;
      case 'pickModel':
        this.actions.pickModel();
        break;
    }
  }

  private render(state: WorkbenchState): string {
    const nonce = String(Math.random()).slice(2);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    const pct = state.coverage.total > 0
      ? Math.round((state.coverage.seen / state.coverage.total) * 100)
      : 0;

    const tree = state.files
      .map((f) => {
        const dotClass = f.fullySeen ? 'done' : f.seen > 0 ? 'partial' : 'none';
        const chg = f.change ? `<span class="chg ${f.change}">${f.change === 'add' ? '+' : f.change === 'del' ? '−' : '~'}</span>` : '';
        const fixFlag = f.unconfirmed > 0
          ? `<span class="fix-flag" title="${f.unconfirmed} 个未确认发现">${f.unconfirmed}</span>`
          : f.analyzed && f.findings === 0
            ? '<span class="ok-flag" title="无发现">✓</span>'
            : '';
        const cov = f.total > 0 ? `${f.seen}/${f.total}` : '—';
        const stateIcon = f.ready ? '✓' : f.analyzed ? '◑' : '○';
        return `
        <div class="tnode ${f.active ? 'active' : ''} ${f.ready ? 'ready' : ''}" data-path="${escAttr(f.path)}">
          <span class="seen-dot ${dotClass}"></span>
          <span class="tstate">${stateIcon}</span>
          <span class="tname" title="${escAttr(f.path)}">${esc(f.name)}</span>
          ${chg}
          ${fixFlag}
          <span class="tcov">${cov}</span>
        </div>`;
      })
      .join('');

    const gateReason: string[] = [];
    if (state.coverage.filesReady < state.coverage.filesTotal) {
      gateReason.push(`${state.coverage.filesTotal - state.coverage.filesReady} 个文件未读完并确认`);
    }
    if (!state.globalDone) {
      gateReason.push('全局结论未确认');
    }
    const gateOk = state.gatePassed;

    const conclusionHtml = state.conclusion
      ? `<div class="conclusion">已提交结论：<b>${esc(state.conclusion.label)}</b>` +
        `<span class="conc-meta">${
          state.conclusion.target === 'pr' && state.conclusion.prNumber
            ? `已写回 PR #${state.conclusion.prNumber} · `
            : '本地记录 · '
        }${esc(formatTime(state.conclusion.submittedAt))}</span></div>`
      : '';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root {
    --purple:#c586c0; --purple-bg:rgba(197,134,192,.16);
    --red:#f14c4c; --red-bg:rgba(241,76,76,.14);
    --green:#4ec9b0; --green-bg:rgba(78,201,176,.14);
    --yellow:#d8c020; --yellow-bg:rgba(216,192,32,.12);
    --blue:#569cd6; --blue-bg:rgba(86,156,214,.16);
    --line:var(--vscode-panel-border);
    --elevated:var(--vscode-editorWidget-background, rgba(127,127,127,.07));
    --dim:var(--vscode-descriptionForeground);
  }
  * { box-sizing:border-box; }
  body { margin:0; font-family:var(--vscode-font-family); color:var(--vscode-foreground); font-size:13px; }
  .workbench { display:flex; flex-direction:column; height:100vh; }

  /* sidebar (now the whole panel) */
  .sidebar { flex:1; display:flex; flex-direction:column; min-height:0;
    background:linear-gradient(180deg, var(--purple-bg), transparent 220px); }
  .sb-head { padding:.7rem .85rem .55rem; border-bottom:1px solid var(--line); }
  .sb-title { font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); }
  .sb-label { font-weight:700; margin-top:.15rem; }
  .tree { flex:1; overflow:auto; padding:.35rem; min-height:0; }
  .tnode { display:flex; align-items:center; gap:.45rem; padding:.32rem .45rem; border-radius:6px; cursor:pointer; }
  .tnode:hover { background:var(--vscode-list-hoverBackground); }
  .tnode.active { background:var(--purple-bg); box-shadow:inset 2px 0 0 var(--purple); }
  .tnode.ready { opacity:.72; }
  .seen-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
  .seen-dot.none { background:transparent; border:1.5px solid var(--vscode-charts-orange, #d89614); }
  .seen-dot.partial { background:var(--yellow); }
  .seen-dot.done { background:var(--green); }
  .tstate { width:14px; text-align:center; color:var(--dim); flex-shrink:0; }
  .tnode.ready .tstate { color:var(--green); }
  .tname { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chg { font-family:var(--vscode-editor-font-family); font-size:.7rem; padding:0 .3rem; border-radius:4px; flex-shrink:0; }
  .chg.add { background:var(--green-bg); color:var(--green); }
  .chg.del { background:var(--red-bg); color:var(--red); }
  .chg.role { background:var(--blue-bg); color:var(--blue); }
  .fix-flag { font-size:.66rem; min-width:15px; height:15px; padding:0 4px; border-radius:8px; background:var(--red); color:#fff; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; }
  .ok-flag { color:var(--green); flex-shrink:0; }
  .tcov { font-family:var(--vscode-editor-font-family); font-size:.68rem; color:var(--dim); flex-shrink:0; }

  /* coverage HUD + gate (sidebar footer) */
  .hud { padding:.7rem .85rem; border-top:1px solid var(--line); background:var(--elevated); }
  .hud-row { display:flex; align-items:center; gap:.5rem; margin-bottom:.5rem; }
  .hud-row .lbl { font-size:.72rem; color:var(--dim); }
  .hud-row .val { margin-left:auto; font-weight:700; }
  .cov-track { height:8px; border-radius:5px; background:var(--vscode-progressBar-background, rgba(127,127,127,.25)); overflow:hidden; }
  .cov-fill { height:100%; border-radius:5px; background:linear-gradient(90deg, var(--green), var(--blue)); transition:width .3s; }
  .gate-chip { margin-top:.6rem; display:flex; align-items:center; gap:.5rem; padding:.45rem .6rem; border-radius:7px; font-size:.78rem; }
  .gate-chip.locked { background:var(--yellow-bg); border:1px solid rgba(216,192,32,.35); color:var(--yellow); }
  .gate-chip.ok { background:var(--green-bg); border:1px solid rgba(78,201,176,.4); color:var(--green); }
  .gate-reason { font-size:.7rem; color:var(--dim); margin-top:.4rem; line-height:1.5; }
  .conclusion { margin-top:.6rem; padding:.5rem .6rem; border-radius:7px; font-size:.76rem; background:var(--green-bg); border:1px solid rgba(78,201,176,.4); color:var(--green); }
  .conclusion .conc-meta { display:block; margin-top:.25rem; font-size:.68rem; color:var(--dim); }

  /* sidebar action toolbar */
  .toolbar { display:flex; flex-direction:column; gap:.4rem; padding:.55rem .7rem; border-top:1px solid var(--line); background:var(--elevated); }
  .toolbar .grp-label { font-size:.64rem; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin:.2rem 0 -.05rem; }
  .toolbar .row { display:flex; gap:.4rem; }
  .toolbar .row button { flex:1; }
  .model-row { display:flex; align-items:center; gap:.4rem; margin-top:.3rem; padding-top:.5rem; border-top:1px dashed var(--line); }
  .model-label { flex:1; font-size:.74rem; color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .model-label b { color:var(--blue); font-weight:600; }
  .model-row button { flex:none; }
  button { font-family:inherit; font-size:.78rem; cursor:pointer; border:1px solid var(--line); border-radius:5px; padding:.34rem .5rem; background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); white-space:nowrap; }
  button:hover { background:var(--vscode-toolbar-hoverBackground); }
  button.primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border-color:transparent; }
  button:disabled { opacity:.5; cursor:default; }
  .empty { color:var(--dim); text-align:center; margin-top:18vh; line-height:1.8; }
  .confirmed-tag { color:var(--green); font-size:.76rem; }
</style>
</head>
<body>
  <div class="workbench">
    <div class="sidebar">
      <div class="sb-head">
        <div class="sb-title">审查范围</div>
        <div class="sb-label">${esc(state.label)}</div>
      </div>
      <div class="tree">${tree || '<div class="empty">无文件</div>'}</div>
      <div class="toolbar">
        <div class="grp-label">当前文件</div>
        <div class="row">
          <button class="primary" id="analyze" ${state.selected ? '' : 'disabled'}>分析此文件</button>
          <button id="jumpNext" ${state.selected ? '' : 'disabled'}>跳到下一处未看</button>
        </div>
        <div class="grp-label">整体审查</div>
        <div class="row">
          <button id="global">全局逻辑分析</button>
          <button id="showGlobal" ${state.hasGlobalReport ? '' : 'disabled'}>查看全局结论</button>
        </div>
        <div class="model-row">
          <span class="model-label" title="${escAttr(state.modelLabel)}">模型：<b>${esc(state.modelLabel)}</b></span>
          <button id="pickModel">切换</button>
        </div>
      </div>
      <div class="hud">
        <div class="hud-row"><span class="lbl">行覆盖</span><span class="val">${pct}%</span></div>
        <div class="cov-track"><div class="cov-fill" style="width:${pct}%"></div></div>
        <div class="hud-row" style="margin-top:.55rem; margin-bottom:0;">
          <span class="lbl">文件就绪</span><span class="val">${state.coverage.filesReady}/${state.coverage.filesTotal}</span>
        </div>
        <div class="gate-chip ${gateOk ? 'ok' : 'locked'}">
          <span>${gateOk ? '✓' : '🔒'}</span>
          <span>${gateOk ? '门禁已通过，可提交结论' : '门禁未通过'}</span>
        </div>
        ${gateOk ? '' : `<div class="gate-reason">${gateReason.map(esc).join('；')}</div>`}
        <button class="primary" id="submit" style="width:100%; margin-top:.6rem;" ${gateOk ? '' : 'disabled'}>提交审查结论</button>
        ${conclusionHtml}
      </div>
    </div>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const send = (m) => vscode.postMessage(m);
  document.querySelectorAll('.tnode').forEach((n) => {
    n.addEventListener('click', () => send({ type:'select', path:n.dataset.path }));
  });
  const sel = ${JSON.stringify(state.selected ?? null)};
  const byId = (id) => document.getElementById(id);
  byId('analyze')?.addEventListener('click', () => sel && send({ type:'analyze', path:sel }));
  byId('jumpNext')?.addEventListener('click', () => send({ type:'jumpNext' }));
  byId('global')?.addEventListener('click', () => send({ type:'global' }));
  byId('showGlobal')?.addEventListener('click', () => send({ type:'showGlobal' }));
  byId('pickModel')?.addEventListener('click', () => send({ type:'pickModel' }));
  byId('submit')?.addEventListener('click', () => send({ type:'submit' }));
  document.querySelectorAll('.locate').forEach((b) => {
    b.addEventListener('click', () => send({ type:'locate', path:b.dataset.path, line:Number(b.dataset.line) }));
  });
  document.querySelectorAll('.confirm-btn').forEach((b) => {
    b.addEventListener('click', () => send({ type:'confirm', path:b.dataset.path, id:b.dataset.id }));
  });
</script>
</body>
</html>`;
  }

  dispose(): void {
    WorkbenchPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
