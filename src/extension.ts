import * as vscode from 'vscode';
import {AntigravityChatProvider} from './provider';
import {clearAuth, getStoredAuth, loginWithOAuth} from './auth';

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loginAndNotify(context: vscode.ExtensionContext): Promise<void> {
  const result = await loginWithOAuth(context).then(
    auth => ({ok: true as const, auth}),
    error => ({ok: false as const, error}),
  );

  if (result.ok) {
    const label = result.auth.email
      ? `Signed in as ${result.auth.email}`
      : 'Signed in';
    void vscode.window.showInformationMessage(label);
    return;
  }

  const message = formatErrorMessage(result.error);
  void vscode.window.showErrorMessage(`Antigravity sign-in failed: ${message}`);
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new AntigravityChatProvider(context);
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider('antigravity', provider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity.auth.login', async () => {
      await loginAndNotify(context);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity.auth.logout', async () => {
      await clearAuth(context);
      void vscode.window.showInformationMessage(
        'Antigravity credentials cleared.',
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity.manage', async () => {
      const existing = await getStoredAuth(context);
      const items: vscode.QuickPickItem[] = existing
        ? [
            {
              label: 'Sign Out',
              description: 'Clear stored Antigravity tokens',
            },
            {label: 'Re-authenticate', description: 'Sign in again'},
          ]
        : [{label: 'Sign In', description: 'Start OAuth login'}];

      const selection = await vscode.window.showQuickPick(items, {
        placeHolder: 'Manage Antigravity authentication',
      });

      if (!selection) {
        return;
      }

      if (selection.label === 'Sign Out') {
        await clearAuth(context);
        void vscode.window.showInformationMessage(
          'Antigravity credentials cleared.',
        );
        return;
      }

      await loginAndNotify(context);
    }),
  );
}

export function deactivate(): void {}
