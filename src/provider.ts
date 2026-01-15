import crypto from "node:crypto";
import * as vscode from "vscode";
import {
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_HEADERS,
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  GEMINI_CLI_ENDPOINT,
  GEMINI_CLI_HEADERS,
  type HeaderStyle,
} from "./antigravity/constants";
import { cleanJSONSchemaForAntigravity } from "./antigravity/request-helpers/schema-cleaning";
import { DEFAULT_THINKING_BUDGET } from "./antigravity/request-helpers/thinking";
import {
  applyClaudeTransforms,
  isClaudeModel,
  isClaudeThinkingModel,
  CLAUDE_THINKING_MAX_OUTPUT_TOKENS,
} from "./antigravity/transform/claude";
import { applyGeminiTransforms } from "./antigravity/transform/gemini";
import { resolveModelWithTier } from "./antigravity/transform/model-resolver";
import { ensureValidAuth, getProjectIdFromAuth } from "./auth";
import { MODELS } from "./models";

const STREAM_ACTION = "streamGenerateContent";
const TOOL_ENABLED_INSTRUCTION =
  "When tools are provided, use tool calls instead of describing tool use. Never claim you lack tool access or permissions.";
const TOOL_DISABLED_INSTRUCTION =
  "Do not mention tool availability or lack thereof. If tools are unavailable, respond directly without narrating tool steps.";

interface ConvertedMessages {
  contents: Array<Record<string, unknown>>;
  systemInstruction?: Record<string, unknown>;
}

interface ThoughtSignatureCache {
  text: string;
  signature: string;
}

function toTextParts(content: ReadonlyArray<vscode.LanguageModelInputPart | unknown>): string {
  return content
    .map((part) => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return part.value;
      }
      if (part && typeof part === "object" && "value" in part) {
        const value = (part as { value?: unknown }).value;
        return typeof value === "string" ? value : "";
      }
      return "";
    })
    .filter((value) => value.length > 0)
    .join("");
}

function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  signatureByCallId?: Map<string, string>,
  fallbackSignature?: string,
  allowToolHistory = true,
  allowFallbackSignature = true,
): ConvertedMessages {
  const contents: Array<Record<string, unknown>> = [];
  const systemParts: Array<{ text: string }> = [];
  const toolNameById = new Map<string, string>();

  for (const message of messages) {
    const roleValue = (message as { role: vscode.LanguageModelChatMessageRole | string }).role;
    if (roleValue === "system") {
      const text = toTextParts(message.content);
      if (text) {
        systemParts.push({ text });
      }
      continue;
    }

    const role = roleValue === vscode.LanguageModelChatMessageRole.Assistant ? "model" : "user";
    const parts: Array<Record<string, unknown>> = [];
    const toolResultParts: Array<Record<string, unknown>> = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        if (part.value) {
          parts.push({ text: part.value });
        }
        continue;
      }

      if (part instanceof vscode.LanguageModelToolCallPart) {
        if (!allowToolHistory) {
          continue;
        }
        toolNameById.set(part.callId, part.name);
        const signature = signatureByCallId?.get(part.callId)
          ?? (allowFallbackSignature ? fallbackSignature : undefined);
        parts.push({
          functionCall: {
            name: part.name,
            args: part.input ?? {},
            id: part.callId,
          },
          ...(signature ? { thoughtSignature: signature } : {}),
        });
        continue;
      }

      if (part instanceof vscode.LanguageModelToolResultPart) {
        if (!allowToolHistory) {
          continue;
        }
        const name = toolNameById.get(part.callId) ?? "tool";
        const contentText = part.content
          .map((item) => (item instanceof vscode.LanguageModelTextPart ? item.value : ""))
          .filter((value) => value.length > 0)
          .join("\n");

        const toolResponse = {
          functionResponse: {
            name,
            id: part.callId,
            response: contentText ? { content: contentText } : {},
          },
        };

        if (role === "model") {
          toolResultParts.push(toolResponse);
        } else {
          parts.push(toolResponse);
        }
        continue;
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }

    if (toolResultParts.length > 0) {
      contents.push({ role: "user", parts: toolResultParts });
    }
  }

  if (systemParts.length > 0) {
    return {
      contents,
      systemInstruction: { parts: systemParts },
    };
  }

  return { contents };
}

function hasToolHistory(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): boolean {
  for (const message of messages) {
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelToolCallPart || part instanceof vscode.LanguageModelToolResultPart) {
        return true;
      }
    }
  }
  return false;
}

function buildTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const normalizeToolSchema = (schema: unknown): Record<string, unknown> => {
    const cleaned = cleanJSONSchemaForAntigravity(schema ?? {});
    const isObject = cleaned && typeof cleaned === "object" && !Array.isArray(cleaned);
    const asRecord = isObject ? (cleaned as Record<string, unknown>) : {};

    const hasObjectType = asRecord.type === "object" || asRecord.type === undefined;
    const hasProperties = asRecord.properties
      && typeof asRecord.properties === "object"
      && Object.keys(asRecord.properties as Record<string, unknown>).length > 0;

    if (isObject && hasObjectType) {
      if (!hasProperties) {
        return {
          ...asRecord,
          type: "object",
          properties: {
            _placeholder: {
              type: "boolean",
              description: "Placeholder. Always pass true.",
            },
          },
          required: Array.isArray(asRecord.required)
            ? Array.from(new Set([...(asRecord.required as string[]), "_placeholder"]))
            : ["_placeholder"],
        };
      }
      return { ...asRecord, type: "object" };
    }

    return {
      type: "object",
      properties: {
        _placeholder: {
          type: "boolean",
          description: "Placeholder. Always pass true.",
        },
      },
      required: ["_placeholder"],
    };
  };

  const declarations = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: normalizeToolSchema(tool.inputSchema ?? {}),
  }));

  return [{ functionDeclarations: declarations }];
}

function normalizeGeminiCliSchemaTypes(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeGeminiCliSchemaTypes(item));
  }

  const record = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "type") {
      if (typeof value === "string") {
        result[key] = value.toUpperCase();
      } else if (Array.isArray(value)) {
        result[key] = value.map((entry) => (typeof entry === "string" ? entry.toUpperCase() : entry));
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
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "OBJECT", properties: {} };
  }

  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  const hasProperties = properties && typeof properties === "object" && !Array.isArray(properties);

  return {
    ...record,
    type: "OBJECT",
    properties: hasProperties ? properties : {},
  };
}

function normalizeGeminiCliToolSchemas(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.tools)) {
    return;
  }

  payload.tools = (payload.tools as Array<Record<string, unknown>>).map((tool) => {
    if (!tool || typeof tool !== "object") {
      return tool;
    }
    const fnDecls = tool.functionDeclarations;
    if (!Array.isArray(fnDecls)) {
      return tool;
    }
    const normalizedDecls = fnDecls.map((decl) => {
      if (!decl || typeof decl !== "object") {
        return decl;
      }
      const record = decl as Record<string, unknown>;
      if (record.parameters) {
        const normalized = normalizeGeminiCliSchemaTypes(record.parameters);
        record.parameters = ensureGeminiCliObjectSchema(normalized);
      } else {
        record.parameters = { type: "OBJECT", properties: {} };
      }
      return record;
    });
    return { ...tool, functionDeclarations: normalizedDecls };
  });
}

function applySystemInstruction(
  payload: Record<string, unknown>,
  systemInstruction: Record<string, unknown> | undefined,
  headerStyle: HeaderStyle,
): void {
  if (headerStyle !== "antigravity") {
    if (systemInstruction) {
      payload.systemInstruction = systemInstruction;
    }
    return;
  }

  const instructionText = systemInstruction?.parts
    ? [ANTIGRAVITY_SYSTEM_INSTRUCTION, ...((systemInstruction.parts as Array<{ text: string }>))
      .map((part) => part.text)
      .filter(Boolean)].join("\n\n")
    : ANTIGRAVITY_SYSTEM_INSTRUCTION;

  payload.systemInstruction = {
    role: "user",
    parts: [{ text: instructionText }],
  };
}

function appendSystemInstructionText(
  payload: Record<string, unknown>,
  extraText: string,
): void {
  const existing = payload.systemInstruction;
  if (typeof existing === "string") {
    payload.systemInstruction = `${existing}\n\n${extraText}`;
    return;
  }

  if (existing && typeof existing === "object") {
    const sys = existing as Record<string, unknown>;
    const partsValue = sys.parts;
    if (Array.isArray(partsValue)) {
      const parts = partsValue as Array<Record<string, unknown>>;
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const part = parts[i];
        if (typeof part.text === "string") {
          part.text = `${part.text}\n\n${extraText}`;
          return;
        }
      }
      parts.push({ text: extraText });
      return;
    }
  }

  payload.systemInstruction = { parts: [{ text: extraText }] };
}

function applyGenerationOptions(
  payload: Record<string, unknown>,
  modelOptions: { readonly [name: string]: any } | undefined,
): void {
  if (!modelOptions) {
    return;
  }

  const generationConfig = (payload.generationConfig ?? {}) as Record<string, unknown>;

  if (typeof modelOptions.temperature === "number") {
    generationConfig.temperature = modelOptions.temperature;
  }
  if (typeof modelOptions.topP === "number") {
    generationConfig.topP = modelOptions.topP;
  }
  if (typeof modelOptions.topK === "number") {
    generationConfig.topK = modelOptions.topK;
  }
  if (typeof modelOptions.maxOutputTokens === "number") {
    generationConfig.maxOutputTokens = modelOptions.maxOutputTokens;
  }
  if (Array.isArray(modelOptions.stopSequences)) {
    generationConfig.stopSequences = modelOptions.stopSequences;
  }

  payload.generationConfig = generationConfig;
}

function buildRequestPayload(
  modelId: string,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  headerStyle: HeaderStyle,
  signatureByCallId?: Map<string, string>,
  fallbackSignature?: string,
  fallbackThought?: ThoughtSignatureCache,
): Record<string, unknown> {
  const allowToolHistory = !!(options.tools && options.tools.length > 0) || hasToolHistory(messages);
  const allowFallbackSignature = isClaudeModel(modelId);
  const { contents, systemInstruction } = convertMessages(
    messages,
    signatureByCallId,
    fallbackSignature,
    allowToolHistory,
    allowFallbackSignature,
  );

  if (headerStyle === "gemini-cli") {
    enforceGeminiToolPairing(contents);
  }

  if (isClaudeThinkingModel(modelId)) {
    ensureClaudeThinkingToolHistory(contents, fallbackThought);
  }

  const payload: Record<string, unknown> = {
    contents,
  };

  const tools = buildTools(options.tools);
  if (tools) {
    payload.tools = tools;
  }

  applySystemInstruction(payload, systemInstruction, headerStyle);
  applyGenerationOptions(payload, options.modelOptions);
  if (options.tools && options.tools.length > 0) {
    appendSystemInstructionText(payload, TOOL_ENABLED_INSTRUCTION);
  } else {
    appendSystemInstructionText(payload, TOOL_DISABLED_INSTRUCTION);
  }

  if (options.toolMode === vscode.LanguageModelChatToolMode.Required && !isClaudeModel(modelId)) {
    payload.toolConfig = {
      functionCallingConfig: { mode: "ANY" },
    };
  }

  if (headerStyle === "gemini-cli") {
    normalizeGeminiCliToolSchemas(payload);
  }

  return payload;
}

function enforceGeminiToolPairing(
  contents: Array<Record<string, unknown>>,
): void {
  const normalized: Array<Record<string, unknown>> = [];
  let idx = 0;

  while (idx < contents.length) {
    const current = contents[idx];
    const parts = current?.parts as Array<Record<string, unknown>> | undefined;
    const hasToolCalls = Array.isArray(parts) && parts.some((part) => !!part.functionCall);

    if (!hasToolCalls || current.role !== "model") {
      normalized.push(current);
      idx += 1;
      continue;
    }

    const next = contents[idx + 1];
    const nextParts = next?.parts as Array<Record<string, unknown>> | undefined;

    // Extract call IDs and response IDs for ID-based matching
    const callIds = new Set<string>();
    for (const part of parts ?? []) {
      const call = part.functionCall as Record<string, unknown> | undefined;
      if (call?.id && typeof call.id === "string") {
        callIds.add(call.id);
      }
    }

    const responseIds = new Set<string>();
    for (const part of nextParts ?? []) {
      const resp = part.functionResponse as Record<string, unknown> | undefined;
      if (resp?.id && typeof resp.id === "string") {
        responseIds.add(resp.id);
      }
    }

    // Find matched IDs (calls that have corresponding responses)
    const matchedIds = new Set([...callIds].filter(id => responseIds.has(id)));

    if (matchedIds.size > 0 && next?.role === "user") {
      // Keep only matched call/response pairs by ID
      const filteredModelParts = parts!.filter((part) => {
        if (!part.functionCall) return true;
        const call = part.functionCall as Record<string, unknown>;
        return matchedIds.has(call.id as string);
      });

      const filteredUserParts = nextParts!.filter((part) => {
        if (!part.functionResponse) return true;
        const resp = part.functionResponse as Record<string, unknown>;
        return matchedIds.has(resp.id as string);
      });

      if (filteredModelParts.length > 0) {
        normalized.push({ ...current, parts: filteredModelParts });
      }
      if (filteredUserParts.length > 0) {
        normalized.push({ ...next, parts: filteredUserParts });
      }
      idx += 2;
      continue;
    }

    // No matching responses - strip all tool calls, keep other parts
    const nonToolParts = parts?.filter((part) => !part.functionCall);
    if (nonToolParts && nonToolParts.length > 0) {
      normalized.push({ ...current, parts: nonToolParts });
    }
    idx += 1;
  }

  contents.splice(0, contents.length, ...normalized);
}

function ensureClaudeThinkingToolHistory(
  contents: Array<Record<string, unknown>>,
  fallbackThought?: ThoughtSignatureCache,
): void {
  // Process ALL model messages to ensure thinking blocks come first
  for (const content of contents) {
    if (!content || typeof content !== "object" || content.role !== "model" || !Array.isArray(content.parts)) {
      continue;
    }

    const parts = content.parts as Array<Record<string, unknown>>;
    if (parts.length === 0) {
      continue;
    }

    // Check if first part is already a thinking block
    const first = parts[0];
    const isThinkingFirst = !!first && typeof first === "object" && (
      first.thought === true || first.type === "thinking" || first.type === "redacted_thinking"
    );

    // Separate thinking parts from other parts
    const thinkingParts: Array<Record<string, unknown>> = [];
    const otherParts: Array<Record<string, unknown>> = [];

    for (const part of parts) {
      const isThinking = part.thought === true || part.type === "thinking" || part.type === "redacted_thinking";
      if (isThinking) {
        thinkingParts.push(part);
      } else {
        otherParts.push(part);
      }
    }

    // If there are thinking parts but text comes first, reorder to put thinking first
    if (thinkingParts.length > 0 && !isThinkingFirst) {
      content.parts = [...thinkingParts, ...otherParts];
      continue;
    }

    // If no thinking parts but has tool calls, inject fallback thinking block
    const hasToolCalls = otherParts.some((part) => !!part.functionCall);
    if (thinkingParts.length === 0 && hasToolCalls && fallbackThought?.text && fallbackThought?.signature) {
      const thinkingPart: Record<string, unknown> = {
        thought: true,
        text: fallbackThought.text,
        thoughtSignature: fallbackThought.signature,
      };
      content.parts = [thinkingPart, ...parts];
    }
  }
}

function applyModelTransforms(
  payload: Record<string, unknown>,
  resolved: ReturnType<typeof resolveModelWithTier>,
): void {
  const normalizedThinking = resolved.isThinkingModel
    ? { includeThoughts: true, thinkingBudget: resolved.thinkingBudget ?? DEFAULT_THINKING_BUDGET }
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

function buildWrappedRequest(
  modelId: string,
  payload: Record<string, unknown>,
  projectId: string,
): Record<string, unknown> {
  return {
    project: projectId,
    model: modelId,
    request: payload,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: `agent-${crypto.randomUUID()}`,
  };
}

function buildEndpoint(action: string, headerStyle: HeaderStyle): string {
  const baseEndpoint = headerStyle === "gemini-cli" ? GEMINI_CLI_ENDPOINT : ANTIGRAVITY_ENDPOINT;
  const isStreaming = action === STREAM_ACTION;
  return `${baseEndpoint}/v1internal:${action}${isStreaming ? "?alt=sse" : ""}`;
}

function hasToolCalls(payload: Record<string, unknown>): boolean {
  if (!Array.isArray(payload.contents)) {
    return false;
  }
  return (payload.contents as Array<Record<string, unknown>>).some((content) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return false;
    }
    return (content.parts as Array<Record<string, unknown>>).some((part) => !!part.functionCall);
  });
}

function extractThoughtSignature(response: Record<string, unknown>): ThoughtSignatureCache | undefined {
  const candidates = response.candidates;
  if (!Array.isArray(candidates)) {
    return undefined;
  }

  for (const candidate of candidates) {
    const content = (candidate as Record<string, unknown>).content as Record<string, unknown> | undefined;
    if (!content || !Array.isArray(content.parts)) {
      continue;
    }

    let buffer = "";
    for (const part of content.parts as Array<Record<string, unknown>>) {
      const metadataSignature = ((part.metadata as Record<string, unknown> | undefined)?.google as Record<string, unknown> | undefined)
        ?.thoughtSignature;
      if (part.thought === true || part.type === "thinking" || part.type === "reasoning") {
        const text = typeof part.text === "string" ? part.text : typeof part.thinking === "string" ? part.thinking : "";
        if (text) {
          buffer += text;
        }
        const signature = typeof part.thoughtSignature === "string"
          ? part.thoughtSignature
          : typeof part.signature === "string"
            ? part.signature
          : typeof metadataSignature === "string"
            ? metadataSignature
            : undefined;
        if (signature) {
          const fullText = buffer || text;
          if (fullText) {
            return { text: fullText, signature };
          }
        }
      }
      if (part.functionCall && (typeof part.thoughtSignature === "string" || typeof metadataSignature === "string")) {
        const signature = typeof part.thoughtSignature === "string" ? part.thoughtSignature : (metadataSignature as string);
        return { text: buffer, signature };
      }
    }
  }

  return undefined;
}

async function warmupGeminiThinkingSignature(
  modelId: string,
  headerStyle: HeaderStyle,
  accessToken: string,
  projectId: string,
  resolved: ReturnType<typeof resolveModelWithTier>,
): Promise<ThoughtSignatureCache | undefined> {
  const payload: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: "Warmup request for thinking signature." }] }],
    generationConfig: {
      thinkingConfig: {
        includeThoughts: true,
        thinkingLevel: resolved.thinkingLevel ?? "low",
      },
    },
  };

  const wrapped = buildWrappedRequest(modelId, payload, projectId);
  const endpoint = buildEndpoint("generateContent", headerStyle);

  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  });

  const selectedHeaders = headerStyle === "gemini-cli" ? GEMINI_CLI_HEADERS : ANTIGRAVITY_HEADERS;
  headers.set("User-Agent", selectedHeaders["User-Agent"]);
  headers.set("X-Goog-Api-Client", selectedHeaders["X-Goog-Api-Client"]);
  headers.set("Client-Metadata", selectedHeaders["Client-Metadata"]);

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(wrapped),
  });

  if (!response.ok) {
    return undefined;
  }

  const json = (await response.json()) as { response?: Record<string, unknown> };
  const body = json.response ?? (json as Record<string, unknown>);
  return extractThoughtSignature(body);
}

function handleResponseParts(
  response: Record<string, unknown>,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  callIdSeed: { value: number },
  thoughtState?: { buffer: string; cache?: ThoughtSignatureCache },
  toolSignatureSink?: Map<string, string>,
): void {
  const candidates = response.candidates;
  if (!Array.isArray(candidates)) {
    return;
  }

  for (const candidate of candidates) {
    const content = (candidate as Record<string, unknown>).content as Record<string, unknown> | undefined;
    if (!content || !Array.isArray(content.parts)) {
      continue;
    }

    for (const part of content.parts as Array<Record<string, unknown>>) {
      if (part.thought === true || part.type === "thinking" || part.type === "reasoning") {
        const text = typeof part.text === "string" ? part.text : typeof part.thinking === "string" ? part.thinking : "";
        if (thoughtState && text) {
          thoughtState.buffer += text;
        }
        const metadataSignature = ((part.metadata as Record<string, unknown> | undefined)?.google as Record<string, unknown> | undefined)
          ?.thoughtSignature;
        const signature = typeof part.thoughtSignature === "string"
          ? part.thoughtSignature
          : typeof part.signature === "string"
            ? part.signature
          : typeof metadataSignature === "string"
            ? metadataSignature
            : undefined;
        if (thoughtState && signature) {
          const fullText = thoughtState.buffer || text;
          if (fullText) {
            thoughtState.cache = { text: fullText, signature };
          }
        }
        continue;
      }

      if (typeof part.text === "string") {
        progress.report(new vscode.LanguageModelTextPart(part.text));
        continue;
      }

      if (part.functionCall && typeof part.functionCall === "object") {
        const call = part.functionCall as Record<string, unknown>;
        const callId = typeof call.id === "string" && call.id
          ? call.id
          : `tool-call-${++callIdSeed.value}`;
        const name = typeof call.name === "string" ? call.name : "tool";
        const args = (call.args ?? {}) as object;

        const metadataSignature = ((part.metadata as Record<string, unknown> | undefined)?.google as Record<string, unknown> | undefined)
          ?.thoughtSignature;
        const signature = typeof part.thoughtSignature === "string"
          ? part.thoughtSignature
          : typeof part.signature === "string"
            ? part.signature
          : typeof metadataSignature === "string"
            ? metadataSignature
            : undefined;
        if (thoughtState && signature) {
          const fullText = thoughtState.buffer;
          thoughtState.cache = { text: fullText, signature };
        }

        if (signature && typeof callId === "string" && callId) {
          toolSignatureSink?.set(callId, signature);
        }

        progress.report(new vscode.LanguageModelToolCallPart(callId, name, args));
      }
    }
  }
}

async function streamResponse(
  response: Response,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken,
  thoughtCache?: { value?: ThoughtSignatureCache },
  toolSignatureSink?: Map<string, string>,
): Promise<void> {
  if (!response.body) {
    throw new Error("Missing response body");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  const callIdSeed = { value: 0 };
  const thoughtState = { buffer: "", cache: thoughtCache?.value };

  while (true) {
    if (token.isCancellationRequested) {
      return;
    }

    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }

      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }

      try {
        const parsed = JSON.parse(payload) as { response?: Record<string, unknown> };
        if (parsed.response) {
          handleResponseParts(parsed.response, progress, callIdSeed, thoughtState, toolSignatureSink);
          if (thoughtCache) {
            thoughtCache.value = thoughtState.cache ?? thoughtCache.value;
          }
        }
      } catch {
        continue;
      }
    }
  }
}

function injectCachedThinkingSignature(
  payload: Record<string, unknown>,
  cached: ThoughtSignatureCache | undefined,
): void {
  if (!cached?.signature) {
    return;
  }
  const hasThoughtText = typeof cached.text === "string" && cached.text.trim().length > 0;
  if (!hasThoughtText) {
    return;
  }

  if (!Array.isArray(payload.contents)) {
    return;
  }

  payload.contents = (payload.contents as Array<Record<string, unknown>>).map((content) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return content;
    }

    if (content.role !== "model" && content.role !== "assistant") {
      return content;
    }

    const parts = content.parts as Array<Record<string, unknown>>;
    const hasToolCall = parts.some((part) => !!part.functionCall);
    if (!hasToolCall) {
      return content;
    }

    const hasSignedThinking = parts.some(
      (part) => part.thought === true && typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0,
    );

    const injectedParts = parts.map((part) => {
      if (part.functionCall && !part.thoughtSignature) {
        return { ...part, thoughtSignature: cached.signature };
      }
      return part;
    });

    if (hasSignedThinking) {
      return { ...content, parts: injectedParts };
    }

    return {
      ...content,
      parts: [
        { thought: true, text: cached.text, thoughtSignature: cached.signature },
        ...injectedParts,
      ],
    };
  });
}

export class AntigravityChatProvider implements vscode.LanguageModelChatProvider {
  private lastThoughtSignature?: ThoughtSignatureCache;
  private toolCallSignatures = new Map<string, string>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    if (options.silent) {
      return MODELS;
    }

    try {
      await ensureValidAuth(this.context, false);
      return MODELS;
    } catch {
      const result = await vscode.window.showInformationMessage(
        "Sign in with Antigravity to enable these models.",
        "Sign In",
      );
      if (result === "Sign In") {
        await ensureValidAuth(this.context, true);
      }
      return MODELS;
    }
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const auth = await ensureValidAuth(this.context, true);
    if (!auth.access) {
      throw new Error("Antigravity access token missing");
    }
    const accessToken = auth.access;
    const projectId = getProjectIdFromAuth(auth) ?? ANTIGRAVITY_DEFAULT_PROJECT_ID;

    const resolved = resolveModelWithTier(model.id);
    const headerStyle = resolved.quotaPreference ?? "antigravity";
    const effectiveModel = resolved.actualModel;

    const payload = buildRequestPayload(
      effectiveModel,
      messages,
      options,
      headerStyle,
      this.toolCallSignatures,
      this.lastThoughtSignature?.signature,
      this.lastThoughtSignature,
    );
    applyModelTransforms(payload, resolved);

    if (isClaudeThinkingModel(effectiveModel)) {
      const generationConfig = (payload.generationConfig ?? {}) as Record<string, unknown>;
      if (typeof generationConfig.maxOutputTokens !== "number") {
        generationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS;
      }
      payload.generationConfig = generationConfig;
    }

    const isGemini3 = resolved.actualModel.toLowerCase().includes("gemini-3");
    if (isGemini3 && hasToolCalls(payload) && !this.lastThoughtSignature) {
      this.lastThoughtSignature = await warmupGeminiThinkingSignature(
        effectiveModel,
        headerStyle,
        accessToken,
        projectId,
        resolved,
      );
    }

    if (isGemini3) {
      injectCachedThinkingSignature(payload, this.lastThoughtSignature);
    }

    const wrapped = buildWrappedRequest(effectiveModel, payload, projectId);
    const endpoint = buildEndpoint(STREAM_ACTION, headerStyle);

    const headers = new Headers({
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    });
    headers.set("Accept", "text/event-stream");

    const selectedHeaders = headerStyle === "gemini-cli" ? GEMINI_CLI_HEADERS : ANTIGRAVITY_HEADERS;
    headers.set("User-Agent", selectedHeaders["User-Agent"]);
    headers.set("X-Goog-Api-Client", selectedHeaders["X-Goog-Api-Client"]);
    headers.set("Client-Metadata", selectedHeaders["Client-Metadata"]);

    const controller = new AbortController();
    const disposable = token.onCancellationRequested(() => controller.abort());

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(wrapped),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(text || `Antigravity request failed (${response.status})`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        const cacheRef = { value: this.lastThoughtSignature };
        await streamResponse(response, progress, token, cacheRef, this.toolCallSignatures);
        this.lastThoughtSignature = cacheRef.value;
        return;
      }

      const json = (await response.json()) as { response?: Record<string, unknown> };
      const body = json.response ?? (json as Record<string, unknown>);
      const thoughtState = { buffer: "", cache: this.lastThoughtSignature };
      handleResponseParts(body, progress, { value: 0 }, thoughtState, this.toolCallSignatures);
      this.lastThoughtSignature = thoughtState.cache ?? this.lastThoughtSignature;
    } finally {
      disposable.dispose();
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const value = typeof text === "string" ? text : toTextParts(text.content);
    return Math.ceil(value.length / 4);
  }
}
