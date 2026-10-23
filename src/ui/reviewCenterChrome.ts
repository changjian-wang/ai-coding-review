import { esc } from './html';

export function reviewBrand(contextId: string): string {
  return `<div class="brand"><span class="product-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" stroke="currentColor" stroke-width="1.5"/><path d="m8 12 3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span><div><strong>AI Coding Review</strong><small id="${esc(contextId)}"></small></div></div>`;
}

export function reviewStageLabel(index: number, label: string): string {
  return `<span class="stage-index" aria-hidden="true">${index}</span><span>${esc(label)}</span>`;
}

export const reviewCenterChrome = `
  :root{
    --review-canvas:var(--vscode-editor-background);
    --review-surface:var(--vscode-sideBar-background,var(--review-canvas));
    --review-raised:var(--vscode-editorWidget-background,var(--review-surface));
    --review-subtle:color-mix(in srgb,var(--vscode-foreground) 4%,var(--review-canvas));
    --review-border:var(--vscode-panel-border,color-mix(in srgb,var(--vscode-foreground) 22%,var(--review-canvas)));
    --review-accent:var(--vscode-textLink-foreground);
    --review-accent-soft:color-mix(in srgb,var(--review-accent) 12%,var(--review-canvas));
    --review-accent-border:color-mix(in srgb,var(--review-accent) 55%,var(--review-border));
    --review-muted:var(--vscode-descriptionForeground);
    --review-green:var(--vscode-testing-iconPassed,var(--vscode-textLink-foreground));
  }
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{font:13px/1.65 var(--vscode-font-family,"Segoe UI","Microsoft YaHei",sans-serif);color:var(--vscode-foreground);background:var(--review-canvas)}
  button,input,select,textarea{font:inherit;color:inherit}
  button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:30px;padding:6px 10px;border:1px solid var(--review-border);border-radius:5px;background:var(--review-raised);cursor:pointer;font-size:11px;line-height:1.5}
  button:hover:not(:disabled){background:var(--vscode-list-hoverBackground)}
  button:disabled{opacity:.5;cursor:not-allowed}
  button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
  button.primary:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
  button.secondary{background:transparent;color:var(--review-accent);border-color:transparent}
  button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}
  h1,h2,h3,p{margin:0}
  h1{font-size:23px;font-weight:550;line-height:1.5;letter-spacing:-.3px}
  h2{font-size:13px;font-weight:550}
  h3{font-size:12px;font-weight:550}
  .command{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:65px;padding:10px 20px;background:var(--review-surface);border-bottom:1px solid var(--review-border)}
  .brand{display:flex;align-items:center;gap:10px;min-width:180px}
  .brand>div{min-width:0}
  .brand strong{display:block;font-size:14px;font-weight:550;letter-spacing:-.2px;white-space:nowrap}
  .brand small{display:block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--review-muted)}
  .product-mark{display:grid;place-items:center;width:32px;height:34px;flex:none;border:1px solid color-mix(in srgb,var(--review-green) 45%,var(--review-border));border-radius:7px;background:color-mix(in srgb,var(--review-green) 10%,var(--review-surface));color:var(--review-green)}
  .product-mark svg{width:22px;height:22px}
  .stages{display:flex;align-items:center;justify-content:center;gap:7px}
  .stages button{gap:7px;border-color:transparent;background:transparent;color:var(--review-muted);padding:7px 10px;font-size:12px;white-space:nowrap}
  .stages button.active{color:var(--review-accent);background:var(--review-accent-soft)}
  .stage-index{display:grid;place-items:center;width:18px;height:18px;border:1px solid var(--review-border);border-radius:50%;font-size:10px}
  .stages .active .stage-index{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border-color:transparent}
  .stage-divider{width:20px;height:1px;background:var(--review-border);flex:none}
  .command-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px;min-width:150px}
  .command-actions button{white-space:nowrap}
  .command-actions .language-button{color:var(--review-muted);background:transparent;border-color:transparent}
  .eyebrow{display:flex;align-items:center;gap:12px;flex-wrap:wrap;color:var(--review-muted);font-size:10px;letter-spacing:.6px;margin-bottom:8px}
  .eyebrow span{letter-spacing:0}
  .stage-description{color:var(--review-muted);font-size:12px;line-height:1.9;margin-top:8px}
  .section-heading{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px}
  .section-heading h2{display:flex;align-items:center;gap:8px}
  .section-heading h2 small{font-size:10px;font-weight:400;color:var(--review-muted)}
  .section-number{display:grid;place-items:center;width:19px;height:19px;flex:none;border:1px solid var(--review-border);border-radius:50%;color:var(--review-muted);font-size:10px;font-weight:400}
  .review-card{border:1px solid var(--review-border);border-radius:6px;padding:16px;background:var(--review-surface);margin-top:14px;min-width:0}
  .badge{display:inline-flex;align-items:center;gap:5px;max-width:100%;border:1px solid var(--review-border);border-radius:4px;padding:2px 6px;font-size:10px;line-height:1.5;color:var(--review-muted);background:var(--review-subtle);overflow-wrap:anywhere}
  .badge.accent{background:var(--review-accent-soft);color:var(--review-accent);border-color:transparent}
  .row,.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .hint{font-size:10px;line-height:1.9;color:var(--review-muted);overflow-wrap:anywhere}
  .boundary{padding:9px 11px;border-left:2px solid var(--review-accent-border);color:var(--review-muted);font-size:11px;line-height:1.9}
  .error-text,.error{color:var(--vscode-errorForeground)}
  .markdown{line-height:1.9;overflow-wrap:anywhere;min-width:0}
  .markdown p+ p,.markdown ul,.markdown ol{margin-top:8px}
  .markdown code{font-family:var(--vscode-editor-font-family)}
  .markdown pre{overflow:auto;white-space:pre;max-width:100%;padding:12px;background:var(--vscode-textCodeBlock-background)}
  .markdown table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}
  .markdown td,.markdown th{border:1px solid var(--review-border);padding:5px 8px}
  .markdown blockquote{margin-left:0;border-left:2px solid var(--vscode-textBlockQuote-border);padding-left:12px}
  .markdown a{color:var(--review-accent)}
  .bottom{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;min-height:27px;padding:4px 16px;border-top:1px solid var(--review-border);background:var(--review-surface);color:var(--review-muted);font-size:10px;overflow-wrap:anywhere}
  [hidden]{display:none!important}
  @media(max-width:1020px){.command{gap:10px;padding-inline:14px;flex-wrap:wrap}.brand small{max-width:200px}.command-actions{min-width:0}.stage-divider{width:12px}}
  @media(max-width:690px){.command{padding:10px 12px;min-width:0}.brand{min-width:0}.brand strong{font-size:12px}.brand small{max-width:150px}.product-mark{width:28px;height:30px}.stages{order:3;width:100%;gap:4px}.stages button{padding:6px 8px;font-size:11px}.stage-divider{width:8px}.command-actions{margin-left:auto}.command-actions button{font-size:10px;padding:5px 7px}.eyebrow{gap:6px;font-size:9px}h1{font-size:21px}}
`;
