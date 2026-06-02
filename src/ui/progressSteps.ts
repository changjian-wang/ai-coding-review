import * as vscode from 'vscode';

/** Reports a real sub-step message as the work progresses. */
export type ProgressReporter = (message: string) => void;

/**
 * Runs an async task inside a notification progress. The `work` function is given
 * a `report` callback that it calls at real boundaries (e.g. after reading a file,
 * before invoking the model) so the messages the user sees always correspond to an
 * operation that is actually happening — no simulated stages.
 */
export async function runWithProgress<T>(
  title: string,
  work: (token: vscode.CancellationToken, report: ProgressReporter) => Promise<T>,
): Promise<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (progress, token) => {
      const report: ProgressReporter = (message) => progress.report({ message });
      return work(token, report);
    },
  );
}
