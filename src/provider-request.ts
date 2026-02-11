import * as vscode from 'vscode';
import type {HeaderStyle} from './antigravity/constants';
import {cleanJSONSchemaForAntigravity} from './antigravity/request-helpers/schema-cleaning';
import {
  applyClaudeTransforms,
  isClaudeModel,
  isClaudeThinkingModel,
} from './antigravity/transform/claude';
import {applyGeminiTransforms} from './antigravity/transform/gemini';
import type {ResolvedModel} from './antigravity/transform/types';
import {ensureObjectSchema, isThinkingPart} from './antigravity/utils';

const DEFAULT_THINKING_BUDGET = 16000;

export interface ThoughtSignatureCache {
  text: string;
  signature: string;
}

export function toTextParts(
  content: ReadonlyArray<vscode.LanguageModelInputPart | unknown>,
): string {
  return content
    .map(part => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return part.value;
      }
      if (part && typeof part === 'object' && 'value' in part) {
        const value = (part as {value?: unknown}).value;
        return typeof value === 'string' ? value : '';
      }
      return '';
    })
    .filter(value => value.length > 0)
    .join('');
}

interface ConvertedMessages {
  contents: Array<Record<string, unknown>>;
  systemInstruction?: Record<string, unknown>;
}

function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  signatureByCallId?: Map<string, string>,
  fallbackSignature?: string,
  allowToolHistory = true,
  allowFallbackSignature = true,
): ConvertedMessages {
  const contents: Array<Record<string, unknown>> = [];
  const systemParts: Array<{text: string}> = [];
  const toolNameById = new Map<string, string>();

  for (const message of messages) {
    const roleValue = (
      message as {role: vscode.LanguageModelChatMessageRole | string}
    ).role;
    if (roleValue === 'system') {
      const text = toTextParts(message.content);
      if (text) {
        systemParts.push({text});
      }
      continue;
    }

    const role =
      roleValue === vscode.LanguageModelChatMessageRole.Assistant
        ? 'model'
        : 'user';
    const parts: Array<Record<string, unknown>> = [];
    const toolResultParts: Array<Record<string, unknown>> = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        if (part.value) {
          parts.push({text: part.value});
        }
        continue;
      }

      if (part instanceof vscode.LanguageModelToolCallPart) {
        if (!allowToolHistory) {
          continue;
        }
        toolNameById.set(part.callId, part.name);
        const signature =
          signatureByCallId?.get(part.callId) ??
          (allowFallbackSignature ? fallbackSignature : undefined);
        parts.push({
          functionCall: {
            name: part.name,
            args: part.input ?? {},
            id: part.callId,
          },
          ...(signature ? {thoughtSignature: signature} : {}),
        });
        continue;
      }

      if (part instanceof vscode.LanguageModelToolResultPart) {
        if (!allowToolHistory) {
          continue;
        }
        const name = toolNameById.get(part.callId) ?? 'tool';
        const contentText = part.content
          .map(item =>
            item instanceof vscode.LanguageModelTextPart ? item.value : '',
          )
          .filter(value => value.length > 0)
          .join('\n');

        const toolResponse = {
          functionResponse: {
            name,
            id: part.callId,
            response: contentText ? {content: contentText} : {},
          },
        };

        if (role === 'model') {
          toolResultParts.push(toolResponse);
        } else {
          parts.push(toolResponse);
        }
        continue;
      }
    }

    if (parts.length > 0) {
      contents.push({role, parts});
    }

    if (toolResultParts.length > 0) {
      contents.push({role: 'user', parts: toolResultParts});
    }
  }

  if (systemParts.length > 0) {
    return {
      contents,
      systemInstruction: {parts: systemParts},
    };
  }

  return {contents};
}

function hasToolHistory(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): boolean {
  for (const message of messages) {
    for (const part of message.content) {
      if (
        part instanceof vscode.LanguageModelToolCallPart ||
        part instanceof vscode.LanguageModelToolResultPart
      ) {
        return true;
      }
    }
  }
  return false;
}

function enforceGeminiToolPairing(
  contents: Array<Record<string, unknown>>,
): void {
  const normalized: Array<Record<string, unknown>> = [];
  let idx = 0;

  while (idx < contents.length) {
    const current = contents[idx];
    const parts = current?.parts as Array<Record<string, unknown>> | undefined;
    const hasToolCalls =
      Array.isArray(parts) && parts.some(part => !!part.functionCall);

    if (!hasToolCalls || current.role !== 'model') {
      normalized.push(current);
      idx += 1;
      continue;
    }

    const next = contents[idx + 1];
    const nextParts = next?.parts as Array<Record<string, unknown>> | undefined;

    const callIds = new Set<string>();
    for (const part of parts ?? []) {
      const call = part.functionCall as Record<string, unknown> | undefined;
      if (call?.id && typeof call.id === 'string') {
        callIds.add(call.id);
      }
    }

    const responseIds = new Set<string>();
    for (const part of nextParts ?? []) {
      const resp = part.functionResponse as Record<string, unknown> | undefined;
      if (resp?.id && typeof resp.id === 'string') {
        responseIds.add(resp.id);
      }
    }

    const matchedIds = new Set([...callIds].filter(id => responseIds.has(id)));

    if (matchedIds.size > 0 && next?.role === 'user') {
      const filteredModelParts = parts!.filter(part => {
        if (!part.functionCall) {
          return true;
        }
        const call = part.functionCall as Record<string, unknown>;
        return matchedIds.has(call.id as string);
      });

      const filteredUserParts = nextParts!.filter(part => {
        if (!part.functionResponse) {
          return true;
        }
        const resp = part.functionResponse as Record<string, unknown>;
        return matchedIds.has(resp.id as string);
      });

      if (filteredModelParts.length > 0) {
        normalized.push({...current, parts: filteredModelParts});
      }
      if (filteredUserParts.length > 0) {
        normalized.push({...next, parts: filteredUserParts});
      }
      idx += 2;
      continue;
    }

    const nonToolParts = parts?.filter(part => !part.functionCall);
    if (nonToolParts && nonToolParts.length > 0) {
      normalized.push({...current, parts: nonToolParts});
    }
    idx += 1;
  }

  contents.splice(0, contents.length, ...normalized);
}

function ensureClaudeThinkingToolHistory(
  contents: Array<Record<string, unknown>>,
  fallbackThought?: ThoughtSignatureCache,
): void {
  for (const content of contents) {
    if (
      !content ||
      typeof content !== 'object' ||
      content.role !== 'model' ||
      !Array.isArray(content.parts)
    ) {
      continue;
    }

    const parts = content.parts as Array<Record<string, unknown>>;
    if (parts.length === 0) {
      continue;
    }

    const first = parts[0];
    const isThinkingFirst =
      !!first && typeof first === 'object' && isThinkingPart(first);

    const thinkingParts: Array<Record<string, unknown>> = [];
    const otherParts: Array<Record<string, unknown>> = [];

    for (const part of parts) {
      if (isThinkingPart(part)) {
        thinkingParts.push(part);
      } else {
        otherParts.push(part);
      }
    }

    if (thinkingParts.length > 0 && !isThinkingFirst) {
      content.parts = [...thinkingParts, ...otherParts];
      continue;
    }

    const hasToolCalls = otherParts.some(part => !!part.functionCall);
    if (
      thinkingParts.length === 0 &&
      hasToolCalls &&
      fallbackThought?.text &&
      fallbackThought?.signature
    ) {
      content.parts = [
        {
          thought: true,
          text: fallbackThought.text,
          thoughtSignature: fallbackThought.signature,
        },
        ...parts,
      ];
    }
  }
}

function buildTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const declarations = tools.map(tool => ({
    name: tool.name,
    description: tool.description ?? '',
    parameters: ensureObjectSchema(
      tool.inputSchema ?? {},
      cleanJSONSchemaForAntigravity,
    ),
  }));

  return [{functionDeclarations: declarations}];
}

function normalizeGeminiCliSchemaTypes(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map(item => normalizeGeminiCliSchemaTypes(item));
  }

  const record = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'type') {
      if (typeof value === 'string') {
        result[key] = value.toUpperCase();
      } else if (Array.isArray(value)) {
        result[key] = value.map(entry =>
          typeof entry === 'string' ? entry.toUpperCase() : entry,
        );
      } else {
        result[key] = value;
      }
      continue;
    }
    result[key] = normalizeGeminiCliSchemaTypes(value);
  }
  return result;
}

function ensureGeminiCliObjectSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return {type: 'OBJECT', properties: {}};
  }

  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  const hasProperties =
    properties && typeof properties === 'object' && !Array.isArray(properties);

  return {
    ...record,
    type: 'OBJECT',
    properties: hasProperties ? properties : {},
  };
}

function normalizeGeminiCliToolSchemas(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.tools)) return;

  for (const tool of payload.tools as Array<Record<string, unknown>>) {
    if (
      !tool ||
      typeof tool !== 'object' ||
      !Array.isArray(tool.functionDeclarations)
    )
      continue;
    for (const decl of tool.functionDeclarations as Array<
      Record<string, unknown>
    >) {
      if (!decl || typeof decl !== 'object') continue;
      decl.parameters = decl.parameters
        ? ensureGeminiCliObjectSchema(
            normalizeGeminiCliSchemaTypes(decl.parameters),
          )
        : {type: 'OBJECT', properties: {}};
    }
  }
}

function applySystemInstruction(
  payload: Record<string, unknown>,
  systemInstruction: Record<string, unknown> | undefined,
  headerStyle: HeaderStyle,
): void {
  if (!systemInstruction) {
    return;
  }

  if (headerStyle !== 'antigravity') {
    payload.systemInstruction = systemInstruction;
    return;
  }

  const parts = Array.isArray(systemInstruction.parts)
    ? systemInstruction.parts
    : undefined;
  if (!parts) {
    payload.systemInstruction = systemInstruction;
    return;
  }

  payload.systemInstruction = {role: 'user', parts};
}

function applyGenerationOptions(
  payload: Record<string, unknown>,
  modelOptions: Readonly<Record<string, unknown>> | undefined,
): void {
  if (!modelOptions) return;

  const generationConfig = (payload.generationConfig ?? {}) as Record<
    string,
    unknown
  >;

  for (const key of [
    'temperature',
    'topP',
    'topK',
    'maxOutputTokens',
  ] as const) {
    if (typeof modelOptions[key] === 'number')
      generationConfig[key] = modelOptions[key];
  }
  if (Array.isArray(modelOptions.stopSequences)) {
    generationConfig.stopSequences = modelOptions.stopSequences;
  }

  payload.generationConfig = generationConfig;
}

export function buildRequestPayload(
  modelId: string,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  headerStyle: HeaderStyle,
  signatureByCallId?: Map<string, string>,
  fallbackSignature?: string,
  fallbackThought?: ThoughtSignatureCache,
): Record<string, unknown> {
  const allowToolHistory =
    !!(options.tools && options.tools.length > 0) || hasToolHistory(messages);
  const allowFallbackSignature = isClaudeModel(modelId);
  const {contents, systemInstruction} = convertMessages(
    messages,
    signatureByCallId,
    fallbackSignature,
    allowToolHistory,
    allowFallbackSignature,
  );

  if (headerStyle === 'gemini-cli') {
    enforceGeminiToolPairing(contents);
  }

  if (isClaudeThinkingModel(modelId)) {
    ensureClaudeThinkingToolHistory(contents, fallbackThought);
  }

  const payload: Record<string, unknown> = {contents};

  const tools = buildTools(options.tools);
  if (tools) {
    payload.tools = tools;
  }

  applySystemInstruction(payload, systemInstruction, headerStyle);
  applyGenerationOptions(payload, options.modelOptions);

  if (
    options.toolMode === vscode.LanguageModelChatToolMode.Required &&
    !isClaudeModel(modelId)
  ) {
    payload.toolConfig = {
      functionCallingConfig: {mode: 'ANY'},
    };
  }

  if (headerStyle === 'gemini-cli') {
    normalizeGeminiCliToolSchemas(payload);
  }

  return payload;
}

export function applyModelTransforms(
  payload: Record<string, unknown>,
  resolved: ResolvedModel,
): void {
  const normalizedThinking = resolved.isThinkingModel
    ? {
        includeThoughts: true,
        thinkingBudget: resolved.thinkingBudget ?? DEFAULT_THINKING_BUDGET,
      }
    : undefined;

  if (isClaudeModel(resolved.actualModel)) {
    applyClaudeTransforms(payload, {
      model: resolved.actualModel,
      tierThinkingBudget: resolved.thinkingBudget,
      normalizedThinking,
      cleanJSONSchema: cleanJSONSchemaForAntigravity,
    });
    return;
  }

  applyGeminiTransforms(payload, {
    model: resolved.actualModel,
    tierThinkingBudget: resolved.thinkingBudget,
    tierThinkingLevel: resolved.thinkingLevel,
    normalizedThinking,
  });
}
