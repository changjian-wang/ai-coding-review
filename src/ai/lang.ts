import * as vscode from 'vscode';

export type OutputLanguage = 'zh-CN' | 'en';

/** Reads the configured language, resolving `auto` against VS Code's UI language. */
export function getOutputLanguage(): OutputLanguage {
  const choice = vscode.workspace
    .getConfiguration('codereview')
    .get<string>('language', 'auto');
  if (choice === 'zh-CN' || choice === 'en') {
    return choice;
  }
  return vscode.env.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/**
 * A short system-prompt prefix forcing the model to answer in the chosen language,
 * regardless of the source code's language. Code identifiers stay verbatim.
 */
export function languageDirective(lang: OutputLanguage = getOutputLanguage()): string {
  if (lang === 'zh-CN') {
    return (
      '【输出语言】无论用户输入或源码使用什么自然语言，请始终用简体中文回答；' +
      '代码标识符、文件名、命令、错误信息、日志原文保持原样不要翻译。'
    );
  }
  return (
    '[Output language] Always answer in English regardless of the natural language used by the user or the source code. ' +
    'Keep code identifiers, file names, commands, and quoted error/log output verbatim.'
  );
}
