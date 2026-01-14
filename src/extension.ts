import * as vscode from "vscode";
import { AntigravityChatProvider } from "./provider";
import { clearAuth, getStoredAuth, loginWithOAuth } from "./auth";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new AntigravityChatProvider(context);
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("antigravity", provider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("antigravity.auth.login", async () => {
      try {
        const auth = await loginWithOAuth(context);
        const label = auth.email ? `Signed in as ${auth.email}` : "Signed in";
        void vscode.window.showInformationMessage(label);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Antigravity sign-in failed: ${message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("antigravity.auth.logout", async () => {
      await clearAuth(context);
      void vscode.window.showInformationMessage("Antigravity credentials cleared.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("antigravity.manage", async () => {
      const existing = await getStoredAuth(context);
      const items: vscode.QuickPickItem[] = existing
        ? [
            { label: "Sign Out", description: "Clear stored Antigravity tokens" },
            { label: "Re-authenticate", description: "Sign in again" },
          ]
        : [
            { label: "Sign In", description: "Start OAuth login" },
          ];

      const selection = await vscode.window.showQuickPick(items, {
        placeHolder: "Manage Antigravity authentication",
      });

      if (!selection) {
        return;
      }

      if (selection.label === "Sign Out") {
        await clearAuth(context);
        void vscode.window.showInformationMessage("Antigravity credentials cleared.");
        return;
      }

      try {
        const auth = await loginWithOAuth(context);
        const label = auth.email ? `Signed in as ${auth.email}` : "Signed in";
        void vscode.window.showInformationMessage(label);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Antigravity sign-in failed: ${message}`);
      }
    }),
  );
}

export function deactivate(): void {}
