import * as vscode from 'vscode';
import type { PickedModel } from './modelPicker';

const MEMENTO_KEY = 'codereview.pickedModel.v1';

interface PersistedPick {
  id: string;
  label: string;
}

/**
 * Holds the model the user picked (or Auto) and resolves an actual chat model
 * on demand. The choice is persisted per workspace so each project remembers
 * its own model selection across reloads.
 */
export class ModelProvider {
  private picked?: PickedModel;
  private memento?: vscode.Memento;

  /** Hydrates the picked model from workspace state. Safe to call once during activate(). */
  init(memento: vscode.Memento): void {
    this.memento = memento;
    const stored = memento.get<PersistedPick>(MEMENTO_KEY);
    if (stored && stored.id) {
      // Restore label only — the live LanguageModelChat handle is rebound lazily in resolve().
      this.picked = { id: stored.id, label: stored.label };
    }
  }

  set(picked: PickedModel | undefined): void {
    this.picked = picked;
    if (!this.memento) {
      return;
    }
    if (picked) {
      void this.memento.update(MEMENTO_KEY, { id: picked.id, label: picked.label } satisfies PersistedPick);
    } else {
      void this.memento.update(MEMENTO_KEY, undefined);
    }
  }

  get label(): string {
    return this.picked?.label ?? 'Auto';
  }

  /** Resolves a usable chat model, honouring an explicit pick or Auto. */
  async resolve(): Promise<vscode.LanguageModelChat | undefined> {
    if (this.picked && this.picked.id !== 'auto') {
      if (this.picked.model) {
        return this.picked.model;
      }
      // Rebind a persisted pick to a live model handle by id.
      try {
        const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        const match = models.find((m) => m.id === this.picked!.id);
        if (match) {
          this.picked = { ...this.picked, model: match };
          return match;
        }
      } catch {
        // fall through to Auto
      }
    }
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    return models[0];
  }
}
