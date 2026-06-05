import * as vscode from 'vscode';
import { en, type Messages } from './en';
import { zh } from './zh';

export type { Messages } from './en';

/** The two languages the UI and LLM output can resolve to. */
export type Language = 'zh-CN' | 'en';

/**
 * Resolves the active language from the `codereview.language` setting.
 * Default is English; `auto` follows VS Code's display language.
 * This single resolver backs both the UI catalog and the LLM output directive,
 * so the whole extension speaks one language driven by one setting.
 */
export function resolveLanguage(): Language {
  const choice = vscode.workspace
    .getConfiguration('codereview')
    .get<string>('language', 'en');
  if (choice === 'zh-CN' || choice === 'en') {
    return choice;
  }
  // `auto` (or any unexpected value): follow the VS Code display language.
  return vscode.env.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/** Returns the message catalog for the active language. */
export function m(): Messages {
  return resolveLanguage() === 'zh-CN' ? zh : en;
}

/**
 * Subscribes to `codereview.language` changes so callers can refresh UI
 * (status bar text, open webviews) the moment the user flips the setting.
 */
export function onLanguageChange(cb: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('codereview.language')) {
      cb();
    }
  });
}

/**
 * Tiny `{0}`/`{1}` positional formatter for strings handed to webview client
 * JS, where TS functions cannot run. Server-side TS should prefer the catalog's
 * function-valued entries instead.
 */
export function fmt(template: string, ...args: (string | number)[]): string {
  return template.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));
}
