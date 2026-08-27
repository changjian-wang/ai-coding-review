import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
  commands,
  resetVscodeMock,
  vscodeMockState,
} from '../test/vscodeMock';
import {
  normalisePastedReason,
  registerIgnoreReasonPasteCommand,
  showIgnoreReasonInput,
} from './ignoreReasonInput';

describe('ignore reason input', () => {
  afterEach(() => resetVscodeMock());

  it('pastes clipboard text through the scoped Ctrl+V command', async () => {
    const registration = registerIgnoreReasonPasteCommand();
    vscodeMockState.clipboardText = 'tracked\r\nin issue #123';

    const result = showIgnoreReasonInput('Output JSON misses its parent directory');
    await vi.waitFor(() => {
      expect(vscodeMockState.inputBox).toBeDefined();
      expect(vscodeMockState.contextKeys.get('codereview.ignoreReasonInputActive')).toBe(true);
    });
    const input = vscodeMockState.inputBox;
    if (!input) {
      throw new Error('Expected an ignore-reason input');
    }

    expect(input.buttons).toHaveLength(1);
    expect((input.buttons[0] as { iconPath: vscode.ThemeIcon }).iconPath.id).toBe('clippy');
    await commands.executeCommand('codereview.pasteIgnoreReason');

    expect(input.value).toBe('tracked in issue #123');
    expect(input.valueSelection).toEqual([21, 21]);
    expect(input.validationMessage).toBeUndefined();

    input.accept();
    await expect(result).resolves.toBe('tracked in issue #123');
    expect(vscodeMockState.contextKeys.get('codereview.ignoreReasonInputActive')).toBe(false);
    registration.dispose();
  });

  it('uses the clipboard button and surfaces clipboard failures', async () => {
    vscodeMockState.clipboardReadError = new Error('clipboard unavailable');
    const result = showIgnoreReasonInput('Finding');
    await vi.waitFor(() => expect(vscodeMockState.inputBox).toBeDefined());
    const input = vscodeMockState.inputBox;
    if (!input) {
      throw new Error('Expected an ignore-reason input');
    }

    input.triggerButton(input.buttons[0]);
    await vi.waitFor(() => {
      expect(input.validationMessage).toContain('clipboard unavailable');
    });

    input.hide();
    await expect(result).resolves.toBeUndefined();
  });

  it('normalises multiline clipboard text for the single-line input', () => {
    expect(normalisePastedReason(' first\r\nsecond\nthird ')).toBe('first second third');
  });

  it('keeps the input open until the reason reaches the minimum length', async () => {
    const result = showIgnoreReasonInput('Finding');
    await vi.waitFor(() => expect(vscodeMockState.inputBox).toBeDefined());
    const input = vscodeMockState.inputBox;
    if (!input) {
      throw new Error('Expected an ignore-reason input');
    }

    input.changeValue('abc');
    input.accept();
    expect(input.validationMessage).toBeTruthy();

    input.changeValue('valid reason');
    input.accept();
    await expect(result).resolves.toBe('valid reason');
  });

  it('closes the input and clears the keybinding context when deactivated', async () => {
    const registration = registerIgnoreReasonPasteCommand();
    const result = showIgnoreReasonInput('Finding');
    await vi.waitFor(() => {
      expect(vscodeMockState.contextKeys.get('codereview.ignoreReasonInputActive')).toBe(true);
    });

    registration.dispose();

    await expect(result).resolves.toBeUndefined();
    expect(vscodeMockState.contextKeys.get('codereview.ignoreReasonInputActive')).toBe(false);
  });
});
