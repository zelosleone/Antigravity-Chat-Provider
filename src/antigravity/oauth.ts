import crypto from 'node:crypto';

import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_LOAD_ENDPOINTS,
  ANTIGRAVITY_HEADERS,
} from './constants';
import {calculateTokenExpiry} from './auth-helpers';

interface PkcePair {
  challenge: string;
  verifier: string;
}

function generatePKCE(): PkcePair {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest()
    .toString('base64url');
  return {verifier, challenge};
}

interface AntigravityAuthState {
  verifier: string;
  projectId: string;
}

export interface AntigravityAuthorization {
  url: string;
  verifier: string;
  projectId: string;
}

interface AntigravityTokenExchangeSuccess {
  type: 'success';
  refresh: string;
  access: string;
  expires: number;
  email?: string;
  projectId: string;
}

interface AntigravityTokenExchangeFailure {
  type: 'failed';
  error: string;
}

export type AntigravityTokenExchangeResult =
  | AntigravityTokenExchangeSuccess
  | AntigravityTokenExchangeFailure;

interface AntigravityTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

interface AntigravityUserInfo {
  email?: string;
}

type Result<T> = {ok: true; value: T} | {ok: false; error: string};

type AsyncResult<T> = {ok: true; value: T} | {ok: false; error: unknown};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson<T>(value: string): Result<T> {
  try {
    return {ok: true, value: JSON.parse(value) as T};
  } catch (error) {
    return {ok: false, error: toErrorMessage(error)};
  }
}

async function settle<T>(promise: Promise<T>): Promise<AsyncResult<T>> {
  return promise.then(
    value => ({ok: true, value}),
    error => ({ok: false, error}),
  );
}

async function readResponseText(response: Response): Promise<string> {
  return response.text().then(
    text => text,
    () => '',
  );
}

function encodeState(payload: AntigravityAuthState): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeState(state: string): Result<AntigravityAuthState> {
  const normalized = state.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  );
  const json = Buffer.from(padded, 'base64').toString('utf8');
  const parsed = parseJson<Record<string, unknown>>(json);
  if (!parsed.ok) {
    return {ok: false, error: `Invalid OAuth state payload: ${parsed.error}`};
  }
  if (typeof parsed.value.verifier !== 'string') {
    return {ok: false, error: 'Missing PKCE verifier in state'};
  }

  return {
    ok: true,
    value: {
      verifier: parsed.value.verifier,
      projectId:
        typeof parsed.value.projectId === 'string'
          ? parsed.value.projectId
          : '',
    },
  };
}

export async function authorizeAntigravity(
  projectId = '',
): Promise<AntigravityAuthorization> {
  const pkce = generatePKCE();

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', ANTIGRAVITY_REDIRECT_URI);
  url.searchParams.set('scope', ANTIGRAVITY_SCOPES.join(' '));
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set(
    'state',
    encodeState({verifier: pkce.verifier, projectId: projectId || ''}),
  );
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');

  return {
    url: url.toString(),
    verifier: pkce.verifier,
    projectId: projectId || '',
  };
}

const FETCH_TIMEOUT_MS = 10000;

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {...options, signal: controller.signal}).finally(() =>
    clearTimeout(timeout),
  );
}

function extractProjectId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  const record = data as Record<string, unknown>;
  if (
    typeof record.cloudaicompanionProject === 'string' &&
    record.cloudaicompanionProject
  ) {
    return record.cloudaicompanionProject;
  }

  if (
    record.cloudaicompanionProject &&
    typeof record.cloudaicompanionProject === 'object' &&
    typeof (record.cloudaicompanionProject as {id?: unknown}).id === 'string' &&
    (record.cloudaicompanionProject as {id: string}).id
  ) {
    return (record.cloudaicompanionProject as {id: string}).id;
  }

  return undefined;
}

async function fetchProjectID(accessToken: string): Promise<string> {
  const errors: string[] = [];
  const loadHeaders: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'google-api-nodejs-client/9.15.1',
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': ANTIGRAVITY_HEADERS['Client-Metadata'],
  };

  const loadEndpoints = Array.from(
    new Set<string>([
      ...ANTIGRAVITY_LOAD_ENDPOINTS,
      ...ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ]),
  );

  for (const baseEndpoint of loadEndpoints) {
    const url = `${baseEndpoint}/v1internal:loadCodeAssist`;
    const responseResult = await settle(
      fetchWithTimeout(url, {
        method: 'POST',
        headers: loadHeaders,
        body: JSON.stringify({
          metadata: {
            ideType: 'IDE_UNSPECIFIED',
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI',
          },
        }),
      }),
    );

    if (!responseResult.ok) {
      errors.push(
        `loadCodeAssist error at ${baseEndpoint}: ${toErrorMessage(responseResult.error)}`,
      );
      continue;
    }

    const response = responseResult.value;
    if (!response.ok) {
      const message = await readResponseText(response);
      errors.push(
        `loadCodeAssist ${response.status} at ${baseEndpoint}${
          message ? `: ${message}` : ''
        }`,
      );
      continue;
    }

    const dataResult = await settle(response.json());
    if (!dataResult.ok) {
      errors.push(
        `loadCodeAssist invalid JSON at ${baseEndpoint}: ${toErrorMessage(dataResult.error)}`,
      );
      continue;
    }

    const projectId = extractProjectId(dataResult.value);
    if (projectId) {
      return projectId;
    }

    errors.push(`loadCodeAssist missing project id at ${baseEndpoint}`);
  }

  if (errors.length) {
    console.warn('Failed to resolve Antigravity project via loadCodeAssist', {
      errors: errors.join('; '),
    });
  }
  return '';
}

export async function exchangeAntigravity(
  code: string,
  state: string,
): Promise<AntigravityTokenExchangeResult> {
  const decodedState = decodeState(state);
  if (!decodedState.ok) {
    return {type: 'failed', error: decodedState.error};
  }

  const {verifier, projectId} = decodedState.value;
  const startTime = Date.now();

  const tokenResponseResult = await settle(
    fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: ANTIGRAVITY_REDIRECT_URI,
        code_verifier: verifier,
      }),
    }),
  );

  if (!tokenResponseResult.ok) {
    return {type: 'failed', error: toErrorMessage(tokenResponseResult.error)};
  }

  const tokenResponse = tokenResponseResult.value;
  if (!tokenResponse.ok) {
    const errorText = await readResponseText(tokenResponse);
    return {
      type: 'failed',
      error: errorText || `Token exchange failed (${tokenResponse.status})`,
    };
  }

  const tokenPayloadResult = await settle(
    tokenResponse.json() as Promise<AntigravityTokenResponse>,
  );
  if (!tokenPayloadResult.ok) {
    return {
      type: 'failed',
      error: `Invalid token response: ${toErrorMessage(tokenPayloadResult.error)}`,
    };
  }

  const tokenPayload = tokenPayloadResult.value;
  const userInfoResponseResult = await settle(
    fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`,
      },
    }),
  );
  if (!userInfoResponseResult.ok) {
    return {
      type: 'failed',
      error: toErrorMessage(userInfoResponseResult.error),
    };
  }

  const userInfoResponse = userInfoResponseResult.value;
  let userInfo: AntigravityUserInfo = {};
  if (userInfoResponse.ok) {
    const userInfoResult = await settle(
      userInfoResponse.json() as Promise<AntigravityUserInfo>,
    );
    if (!userInfoResult.ok) {
      return {
        type: 'failed',
        error: `Invalid user info response: ${toErrorMessage(userInfoResult.error)}`,
      };
    }
    userInfo = userInfoResult.value;
  }

  const refreshToken = tokenPayload.refresh_token;
  if (!refreshToken) {
    return {type: 'failed', error: 'Missing refresh token in response'};
  }

  let effectiveProjectId = projectId;
  if (!effectiveProjectId) {
    effectiveProjectId = await fetchProjectID(tokenPayload.access_token);
  }

  const storedRefresh = `${refreshToken}|${effectiveProjectId || ''}`;

  return {
    type: 'success',
    refresh: storedRefresh,
    access: tokenPayload.access_token,
    expires: calculateTokenExpiry(startTime, tokenPayload.expires_in),
    email: userInfo.email,
    projectId: effectiveProjectId || '',
  };
}
