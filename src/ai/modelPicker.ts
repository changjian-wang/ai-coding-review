import * as vscode from 'vscode';
import { m } from '../i18n';

/**
 * The model chosen for analysis. `model` is undefined when the user picks
 * "Auto" — in that case callers resolve a model at request time.
 */
export interface PickedModel {
  id: string;
  label: string;
  model?: vscode.LanguageModelChat;
}

/** Lets the user choose among Copilot-authorised models (or Auto). */
export async function pickModel(): Promise<PickedModel | undefined> {
  let models: readonly vscode.LanguageModelChat[] = [];
  try {
    models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  } catch {
    // selectChatModels can throw before Copilot is ready; treat as empty.
    models = [];
  }

  type Item = vscode.QuickPickItem & { value: PickedModel };
  const items: Item[] = [
    {
      label: 'Auto',
      description: m().model.autoDescription,
      value: { id: 'auto', label: 'Auto' },
    },
    ...models.map((m): Item => ({
      label: m.name,
      description: `${m.vendor} · ${m.family}`,
      detail: `max input ${m.maxInputTokens.toLocaleString()} tokens`,
      value: { id: m.id, label: m.name, model: m },
    })),
  ];

  const choice = await vscode.window.showQuickPick(items, {
    title: m().model.pickTitle,
    placeHolder: models.length ? m().model.pickPlaceholder : m().model.pickPlaceholderEmpty,
  });
  return choice?.value;
}
