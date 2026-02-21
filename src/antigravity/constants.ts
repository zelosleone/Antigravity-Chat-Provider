export const ANTIGRAVITY_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';

export const ANTIGRAVITY_CLIENT_SECRET = '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';

export const ANTIGRAVITY_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

export const ANTIGRAVITY_REDIRECT_URI = 'http://localhost:51121/oauth-callback';

const ANTIGRAVITY_ENDPOINT_DAILY =
  'https://daily-cloudcode-pa.sandbox.googleapis.com';
const ANTIGRAVITY_ENDPOINT_AUTOPUSH =
  'https://autopush-cloudcode-pa.sandbox.googleapis.com';
const ANTIGRAVITY_ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com';

export const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
  ANTIGRAVITY_ENDPOINT_PROD,
] as const;

export const ANTIGRAVITY_LOAD_ENDPOINTS = [
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
] as const;

export const ANTIGRAVITY_ENDPOINT = ANTIGRAVITY_ENDPOINT_DAILY;
export const GEMINI_CLI_ENDPOINT = ANTIGRAVITY_ENDPOINT_PROD;
export const ANTIGRAVITY_DEFAULT_PROJECT_ID = 'rising-fact-p41fc';

export const ANTIGRAVITY_HEADERS = {
  'User-Agent': 'antigravity/1.18.4 windows/amd64',
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata':
    '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
} as const;

export const GEMINI_CLI_HEADERS = {
  'User-Agent': 'google-api-nodejs-client/9.15.1',
  'X-Goog-Api-Client': 'gl-node/22.17.0',
  'Client-Metadata':
    'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
} as const;

export type HeaderStyle = 'antigravity' | 'gemini-cli';

export const EMPTY_SCHEMA_PLACEHOLDER_NAME = '_placeholder';
export const EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION =
  'Placeholder. Always pass true.';
