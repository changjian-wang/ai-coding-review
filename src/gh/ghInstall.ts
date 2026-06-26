import * as vscode from 'vscode';
import { m } from '../i18n';

const GH_DOCS_URL = 'https://cli.github.com/';

/** Platform-appropriate command to install the GitHub CLI, or undefined. */
function ghInstallCommand(): string | undefined {
  switch (process.platform) {
    case 'win32':
      return 'winget install --id GitHub.cli -e --source winget';
    case 'darwin':
      return 'brew install gh';
    case 'linux':
      // Best-effort for Debian/Ubuntu; other distros should follow the docs.
      return 'sudo apt update && sudo apt install gh';
    default:
      return undefined;
  }
}

/**
 * Shown when the GitHub CLI is not installed. Offers to pre-fill the install
 * command in a terminal (the user reviews and runs it themselves — we never run
 * a system install silently), or to open the official install docs.
 */
export async function promptInstallGh(): Promise<void> {
  const installAction = m().gh.installAction;
  const docsAction = m().gh.docsAction;
  const choice = await vscode.window.showWarningMessage(
    m().gh.notFound,
    installAction,
    docsAction,
  );
  if (choice === installAction) {
    const cmd = ghInstallCommand();
    if (!cmd) {
      void vscode.env.openExternal(vscode.Uri.parse(GH_DOCS_URL));
      return;
    }
    const term = vscode.window.createTerminal('Install GitHub CLI');
    term.show();
    // Pre-fill but do NOT auto-run: the user reviews the command (and grants
    // any sudo/admin consent) before pressing Enter.
    term.sendText(cmd, false);
  } else if (choice === docsAction) {
    void vscode.env.openExternal(vscode.Uri.parse(GH_DOCS_URL));
  }
}
