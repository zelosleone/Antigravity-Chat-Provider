import crypto from 'node:crypto';
import * as vscode from 'vscode';
import {
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_HEADERS,
  GEMINI_CLI_ENDPOINT,
  GEMINI_CLI_HEADERS,
  type HeaderStyle,
} from './antigravity/constants';
import type {ResolvedModel} from './antigravity/transform/types';
import {extractPartSignature, isThinkingPart} from './antigravity/utils';
import type {ThoughtSignatureCache} from './provider-request';

export const STREAM_ACTION = 'streamGenerateContent';

type ParseResult<T> = {ok: true; value: T} | {ok: false};

function parseJson<T>(value: string): ParseResult<T> {
  try {
    return {ok: true, value: JSON.parse(value) as T};
  } catch {
    return {ok: false};
  }
}

function parseSSELineResponse(
  line: string,
): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) {
    return undefined;
  }

  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') {
    return undefined;
  }

  const parsed = parseJson<{response?: Record<string, unknown>}>(payload);
  if (!parsed.ok) {
    return undefined;
  }

  return parsed.value.response;
}

export function buildWrappedRequest(
  modelId: string,
  payload: Record<string, unknown>,
  projectId: string,
): Record<string, unknown> {
  return {
    project: projectId,
    model: modelId,
    request: payload,
    requestType: 'agent',
    userAgent: 'antigravity',
    requestId: `agent-${crypto.randomUUID()}`,
  };
}

export function buildEndpoint(
  action: string,
  headerStyle: HeaderStyle,
): string {
  const baseEndpoint =
    headerStyle === 'gemini-cli' ? GEMINI_CLI_ENDPOINT : ANTIGRAVITY_ENDPOINT;
  const isStreaming = action === STREAM_ACTION;
  return `${baseEndpoint}/v1internal:${action}${isStreaming ? '?alt=sse' : ''}`;
}

export function buildRequestHeaders(
  accessToken: string,
  headerStyle: HeaderStyle,
  accept: string,
): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: accept,
  });

  const selectedHeaders =
    headerStyle === 'gemini-cli' ? GEMINI_CLI_HEADERS : ANTIGRAVITY_HEADERS;
  headers.set('User-Agent', selectedHeaders['User-Agent']);
  headers.set('X-Goog-Api-Client', selectedHeaders['X-Goog-Api-Client']);
  headers.set('Client-Metadata', selectedHeaders['Client-Metadata']);
  return headers;
}

export function hasToolCalls(payload: Record<string, unknown>): boolean {
  if (!Array.isArray(payload.contents)) {
    return false;
  }

  return (payload.contents as Array<Record<string, unknown>>).some(content => {
    if (
      !content ||
      typeof content !== 'object' ||
      !Array.isArray(content.parts)
    ) {
      return false;
    }
    return (content.parts as Array<Record<string, unknown>>).some(
      part => !!part.functionCall,
    );
  });
}

function extractThoughtSignature(
  response: Record<string, unknown>,
): ThoughtSignatureCache | undefined {
  const candidates = response.candidates;
  if (!Array.isArray(candidates)) {
    return undefined;
  }

  for (const candidate of candidates) {
    const content = (candidate as Record<string, unknown>).content as
      | Record<string, unknown>
      | undefined;
    if (!content || !Array.isArray(content.parts)) {
      continue;
    }

    let buffer = '';
    for (const part of content.parts as Array<Record<string, unknown>>) {
      if (isThinkingPart(part)) {
        const text =
          typeof part.text === 'string'
            ? part.text
            : typeof part.thinking === 'string'
              ? part.thinking
              : '';
        if (text) buffer += text;
        const signature = extractPartSignature(part);
        if (signature) {
          const fullText = buffer || text;
          if (fullText) return {text: fullText, signature};
        }
      }
      if (part.functionCall) {
        const signature = extractPartSignature(part);
        if (signature) return {text: buffer, signature};
      }
    }
  }

  return undefined;
}

export async function warmupGeminiThinkingSignature(
  modelId: string,
  headerStyle: HeaderStyle,
  accessToken: string,
  projectId: string,
  resolved: ResolvedModel,
): Promise<ThoughtSignatureCache | undefined> {
  const payload: Record<string, unknown> = {
    contents: [
      {
        role: 'user',
        parts: [{text: 'Warmup request for thinking signature.'}],
      },
    ],
    generationConfig: {
      thinkingConfig: {
        includeThoughts: true,
        thinkingLevel: resolved.thinkingLevel ?? 'low',
      },
    },
  };

  const wrapped = buildWrappedRequest(modelId, payload, projectId);
  const endpoint = buildEndpoint('generateContent', headerStyle);
  const headers = buildRequestHeaders(
    accessToken,
    headerStyle,
    'application/json',
  );

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(wrapped),
  });

  if (!response.ok) {
    return undefined;
  }

  const json = (await response.json()) as {
    response?: Record<string, unknown>;
  };
  const body = json.response ?? (json as Record<string, unknown>);
  return extractThoughtSignature(body);
}

export function injectCachedThinkingSignature(
  payload: Record<string, unknown>,
  cached: ThoughtSignatureCache | undefined,
): void {
  if (!cached?.signature) {
    return;
  }

  const hasThoughtText =
    typeof cached.text === 'string' && cached.text.trim().length > 0;
  if (!hasThoughtText || !Array.isArray(payload.contents)) {
    return;
  }

  payload.contents = (payload.contents as Array<Record<string, unknown>>).map(
    content => {
      if (
        !content ||
        typeof content !== 'object' ||
        !Array.isArray(content.parts)
      ) {
        return content;
      }

      if (content.role !== 'model' && content.role !== 'assistant') {
        return content;
      }

      const parts = content.parts as Array<Record<string, unknown>>;
      if (!parts.some(part => !!part.functionCall)) {
        return content;
      }

      const hasSignedThinking = parts.some(
        part =>
          part.thought === true &&
          typeof part.thoughtSignature === 'string' &&
          part.thoughtSignature.length > 0,
      );

      const injectedParts = parts.map(part => {
        if (part.functionCall && !part.thoughtSignature) {
          return {...part, thoughtSignature: cached.signature};
        }
        return part;
      });

      if (hasSignedThinking) {
        return {...content, parts: injectedParts};
      }

      return {
        ...content,
        parts: [
          {
            thought: true,
            text: cached.text,
            thoughtSignature: cached.signature,
          },
          ...injectedParts,
        ],
      };
    },
  );
}

export function handleResponseParts(
  response: Record<string, unknown>,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  callIdSeed: {value: number},
  thoughtState?: {buffer: string; cache?: ThoughtSignatureCache},
  toolSignatureSink?: Map<string, string>,
): void {
  const candidates = response.candidates;
  if (!Array.isArray(candidates)) {
    return;
  }

  for (const candidate of candidates) {
    const content = (candidate as Record<string, unknown>).content as
      | Record<string, unknown>
      | undefined;
    if (!content || !Array.isArray(content.parts)) {
      continue;
    }

    for (const part of content.parts as Array<Record<string, unknown>>) {
      if (isThinkingPart(part)) {
        const text =
          typeof part.text === 'string'
            ? part.text
            : typeof part.thinking === 'string'
              ? part.thinking
              : '';
        if (thoughtState && text) thoughtState.buffer += text;
        const signature = extractPartSignature(part);
        if (thoughtState && signature) {
          const fullText = thoughtState.buffer || text;
          if (fullText) thoughtState.cache = {text: fullText, signature};
        }
        continue;
      }

      if (typeof part.text === 'string') {
        progress.report(new vscode.LanguageModelTextPart(part.text));
        continue;
      }

      if (part.functionCall && typeof part.functionCall === 'object') {
        const call = part.functionCall as Record<string, unknown>;
        const callId =
          typeof call.id === 'string' && call.id
            ? call.id
            : `tool-call-${++callIdSeed.value}`;
        const name = typeof call.name === 'string' ? call.name : 'tool';
        const args = (call.args ?? {}) as object;

        const signature = extractPartSignature(part);
        if (thoughtState && signature) {
          thoughtState.cache = {text: thoughtState.buffer, signature};
        }
        if (signature && callId) {
          toolSignatureSink?.set(callId, signature);
        }

        progress.report(
          new vscode.LanguageModelToolCallPart(callId, name, args),
        );
      }
    }
  }
}

export async function streamResponse(
  response: Response,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken,
  thoughtCache?: {value?: ThoughtSignatureCache},
  toolSignatureSink?: Map<string, string>,
): Promise<void> {
  if (!response.body) {
    throw new Error('Missing response body');
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  const callIdSeed = {value: 0};
  const thoughtState = {buffer: '', cache: thoughtCache?.value};

  while (true) {
    if (token.isCancellationRequested) {
      return;
    }

    const {done, value} = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, {stream: true});
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const responsePayload = parseSSELineResponse(line);
      if (!responsePayload) {
        continue;
      }

      handleResponseParts(
        responsePayload,
        progress,
        callIdSeed,
        thoughtState,
        toolSignatureSink,
      );
      if (thoughtCache) {
        thoughtCache.value = thoughtState.cache ?? thoughtCache.value;
      }
    }
  }
}
