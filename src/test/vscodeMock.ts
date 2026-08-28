interface Disposable {
  dispose(): void;
}

interface MockWebview {
  html: string;
  options?: unknown;
  messages: unknown[];
  onDidReceiveMessage(listener: (message: unknown) => void): Disposable;
  postMessage(message: unknown): Promise<boolean>;
  receiveMessage(message: unknown): void;
}

export interface MockWebviewPanel {
  title: string;
  viewColumn: number;
  webview: MockWebview;
  reveal(): void;
  dispose(): void;
  onDidDispose(listener: () => void): Disposable;
}

export interface MockInputBox {
  title?: string;
  prompt?: string;
  placeholder?: string;
  ignoreFocusOut: boolean;
  value: string;
  valueSelection?: readonly [number, number];
  validationMessage?: string;
  buttons: readonly unknown[];
  onDidChangeValue(listener: (value: string) => void): Disposable;
  onDidAccept(listener: () => void): Disposable;
  onDidHide(listener: () => void): Disposable;
  onDidTriggerButton(listener: (button: unknown) => void): Disposable;
  show(): void;
  hide(): void;
  dispose(): void;
  changeValue(value: string): void;
  accept(): void;
  triggerButton(button: unknown): void;
}

export const vscodeMockState: {
  language: string;
  panel?: MockWebviewPanel;
  inputBox?: MockInputBox;
  progress?: { options: unknown; reports: unknown[] };
  openTextDocument?: (uri: unknown) => Promise<{ getText(): string }>;
  clipboardText: string;
  clipboardReadError?: Error;
  contextKeys: Map<string, unknown>;
  warnings: string[];
} = {
  language: 'en',
  clipboardText: '',
  contextKeys: new Map(),
  warnings: [],
};

function disposable(): Disposable {
  return { dispose() {} };
}

function createPanel(): MockWebviewPanel {
  const disposeListeners: Array<() => void> = [];
  let messageListener: ((message: unknown) => void) | undefined;
  let disposed = false;
  return {
    title: '',
    viewColumn: 2,
    webview: {
      html: '',
      messages: [],
      onDidReceiveMessage(listener: (message: unknown) => void) {
        messageListener = listener;
        return disposable();
      },
      postMessage(message: unknown) {
        this.messages.push(message);
        return Promise.resolve(true);
      },
      receiveMessage(message: unknown) {
        messageListener?.(message);
      },
    },
    reveal() {},
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const listener of disposeListeners) {
        listener();
      }
    },
    onDidDispose(listener: () => void) {
      disposeListeners.push(listener);
      return disposable();
    },
  };
}

function createInputBox(): MockInputBox {
  const changeListeners: Array<(value: string) => void> = [];
  const acceptListeners: Array<() => void> = [];
  const hideListeners: Array<() => void> = [];
  const buttonListeners: Array<(button: unknown) => void> = [];
  let visible = false;
  let disposed = false;
  const input: MockInputBox = {
    ignoreFocusOut: false,
    value: '',
    buttons: [],
    onDidChangeValue(listener) {
      changeListeners.push(listener);
      return disposable();
    },
    onDidAccept(listener) {
      acceptListeners.push(listener);
      return disposable();
    },
    onDidHide(listener) {
      hideListeners.push(listener);
      return disposable();
    },
    onDidTriggerButton(listener) {
      buttonListeners.push(listener);
      return disposable();
    },
    show() {
      visible = true;
    },
    hide() {
      if (!visible) {
        return;
      }
      visible = false;
      for (const listener of hideListeners) {
        listener();
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      this.hide();
    },
    changeValue(value) {
      this.value = value;
      for (const listener of changeListeners) {
        listener(value);
      }
    },
    accept() {
      for (const listener of acceptListeners) {
        listener();
      }
    },
    triggerButton(button) {
      for (const listener of buttonListeners) {
        listener(button);
      }
    },
  };
  vscodeMockState.inputBox = input;
  return input;
}

export function createMockWebviewPanel(title = ''): MockWebviewPanel {
  const panel = createPanel();
  panel.title = title;
  vscodeMockState.panel = panel;
  return panel;
}

export function resetVscodeMock(): void {
  vscodeMockState.panel?.dispose();
  vscodeMockState.inputBox?.dispose();
  vscodeMockState.language = 'en';
  vscodeMockState.panel = undefined;
  vscodeMockState.inputBox = undefined;
  vscodeMockState.progress = undefined;
  vscodeMockState.openTextDocument = undefined;
  vscodeMockState.clipboardText = '';
  vscodeMockState.clipboardReadError = undefined;
  vscodeMockState.contextKeys.clear();
  vscodeMockState.warnings = [];
  registeredCommands.clear();
}

export const workspace = {
  textDocuments: [],
  getConfiguration: () => ({
    get: <T>(section: string, defaultValue: T): T =>
      (section === 'language' ? vscodeMockState.language : defaultValue) as T,
  }),
  openTextDocument: async (uri: unknown) => {
    if (vscodeMockState.openTextDocument) {
      return vscodeMockState.openTextDocument(uri);
    }
    throw new Error('openTextDocument is not available in this test');
  },
};

export const window = {
  createWebviewPanel: (_viewType: string, title: string) => {
    return createMockWebviewPanel(title);
  },
  showWarningMessage: async (message: string) => {
    vscodeMockState.warnings.push(message);
    return undefined;
  },
  setStatusBarMessage: () => disposable(),
  createInputBox,
  withProgress: async <T>(
    options: unknown,
    task: (progress: { report(value: unknown): void }) => Promise<T>,
  ): Promise<T> => {
    const reports: unknown[] = [];
    vscodeMockState.progress = { options, reports };
    return task({ report: (value) => reports.push(value) });
  },
};

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

export const commands = {
  executeCommand: async (command: string, ...args: unknown[]) => {
    if (command === 'setContext') {
      vscodeMockState.contextKeys.set(String(args[0]), args[1]);
      return;
    }
    return registeredCommands.get(command)?.(...args);
  },
  registerCommand: (command: string, callback: (...args: unknown[]) => unknown) => {
    registeredCommands.set(command, callback);
    return {
      dispose: () => {
        if (registeredCommands.get(command) === callback) {
          registeredCommands.delete(command);
        }
      },
    };
  },
};

export const env = {
  language: 'en',
  clipboard: {
    readText: async () => {
      if (vscodeMockState.clipboardReadError) {
        throw vscodeMockState.clipboardReadError;
      }
      return vscodeMockState.clipboardText;
    },
  },
};
export const ViewColumn = { One: 1, Beside: 2 };
export const ProgressLocation = { Notification: 15 };

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export const LanguageModelChatMessage = {
  User: (content: string) => ({ role: 'user', content }),
};

export class LanguageModelError extends Error {}

export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class Uri {
  static file(fsPath: string): { fsPath: string; scheme: string } {
    return { fsPath, scheme: 'file' };
  }
}

export class CancellationTokenSource {
  readonly token = { isCancellationRequested: false };

  cancel(): void {
    this.token.isCancellationRequested = true;
  }

  dispose(): void {}
}