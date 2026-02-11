import {ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET} from './constants';
import {
  calculateTokenExpiry,
  formatRefreshParts,
  parseRefreshParts,
} from './auth-helpers';
import type {OAuthAuthDetails, RefreshParts} from './auth-helpers';

interface OAuthErrorPayload {
  error?:
    | string
    | {
        code?: string;
        status?: string;
        message?: string;
      };
  error_description?: string;
}

type ParseResult<T> = {ok: true; value: T} | {ok: false};

function parseJson<T>(value: string): ParseResult<T> {
  try {
    return {ok: true, value: JSON.parse(value) as T};
  } catch {
    return {ok: false};
  }
}

async function readResponseText(
  response: Response,
): Promise<string | undefined> {
  return response.text().then(
    text => text,
    () => undefined,
  );
}

function parseOAuthErrorPayload(text: string | undefined): {
  code?: string;
  description?: string;
} {
  if (!text) {
    return {};
  }

  const parsed = parseJson<OAuthErrorPayload>(text);
  if (!parsed.ok) {
    return {description: text};
  }

  const payload = parsed.value;
  if (!payload || typeof payload !== 'object') {
    return {description: text};
  }

  let code: string | undefined;
  if (typeof payload.error === 'string') {
    code = payload.error;
  } else if (payload.error && typeof payload.error === 'object') {
    code = payload.error.status ?? payload.error.code;
    if (!payload.error_description && payload.error.message) {
      return {code, description: payload.error.message};
    }
  }

  const description = payload.error_description;
  if (description) {
    return {code, description};
  }

  if (
    payload.error &&
    typeof payload.error === 'object' &&
    payload.error.message
  ) {
    return {code, description: payload.error.message};
  }

  return {code};
}

class AntigravityTokenRefreshError extends Error {
  code?: string;
  description?: string;
  status: number;
  statusText: string;

  constructor(options: {
    message: string;
    code?: string;
    description?: string;
    status: number;
    statusText: string;
  }) {
    super(options.message);
    this.name = 'AntigravityTokenRefreshError';
    this.code = options.code;
    this.description = options.description;
    this.status = options.status;
    this.statusText = options.statusText;
  }
}

export async function refreshAccessToken(
  auth: OAuthAuthDetails,
): Promise<OAuthAuthDetails | undefined> {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  const startTime = Date.now();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: parts.refreshToken,
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const errorText = await readResponseText(response);
    const {code, description} = parseOAuthErrorPayload(errorText);
    const details = [code, description ?? errorText].filter(Boolean).join(': ');
    const baseMessage = `Antigravity token refresh failed (${response.status} ${response.statusText})`;
    const message = details ? `${baseMessage} - ${details}` : baseMessage;

    throw new AntigravityTokenRefreshError({
      message,
      code,
      description: description ?? errorText,
      status: response.status,
      statusText: response.statusText,
    });
  }

  const payload = (await response.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  const refreshedParts: RefreshParts = {
    refreshToken: payload.refresh_token ?? parts.refreshToken,
    projectId: parts.projectId,
    managedProjectId: parts.managedProjectId,
  };

  return {
    ...auth,
    access: payload.access_token,
    expires: calculateTokenExpiry(startTime, payload.expires_in),
    refresh: formatRefreshParts(refreshedParts),
  };
}
