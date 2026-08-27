import * as vscode from 'vscode';
import { m } from '../i18n';

const PASTE_COMMAND = 'codereview.pasteIgnoreReason';
const INPUT_ACTIVE_CONTEXT = 'codereview.ignoreReasonInputActive';
const MIN_REASON_LENGTH = 4;

interface ActiveReasonInput {
  input: vscode.InputBox;
  token: symbol;
}

let activeReasonInput: ActiveReasonInput | undefined;

export function normalisePastedReason(value: string): string {
  return value.replace(/\r\n?|\n/g, ' ').trim();
}

function validationMessage(value: string): string | undefined {
  return value.trim().length >= MIN_REASON_LENGTH
    ? undefined
    : m().finding.ignoreMinLength;
}

async function pasteIntoActiveReasonInput(): Promise<void> {
  const active = activeReasonInput;
  if (!active) {
    return;
  }
  try {
    const value = normalisePastedReason(await vscode.env.clipboard.readText());
    if (activeReasonInput !== active) {
      return;
    }
    active.input.value = value;
    active.input.valueSelection = [value.length, value.length];
    active.input.validationMessage = validationMessage(value);
  } catch (err) {
    if (activeReasonInput === active) {
      const message = err instanceof Error ? err.message : String(err);
      active.input.validationMessage = m().finding.ignorePasteFailed(message);
    }
  }
}

export function registerIgnoreReasonPasteCommand(): vscode.Disposable {
  const command = vscode.commands.registerCommand(PASTE_COMMAND, pasteIntoActiveReasonInput);
  return {
    dispose: () => {
      command.dispose();
      const active = activeReasonInput;
      activeReasonInput = undefined;
      active?.input.hide();
      void vscode.commands
        .executeCommand('setContext', INPUT_ACTIVE_CONTEXT, false)
        .then(undefined, (err) => {
          console.warn('[codereview] failed to clear ignore-reason input context:', err);
        });
    },
  };
}

export async function showIgnoreReasonInput(findingTitle: string): Promise<string | undefined> {
  const input = vscode.window.createInputBox();
  const token = Symbol('ignore-reason-input');
  const pasteButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('clippy'),
    tooltip: m().finding.ignorePaste,
  };

  input.title = m().finding.ignoreTitle(findingTitle);
  input.prompt = m().finding.ignorePrompt;
  input.placeholder = m().finding.ignorePlaceholder;
  input.ignoreFocusOut = true;
  input.buttons = [pasteButton];
  input.validationMessage = validationMessage(input.value);
  activeReasonInput = { input, token };

  try {
    await vscode.commands.executeCommand('setContext', INPUT_ACTIVE_CONTEXT, true);
  } catch (err) {
    if (activeReasonInput?.token === token) {
      activeReasonInput = undefined;
    }
    input.dispose();
    throw err;
  }

  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const disposables: vscode.Disposable[] = [];
    const finish = async (value: string | undefined, hide: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const disposable of disposables) {
        disposable.dispose();
      }
      const ownsActiveInput = activeReasonInput?.token === token;
      if (ownsActiveInput) {
        activeReasonInput = undefined;
      }
      if (hide) {
        input.hide();
      }
      input.dispose();
      if (ownsActiveInput) {
        try {
          await vscode.commands.executeCommand('setContext', INPUT_ACTIVE_CONTEXT, false);
        } catch (err) {
          console.warn('[codereview] failed to clear ignore-reason input context:', err);
        }
      }
      resolve(value);
    };

    disposables.push(
      input.onDidChangeValue((value) => {
        input.validationMessage = validationMessage(value);
      }),
      input.onDidTriggerButton((button) => {
        if (button === pasteButton) {
          void pasteIntoActiveReasonInput();
        }
      }),
      input.onDidAccept(() => {
        const value = input.value.trim();
        const error = validationMessage(value);
        input.validationMessage = error;
        if (!error) {
          void finish(value, true);
        }
      }),
      input.onDidHide(() => void finish(undefined, false)),
    );

    input.show();
  });
}
