import type { Finding } from '../ai/types';
import type { ReviewStage, ReviewVerdict, ReviewWorkflowState } from '../review/reviewWorkflow';
import { m, resolveLanguage } from '../i18n';
import type { DocModel, SourceRenderPlan } from './documentPanel';
import type { WorkbenchFile, WorkbenchState } from './workbenchPanel';
import { nonce, scriptJson } from './html';
export { scriptJson } from './html';
import { composeReviewReport } from './reviewReport';
import { reviewCenterClient } from './reviewCenterClient';

export interface CenterFinding extends Finding {
  current: boolean;
  path: string;
  ref: string;
  disposition?: 'fixed' | 'commented' | 'ignored';
  dispositionReason?: string;
  global?: boolean;
  applied?: boolean;
}

export interface CenterDocument extends DocModel {
  renderPlan: SourceRenderPlan;
  annotationHtml: Record<string, string>;
  evidenceOnly?: boolean;
  deleted?: boolean;
}

export interface ReviewCenterMeta {
  version: number;
  headSha: string;
  baseSha?: string;
  prNumber?: number;
  workflow: ReviewWorkflowState;
  findings: CenterFinding[];
  requirementHtml: Record<string, string>;
  reportBase: string;
  commentPreview: string;
  blockers: Record<ReviewVerdict, string[]>;
  current: boolean;
  requirementsConfirmed: boolean;
  busy?: boolean;
  submitting?: boolean;
  loadingScope?: boolean;
  progress?: string;
}

export interface ReviewCenterState extends ReviewCenterMeta {
  document?: CenterDocument;
}

export interface ReviewCenterUpdate {
  type: 'center-state';
  state: Omit<WorkbenchState, 'center' | 'files'>;
  files?: WorkbenchFile[];
  fileUpdates?: WorkbenchFile[];
  center?: ReviewCenterMeta;
  document?: CenterDocument | null;
  documentPatch?: Pick<CenterDocument, 'path' | 'revision' | 'findings' | 'annotations' | 'annotationHtml' | 'seen' | 'analyzing'> & {
    translationHtml: string | null;
    evidenceOnly: boolean;
    deleted: boolean;
    defaultToDiff: boolean;
  };
}

export type ReviewCenterOutgoing = { scopeKey: string } & (
  | { type: 'center-source'; id: string; version: number; title: string; html: string; text: string }
  | { type: 'center-copy-fallback'; text: string }
  | { type: 'center-reveal'; path: string; revision: string; line: number });

export type ReviewCenterMessage = { scopeKey: string; runId: string } & (
  | { type: 'center'; action: 'ready'; editing: string }
  | { type: 'center'; action: 'add-file' | 'understand' | 'cancel' }
  | { type: 'center'; action: 'stage'; stage: ReviewStage }
  | { type: 'center'; action: 'editing'; id: string }
  | { type: 'center'; action: 'seen'; path: string; revision: string; lines: number[] }
  | { type: 'center'; action: 'text'; label: string; text: string; human: boolean }
  | { type: 'center'; action: 'link'; url: string }
  | { type: 'center'; action: 'remove-source'; id: string }
  | { type: 'center'; action: 'read-source'; id: string; version: number }
  | { type: 'center'; action: 'revise'; id: string; title: string; text: string; revision: number }
  | { type: 'center'; action: 'include'; id: string; included: boolean; reason: string; revision: number }
  | { type: 'center'; action: 'run'; confirmed: boolean; resume: boolean; revision: number }
  | { type: 'center'; action: 'verdict'; verdict: ReviewVerdict }
  | { type: 'center'; action: 'notes'; text: string }
  | { type: 'center'; action: 'submit'; verdict: ReviewVerdict; notes: string; preview: string }
  | { type: 'center'; action: 'copy' | 'save-report'; notes: string; preview: string }
  | { type: 'center'; action: 'fix'; path: string; id: string; ref: string; global: boolean }
  | { type: 'center'; action: 'undo-fix'; path: string; id: string; ref: string; global: boolean }
  | { type: 'center'; action: 'dispose'; path: string; id: string; ref: string; global: boolean; kind: 'commented' | 'ignored' }
  | { type: 'center'; action: 'evidence'; path: string; line: number }
  | { type: 'center'; action: 'open-document'; path: string }
  | { type: 'center'; action: 'document-action'; command: 'translate' | 'explain' | 'note' | 'comment' | 'translateWhole'; path: string; start: number; end: number; text: string; revision: string }
  | { type: 'center'; action: 'remove-annotation'; path: string; id: string }
  | { type: 'center'; action: 'client-error'; message: string });

function centerRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isReviewCenterMessage(value: unknown): value is ReviewCenterMessage {
  if (!centerRecord(value) || value.type !== 'center' || typeof value.scopeKey !== 'string' || typeof value.runId !== 'string') return false;
  const record = value;
  const string = (key: string) => typeof record[key] === 'string';
  const integer = (key: string) => typeof record[key] === 'number' && Number.isInteger(record[key]) && Number(record[key]) >= 0;
  const verdict = (key: string) => record[key] === 'approve' || record[key] === 'request-changes' || record[key] === 'comment';
  switch (record.action) {
    case 'ready': return string('editing');
    case 'add-file': case 'understand': case 'cancel': return true;
    case 'stage': return record.stage === 'prepare' || record.stage === 'review' || record.stage === 'conclusion';
    case 'editing': return string('id');
    case 'seen': return string('path') && string('revision') && Array.isArray(record.lines)
      && record.lines.length <= 1000 && record.lines.every((line) => typeof line === 'number' && Number.isInteger(line) && line > 0);
    case 'text': return string('label') && string('text') && typeof record.human === 'boolean';
    case 'link': return string('url');
    case 'remove-source': return string('id');
    case 'read-source': return string('id') && integer('version') && Number(record.version) > 0;
    case 'revise': return string('id') && string('title') && string('text') && integer('revision');
    case 'include': return string('id') && typeof record.included === 'boolean' && string('reason') && integer('revision');
    case 'run': return typeof record.confirmed === 'boolean' && typeof record.resume === 'boolean' && integer('revision');
    case 'verdict': return verdict('verdict');
    case 'notes': return string('text') && String(record.text).length <= 64_000;
    case 'submit': return verdict('verdict') && string('notes') && string('preview');
    case 'copy': case 'save-report': return string('notes') && string('preview');
    case 'fix': case 'undo-fix': return string('path') && string('id') && string('ref') && typeof record.global === 'boolean';
    case 'dispose': return string('path') && string('id') && string('ref') && typeof record.global === 'boolean'
      && (record.kind === 'commented' || record.kind === 'ignored');
    case 'evidence': return string('path') && integer('line') && Number(record.line) > 0;
    case 'open-document': return string('path');
    case 'document-action':
      return string('path') && string('revision') && string('text') && integer('start') && integer('end')
        && ['translate', 'explain', 'note', 'comment', 'translateWhole'].includes(String(record.command));
    case 'remove-annotation': return string('path') && string('id');
    case 'client-error': return string('message') && String(record.message).length <= 4000;
    default: return false;
  }
}

export function renderReviewCenter(state: WorkbenchState): string {
  const { center, files, ...common } = state;
  if (!center) throw new Error('Review center state is required');
  const { document, ...meta } = center;
  const initial: ReviewCenterUpdate = { type: 'center-state', state: common, files, center: meta, document };
  const token = nonce();
  return `<!DOCTYPE html><html lang="${resolveLanguage()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${token}';">
<title>${m().reviewCenter.title}</title><style>${centerStyles}</style></head>
<body><div id="center-shell"><header id="center-header"></header><div id="center-context"></div><div class="center-layout"><aside id="center-nav"></aside><main id="center-main"></main><aside id="center-inspector"></aside></div></div>
<dialog id="center-dialog"></dialog><div id="center-notice" role="status" aria-live="polite" hidden></div>
<script nonce="${token}">(${reviewCenterClient.toString()})(${scriptJson(initial)},${scriptJson(m().reviewCenter)},${composeReviewReport.toString()});</script></body></html>`;
}

const centerStyles = `
body{padding:0}
:root{color-scheme:light dark;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
*{box-sizing:border-box}body{margin:0}button,input,textarea,select{font:inherit;color:inherit}button,summary,select{cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}button{border:1px solid var(--vscode-button-border,transparent);border-radius:4px;padding:6px 10px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}
button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button.primary:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
button.link{padding:3px 0;border:0;background:transparent;color:var(--vscode-textLink-foreground);text-align:left}button.link:hover{text-decoration:underline}button.small{font-size:11px;padding:4px 7px}
input,textarea,select{min-width:0;border:1px solid var(--vscode-input-border,transparent);border-radius:3px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:7px 9px}textarea{width:100%;resize:vertical;min-height:90px;line-height:1.75}input[type=radio]{accent-color:var(--vscode-focusBorder);width:auto}
:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}[hidden]{display:none!important}.muted,.hint{color:var(--vscode-descriptionForeground)}.hint{font-size:11px;line-height:1.8;margin:8px 0}.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.spread{justify-content:space-between}.badge{display:inline-block;border:1px solid var(--vscode-widget-border,transparent);border-radius:3px;padding:2px 6px;font-size:10px;line-height:1.6;color:var(--vscode-descriptionForeground);white-space:nowrap}.badge.blue{color:var(--vscode-textLink-foreground)}.badge.red{color:var(--vscode-errorForeground)}.badge.amber{color:var(--vscode-editorWarning-foreground)}.badge.green{color:var(--vscode-testing-iconPassed,var(--vscode-foreground))}
#center-shell{height:100vh;height:100dvh;display:grid;grid-template-rows:auto auto minmax(0,1fr)}#center-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 16px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}.brand{font-weight:600;white-space:nowrap}.commands,.stages{display:flex;align-items:center;gap:7px}.stages button{background:transparent;color:var(--vscode-descriptionForeground);border-color:transparent}.stages button.active{background:var(--vscode-list-inactiveSelectionBackground);color:var(--vscode-list-inactiveSelectionForeground)}.commands button{font-size:11px}
#center-context{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 16px;min-height:36px;border-bottom:1px solid var(--vscode-panel-border);font-size:11px}.scope-label{overflow-wrap:anywhere;min-width:0}
.center-layout{display:grid;grid-template-columns:230px minmax(0,1fr) 340px;min-height:0;overflow:hidden}#center-nav,#center-inspector{display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--vscode-sideBar-background)}#center-nav{border-right:1px solid var(--vscode-panel-border)}#center-inspector{border-left:1px solid var(--vscode-panel-border)}#center-main{display:flex;flex-direction:column;min-width:0;min-height:0;position:relative}
#center-shell[data-stage=prepare] #center-context,#center-shell[data-stage=prepare] #center-nav,#center-shell[data-stage=prepare] #center-inspector{display:none}#center-shell[data-stage=prepare] .center-layout{grid-template-columns:minmax(0,1fr)}.prepare{max-width:860px;width:100%;margin:auto;padding:25px;overflow:auto;min-height:0}.prepare h1,.conclusion h1{font-size:23px;margin:0 0 16px;font-weight:600}.card{padding:15px;margin-top:14px;border:1px solid var(--vscode-panel-border);border-radius:5px}.card h2,.section-heading h2{font-size:13px;font-weight:600;margin:0}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.field{display:block;font-size:12px;margin:12px 0 5px}.field input,.field select{display:block;width:100%;margin-top:5px}.source-list{display:flex;flex-direction:column;gap:7px;margin-top:10px}.source-row{display:flex;align-items:center;gap:10px;min-width:0}.source-row>button:first-child{flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.requirement{padding:13px 0;border-bottom:1px solid var(--vscode-panel-border)}.requirement:last-child{border-bottom:0}.requirement h3{margin:0;font-size:13px;flex:1}.requirement.excluded{color:var(--vscode-descriptionForeground)}.requirement-body{font-size:12px;line-height:1.9;overflow-wrap:anywhere;margin-top:8px}.requirement-body p{margin:6px 0}.requirement-body pre{white-space:pre-wrap;background:var(--vscode-textCodeBlock-background);padding:10px;overflow-wrap:anywhere}.requirement-body table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}.requirement-body td,.requirement-body th{padding:5px;border:1px solid var(--vscode-panel-border)}.requirement details{margin-top:9px;font-size:11px}.requirement details p{line-height:1.8;overflow-wrap:anywhere}.requirement .actions{margin-top:8px}.requirement-editor{margin-top:10px}.requirement-editor input{width:100%}.requirement-editor textarea{min-height:130px}.prepare-footer{display:flex;justify-content:space-between;align-items:center;gap:14px;margin:18px 0}.prepare-footer p{max-width:510px}.error-box,.blockers{padding:11px;border:1px solid var(--vscode-inputValidation-warningBorder,var(--vscode-editorWarning-foreground));background:var(--vscode-inputValidation-warningBackground);font-size:12px;line-height:1.8;overflow-wrap:anywhere;margin-top:12px}.error-box.error{color:var(--vscode-errorForeground)}.extra{margin-top:12px;font-size:11px;line-height:1.8}.extra ul{padding-left:18px}
.nav-head,.inspector-head{padding:12px 13px;border-bottom:1px solid var(--vscode-panel-border);display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:600}.nav-tabs{display:flex;gap:3px;padding:9px}.nav-tabs button{flex:1;font-size:11px;padding:5px}.nav-tabs button.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}#center-search{width:calc(100% - 20px);margin:0 10px 8px;font-size:11px}.nav-scroll,.inspector-scroll{overflow:auto;min-height:0;flex:1;padding:12px}.nav-title{font-size:10px;color:var(--vscode-descriptionForeground);margin:12px 0 7px}.nav-item{display:block;width:100%;text-align:left;background:transparent;color:var(--vscode-foreground);border:1px solid transparent;padding:8px;border-radius:4px;margin-bottom:4px;font-size:12px}.nav-item strong{display:block;font-size:12px;font-weight:500;line-height:1.65}.nav-item small{display:block;color:var(--vscode-descriptionForeground);font-size:10px;margin-top:4px}.nav-item.active{border-color:var(--vscode-focusBorder);background:var(--vscode-list-inactiveSelectionBackground)}.file-item{font-family:var(--vscode-editor-font-family);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chain-title{font-size:12px;font-weight:600;margin:14px 0 7px}
.source-tools{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 13px;border-bottom:1px solid var(--vscode-panel-border)}.source-path{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.view-controls{display:flex;align-items:center;gap:4px;flex-shrink:0}.view-controls button{font-size:10px;padding:3px 6px}.view-controls button.active{outline:1px solid var(--vscode-focusBorder)}.source-scroll{flex:1;min-height:0;overflow:auto;padding-bottom:20px;position:relative}.code-caption{padding:9px 14px;font-size:10px;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border)}.code-line{display:grid;grid-template-columns:42px 42px 17px minmax(0,1fr);border-left:2px solid transparent;padding-right:15px;min-height:22px;font:var(--vscode-editor-font-size,12px)/1.8 var(--vscode-editor-font-family,monospace)}.code-line.source{grid-template-columns:42px 17px minmax(0,1fr)}.code-line code{white-space:pre;tab-size:4;display:block;min-width:max-content}.code-line .ln{text-align:right;padding-right:8px;color:var(--vscode-editorLineNumber-foreground);user-select:none;font-size:10px}.code-line .change{color:var(--vscode-descriptionForeground);user-select:none}.code-line.added{background:var(--vscode-diffEditor-insertedTextBackground)}.code-line.deleted{background:var(--vscode-diffEditor-removedTextBackground)}.code-line.focused{border-left-color:var(--vscode-focusBorder)}.code-line.focused code{text-decoration:underline dotted var(--vscode-focusBorder);text-underline-offset:5px}.finding-marker{display:flex;gap:9px;align-items:center;margin:8px 15px 11px 44px;padding:7px 10px;font-size:11px;max-width:calc(100% - 60px);text-align:left}.finding-marker span{color:var(--vscode-descriptionForeground)}
.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:var(--vscode-symbolIcon-keywordForeground,var(--vscode-textLink-foreground))}.hljs-string,.hljs-attr{color:var(--vscode-debugTokenExpression-string,var(--vscode-foreground))}.hljs-number{color:var(--vscode-debugTokenExpression-number,var(--vscode-foreground))}.hljs-comment{color:var(--vscode-descriptionForeground)}.reading{padding:20px;line-height:1.9;overflow-wrap:anywhere}.reading pre{white-space:pre-wrap;background:var(--vscode-textCodeBlock-background);padding:12px}.reading table{display:block;max-width:100%;overflow:auto}.reading td,.reading th{padding:5px;border:1px solid var(--vscode-panel-border)}.reading a{color:var(--vscode-textLink-foreground)}.bilingual{display:grid;grid-template-columns:1fr 1fr;gap:16px}.selection-tools{position:absolute;z-index:10;right:14px;display:flex;gap:5px;padding:7px;border:1px solid var(--vscode-widget-border);border-radius:5px;background:var(--vscode-editorWidget-background);box-shadow:0 4px 14px var(--vscode-widget-shadow)}.selection-tools button{font-size:11px}.annotations{margin:16px;font-size:11px}.annotations article{padding:12px;border-top:1px solid var(--vscode-panel-border)}
.inspector-title{font-size:19px;line-height:1.6;margin:13px 0}.inspector-summary{font-size:12px;line-height:1.9;white-space:pre-wrap}.inspector-tabs{display:flex;gap:10px;margin-top:16px;border-bottom:1px solid var(--vscode-panel-border)}.inspector-tabs button{border:0;border-bottom:2px solid transparent;background:transparent;border-radius:0;font-size:11px;padding:7px 1px}.inspector-tabs button.active{border-bottom-color:var(--vscode-focusBorder);color:var(--vscode-textLink-foreground)}.inspector-section{margin-top:18px;font-size:12px;line-height:1.9;overflow-wrap:anywhere}.inspector-section h3{font-size:12px;margin-bottom:7px}.proof{margin:9px 0;padding:10px;border:1px solid var(--vscode-panel-border);border-radius:4px}.proof p{margin:5px 0;white-space:pre-wrap}.inspector-actions{padding:12px;border-top:1px solid var(--vscode-panel-border)}.inspector-actions .row{align-items:stretch}
.conclusion{padding:24px;overflow:auto;min-height:0;flex:1}.report{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--vscode-panel-border);background:var(--vscode-textCodeBlock-background);padding:14px;font:11px/1.9 var(--vscode-font-family);margin-top:12px}.verdict-option{display:flex;gap:9px;padding:12px;border:1px solid var(--vscode-panel-border);border-radius:4px;margin-bottom:9px;font-size:12px}.verdict-option:has(input:checked){border-color:var(--vscode-focusBorder);background:var(--vscode-list-inactiveSelectionBackground)}.verdict-option small{display:block;font-size:10px;color:var(--vscode-descriptionForeground);line-height:1.8;margin-top:3px}.blockers ul{padding-left:18px}.status-strip{padding:9px 13px;font-size:11px;line-height:1.8;border-bottom:1px solid var(--vscode-panel-border);color:var(--vscode-editorWarning-foreground)}.status-strip ul{padding-left:16px;margin:5px 0}.empty{padding:35px 20px;color:var(--vscode-descriptionForeground);line-height:1.9;text-align:center}
dialog{color:var(--vscode-foreground);background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border);border-radius:6px;padding:0;width:min(760px,calc(100vw - 32px));max-height:calc(100vh - 45px);overflow:auto}dialog::backdrop{background:#0007}.dialog-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:15px 18px;border-bottom:1px solid var(--vscode-panel-border)}.dialog-head h2{font-size:14px;margin:0;overflow-wrap:anywhere}.dialog-body{padding:18px}.dialog-body input{width:100%}.dialog-body textarea{min-height:180px}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--vscode-panel-border)}.raw-source{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.9 var(--vscode-editor-font-family)}#center-notice{position:fixed;bottom:15px;left:50%;transform:translateX(-50%);z-index:30;max-width:calc(100vw - 30px);padding:10px 16px;border:1px solid var(--vscode-widget-border);border-radius:4px;background:var(--vscode-editorWidget-background);box-shadow:0 3px 15px var(--vscode-widget-shadow);font-size:12px;overflow-wrap:anywhere}
.focused-code .center-layout{grid-template-columns:0 minmax(0,1fr) 340px}.focused-code #center-nav{overflow:hidden}
@media(max-width:1100px){.center-layout{grid-template-columns:190px minmax(0,1fr) 295px}.focused-code .center-layout{grid-template-columns:0 minmax(0,1fr) 295px}.commands{gap:4px}.brand{font-size:12px}.inspector-title{font-size:17px}}
@media(max-width:850px){#center-shell{height:auto;min-height:100dvh}#center-header{flex-wrap:wrap}.stages{order:3;justify-content:center;width:100%}.center-layout{grid-template-columns:minmax(0,1fr) 295px;overflow:visible}#center-nav{grid-column:1/-1;border-right:0;border-bottom:1px solid var(--vscode-panel-border)}.nav-scroll{max-height:190px}.nav-tabs{max-width:300px}#center-search{max-width:calc(100% - 20px)}#center-main{min-height:620px}.source-scroll{max-height:850px}.inspector-scroll{max-height:850px}.focused-code .center-layout{grid-template-columns:minmax(0,1fr) 295px}.focused-code #center-nav{display:none}.prepare{overflow:visible}}
@media(max-width:600px){.center-layout,.focused-code .center-layout{grid-template-columns:minmax(0,1fr)}#center-inspector{border-left:0;border-top:1px solid var(--vscode-panel-border)}.inspector-scroll{max-height:none}.commands{flex-wrap:wrap;justify-content:flex-end}.prepare,.conclusion{padding:18px 14px}.card{padding:12px}.prepare-footer{flex-direction:column;align-items:stretch}.section-heading{flex-wrap:wrap}.source-tools{flex-wrap:wrap}.source-path{width:100%}.view-controls{margin-left:auto}.reading{padding:15px}.bilingual{grid-template-columns:1fr}.code-line{grid-template-columns:30px 30px 14px minmax(0,1fr)}.code-line.source{grid-template-columns:30px 14px minmax(0,1fr)}.finding-marker{margin-left:15px}.requirement .row{align-items:flex-start}}
`;
