import * as http from "node:http";
import * as vscode from "vscode";
import { authorizeAntigravity, exchangeAntigravity } from "./antigravity/oauth";
import {
  accessTokenExpired,
  parseRefreshParts,
  type OAuthAuthDetails,
} from "./antigravity/auth-helpers";
import { refreshAccessToken } from "./antigravity/token";
import { ANTIGRAVITY_REDIRECT_URI } from "./antigravity/constants";

const AUTH_SECRET_KEY = "antigravity.auth";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface StoredAuth extends OAuthAuthDetails {
  email?: string;
}

export async function getStoredAuth(
  context: vscode.ExtensionContext,
): Promise<StoredAuth | undefined> {
  const raw = await context.secrets.get(AUTH_SECRET_KEY);
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as StoredAuth;
  } catch {
    return undefined;
  }
}

async function storeAuth(context: vscode.ExtensionContext, auth: StoredAuth): Promise<void> {
  await context.secrets.store(AUTH_SECRET_KEY, JSON.stringify(auth));
}

export async function clearAuth(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(AUTH_SECRET_KEY);
}

function getRedirectPort(): number {
  try {
    const url = new URL(ANTIGRAVITY_REDIRECT_URI);
    return Number(url.port) || 51121;
  } catch {
    return 51121;
  }
}

async function waitForOAuthCallback(): Promise<{ code: string; state: string } > {
  const port = getRedirectPort();

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing callback URL");
        return;
      }

      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== "/oauth-callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body><h2>Antigravity auth complete.</h2><p>You can close this tab and return to VS Code.</p></body></html>");

      server.close();
      if (!code || !state) {
        reject(new Error("Missing OAuth code or state"));
        return;
      }

      resolve({ code, state });
    });

    server.on("error", (error) => {
      reject(error);
    });

    server.listen(port, "127.0.0.1", () => {
      const timeout = setTimeout(() => {
        server.close();
        reject(new Error("OAuth login timed out"));
      }, LOGIN_TIMEOUT_MS);

      server.once("close", () => clearTimeout(timeout));
    });
  });
}

export async function loginWithOAuth(context: vscode.ExtensionContext): Promise<StoredAuth> {
  const authorization = await authorizeAntigravity();
  const opened = await vscode.env.openExternal(vscode.Uri.parse(authorization.url));
  if (!opened) {
    throw new Error("Failed to open browser for OAuth login");
  }

  const { code, state } = await waitForOAuthCallback();
  const result = await exchangeAntigravity(code, state);

  if (result.type !== "success") {
    throw new Error(result.error || "OAuth exchange failed");
  }

  const stored: StoredAuth = {
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
    email: result.email,
  };

  await storeAuth(context, stored);
  return stored;
}

export async function ensureValidAuth(
  context: vscode.ExtensionContext,
  promptIfMissing: boolean,
): Promise<StoredAuth> {
  let auth = await getStoredAuth(context);

  if (!auth) {
    if (!promptIfMissing) {
      throw new Error("Antigravity login required");
    }

    auth = await loginWithOAuth(context);
  }

  if (accessTokenExpired(auth)) {
    const refreshed = await refreshAccessToken(auth);
    if (!refreshed) {
      throw new Error("Failed to refresh Antigravity token");
    }

    auth = { ...auth, ...refreshed };
    await storeAuth(context, auth);
  }

  if (!auth.access) {
    throw new Error("Antigravity access token missing");
  }

  return auth;
}

export function getProjectIdFromAuth(auth: StoredAuth): string | undefined {
  const parts = parseRefreshParts(auth.refresh);
  return parts.projectId || undefined;
}
