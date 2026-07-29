interface Disposable {
  dispose(): void;
}

interface MockWebview {
  html: string;
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

export function resetVscodeMock(): void {
  vscodeMockState.panel?.dispose();
  vscodeMockState.language = 'en';
  vscodeMockState.panel = undefined;
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
    const panel = createPanel();
    panel.title = title;
    vscodeMockState.panel = panel;
    return panel;
  },
  showWarningMessage: async () => undefined,
  setStatusBarMessage: () => disposable(),
};

export const env = { language: 'en' };
export const ViewColumn = { Beside: 2 };

export class CancellationTokenSource {
  readonly token = { isCancellationRequested: false };

  cancel(): void {
    this.token.isCancellationRequested = true;
  }

  dispose(): void {}
}