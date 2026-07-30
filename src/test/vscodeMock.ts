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

export const vscodeMockState: {
  language: string;
  panel?: MockWebviewPanel;
  progress?: { options: unknown; reports: unknown[] };
} = {
  language: 'en',
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

export function createMockWebviewPanel(title = ''): MockWebviewPanel {
  const panel = createPanel();
  panel.title = title;
  vscodeMockState.panel = panel;
  return panel;
}

export function resetVscodeMock(): void {
  vscodeMockState.panel?.dispose();
  vscodeMockState.language = 'en';
  vscodeMockState.panel = undefined;
  vscodeMockState.progress = undefined;
}

export const workspace = {
  textDocuments: [],
  getConfiguration: () => ({
    get: <T>(section: string, defaultValue: T): T =>
      (section === 'language' ? vscodeMockState.language : defaultValue) as T,
  }),
  openTextDocument: async () => {
    throw new Error('openTextDocument is not available in this test');
  },
};

export const window = {
  createWebviewPanel: (_viewType: string, title: string) => {
    return createMockWebviewPanel(title);
  },
  showWarningMessage: async () => undefined,
  setStatusBarMessage: () => disposable(),
  withProgress: async <T>(
    options: unknown,
    task: (progress: { report(value: unknown): void }) => Promise<T>,
  ): Promise<T> => {
    const reports: unknown[] = [];
    vscodeMockState.progress = { options, reports };
    return task({ report: (value) => reports.push(value) });
  },
};

export const commands = {
  executeCommand: async () => undefined,
};

export const env = { language: 'en' };
export const ViewColumn = { One: 1, Beside: 2 };
export const ProgressLocation = { Notification: 15 };

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