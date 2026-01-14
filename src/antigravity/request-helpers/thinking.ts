import { recursivelyParseJsonStrings } from "./json";
import { ThinkingConfig } from "./types";

/**
 * Default token budget for thinking/reasoning. 16000 tokens provides sufficient
 * space for complex reasoning while staying within typical model limits.
 */
export const DEFAULT_THINKING_BUDGET = 16000;

/**
 * Checks if a model name indicates thinking/reasoning capability.
 * Models with "thinking", "gemini-3", or "opus" in their name support extended thinking.
 */
function isThinkingCapableModel(modelName: string): boolean {
  const lowerModel = modelName.toLowerCase();
  return lowerModel.includes("thinking")
    || lowerModel.includes("gemini-3")
    || lowerModel.includes("opus");
}

/**
 * Extracts thinking configuration from various possible request locations.
 * Supports both Gemini-style thinkingConfig and Anthropic-style thinking options.
 */
function extractThinkingConfig(
  requestPayload: Record<string, unknown>,
  rawGenerationConfig: Record<string, unknown> | undefined,
  extraBody: Record<string, unknown> | undefined,
): ThinkingConfig | undefined {
  const thinkingConfig = rawGenerationConfig?.thinkingConfig
    ?? extraBody?.thinkingConfig
    ?? requestPayload.thinkingConfig;

  if (thinkingConfig && typeof thinkingConfig === "object") {
    const config = thinkingConfig as Record<string, unknown>;
    return {
      includeThoughts: Boolean(config.includeThoughts),
      thinkingBudget: typeof config.thinkingBudget === "number" ? config.thinkingBudget : DEFAULT_THINKING_BUDGET,
    };
  }

  // Convert Anthropic-style "thinking" option: { type: "enabled", budgetTokens: N }
  const anthropicThinking = extraBody?.thinking ?? requestPayload.thinking;
  if (anthropicThinking && typeof anthropicThinking === "object") {
    const thinking = anthropicThinking as Record<string, unknown>;
    if (thinking.type === "enabled" || thinking.budgetTokens) {
      return {
        includeThoughts: true,
        thinkingBudget: typeof thinking.budgetTokens === "number" ? thinking.budgetTokens : DEFAULT_THINKING_BUDGET,
      };
    }
  }

  return undefined;
}

/**
 * Variant thinking config extracted from OpenCode's providerOptions.
 */
interface VariantThinkingConfig {
  /** Gemini 3 native thinking level (low/medium/high) */
  thinkingLevel?: string;
  /** Numeric thinking budget for Claude and Gemini 2.5 */
  thinkingBudget?: number;
  /** Whether to include thoughts in output */
  includeThoughts?: boolean;
}

/**
 * Extracts variant thinking config from OpenCode's providerOptions.
 * 
 * All Antigravity models route through the Google provider, so we only check
 * providerOptions.google. Supports two formats:
 * 
 * 1. Gemini 3 native: { google: { thinkingLevel: "high", includeThoughts: true } }
 * 2. Budget-based (Claude/Gemini 2.5): { google: { thinkingConfig: { thinkingBudget: 32000 } } }
 */
function extractVariantThinkingConfig(
  providerOptions: Record<string, unknown> | undefined
): VariantThinkingConfig | undefined {
  if (!providerOptions) return undefined;

  const google = providerOptions.google as Record<string, unknown> | undefined;
  if (!google) return undefined;

  // Gemini 3 native format: { google: { thinkingLevel: "high", includeThoughts: true } }
  if (typeof google.thinkingLevel === "string") {
    return {
      thinkingLevel: google.thinkingLevel,
      includeThoughts: typeof google.includeThoughts === "boolean" ? google.includeThoughts : undefined,
    };
  }

  // Budget-based format (Claude/Gemini 2.5): { google: { thinkingConfig: { thinkingBudget } } }
  if (google.thinkingConfig && typeof google.thinkingConfig === "object") {
    const tc = google.thinkingConfig as Record<string, unknown>;
    if (typeof tc.thinkingBudget === "number") {
      return { thinkingBudget: tc.thinkingBudget };
    }
  }

  return undefined;
}

/**
 * Determines the final thinking configuration based on model capabilities and user settings.
 * For Claude thinking models, we keep thinking enabled even in multi-turn conversations.
 * The filterUnsignedThinkingBlocks function will handle signature validation/restoration.
 */
function resolveThinkingConfig(
  userConfig: ThinkingConfig | undefined,
  isThinkingModel: boolean,
  _isClaudeModel: boolean,
  _hasAssistantHistory: boolean,
): ThinkingConfig | undefined {
  // For thinking-capable models (including Claude thinking models), enable thinking by default
  // The signature validation/restoration is handled by filterUnsignedThinkingBlocks
  if (isThinkingModel && !userConfig) {
    return { includeThoughts: true, thinkingBudget: DEFAULT_THINKING_BUDGET };
  }

  return userConfig;
}

/**
 * Checks if a part is a thinking/reasoning block (Anthropic or Gemini style).
 */
function isThinkingPart(part: Record<string, unknown>): boolean {
  return part.type === "thinking"
    || part.type === "redacted_thinking"
    || part.type === "reasoning"
    || part.thinking !== undefined
    || part.thought === true;
}

/**
 * Checks if a part has a signature field (thinking block signature).
 * Used to detect foreign thinking blocks that might have unknown type values.
 */
function hasSignatureField(part: Record<string, unknown>): boolean {
  return part.signature !== undefined || part.thoughtSignature !== undefined;
}

/**
 * Checks if a part is a tool block (tool_use or tool_result).
 * Tool blocks must never be filtered - they're required for tool call/result pairing.
 * Handles multiple formats:
 * - Anthropic: { type: "tool_use" }, { type: "tool_result", tool_use_id }
 * - Nested: { tool_result: { tool_use_id } }, { tool_use: { id } }
 * - Gemini: { functionCall }, { functionResponse }
 */
function isToolBlock(part: Record<string, unknown>): boolean {
  return part.type === "tool_use"
    || part.type === "tool_result"
    || part.tool_use_id !== undefined
    || part.tool_call_id !== undefined
    || part.tool_result !== undefined
    || part.tool_use !== undefined
    || part.toolUse !== undefined
    || part.functionCall !== undefined
    || part.functionResponse !== undefined;
}

/**
 * Unconditionally strips ALL thinking/reasoning blocks from a content array.
 * Used for Claude models to avoid signature validation errors entirely.
 * Claude will generate fresh thinking for each turn.
 */
function stripAllThinkingBlocks(contentArray: any[]): any[] {
  return contentArray.filter(item => {
    if (!item || typeof item !== "object") return true;
    if (isToolBlock(item)) return true;
    if (isThinkingPart(item)) return false;
    if (hasSignatureField(item)) return false;
    return true;
  });
}

/**
 * Removes trailing thinking blocks from a content array.
 * Claude API requires that assistant messages don't end with thinking blocks.
 * Only removes unsigned thinking blocks; preserves those with valid signatures.
 */
function removeTrailingThinkingBlocks(
  contentArray: any[],
  sessionId?: string,
  getCachedSignatureFn?: (sessionId: string, text: string) => string | undefined,
): any[] {
  const result = [...contentArray];

  while (result.length > 0 && isThinkingPart(result[result.length - 1])) {
    const part = result[result.length - 1];
    const isValid = sessionId && getCachedSignatureFn
      ? isOurCachedSignature(part as Record<string, unknown>, sessionId, getCachedSignatureFn)
      : hasValidSignature(part as Record<string, unknown>);
    if (isValid) {
      break;
    }
    result.pop();
  }

  return result;
}

/**
 * Checks if a thinking part has a valid signature.
 * A valid signature is a non-empty string with at least 50 characters.
 */
function hasValidSignature(part: Record<string, unknown>): boolean {
  const signature = part.thought === true ? part.thoughtSignature : part.signature;
  return typeof signature === "string" && signature.length >= 50;
}

/**
 * Gets the signature from a thinking part, if present.
 */
function getSignature(part: Record<string, unknown>): string | undefined {
  const signature = part.thought === true ? part.thoughtSignature : part.signature;
  return typeof signature === "string" ? signature : undefined;
}

/**
 * Checks if a thinking part's signature was generated by our plugin (exists in our cache).
 * This prevents accepting signatures from other providers (e.g., direct Anthropic API, OpenAI)
 * which would cause "Invalid signature" errors when sent to Antigravity Claude.
 */
function isOurCachedSignature(
  part: Record<string, unknown>,
  sessionId: string | undefined,
  getCachedSignatureFn: ((sessionId: string, text: string) => string | undefined) | undefined,
): boolean {
  if (!sessionId || !getCachedSignatureFn) {
    return false;
  }

  const text = getThinkingText(part);
  if (!text) {
    return false;
  }

  const partSignature = getSignature(part);
  if (!partSignature) {
    return false;
  }

  const cachedSignature = getCachedSignatureFn(sessionId, text);
  return cachedSignature === partSignature;
}

/**
 * Gets the text content from a thinking part.
 */
function getThinkingText(part: Record<string, unknown>): string {
  if (typeof part.text === "string") return part.text;
  if (typeof part.thinking === "string") return part.thinking;

  if (part.text && typeof part.text === "object") {
    const maybeText = (part.text as any).text;
    if (typeof maybeText === "string") return maybeText;
  }

  if (part.thinking && typeof part.thinking === "object") {
    const maybeText = (part.thinking as any).text ?? (part.thinking as any).thinking;
    if (typeof maybeText === "string") return maybeText;
  }

  return "";
}

/**
 * Recursively strips cache_control and providerOptions from any object.
 * These fields can be injected by SDKs, but Claude rejects them inside thinking blocks.
 */
function stripCacheControlRecursively(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(item => stripCacheControlRecursively(item));

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key === "cache_control" || key === "providerOptions") continue;
    result[key] = stripCacheControlRecursively(value);
  }
  return result;
}

/**
 * Sanitizes a thinking part by keeping only the allowed fields.
 * In particular, ensures `thinking` is a string (not an object with cache_control).
 * Returns null if the thinking block has no valid content.
 */
function sanitizeThinkingPart(part: Record<string, unknown>): Record<string, unknown> | null {
  // Gemini-style thought blocks: { thought: true, text, thoughtSignature }
  if (part.thought === true) {
    let textContent: unknown = part.text;
    if (typeof textContent === "object" && textContent !== null) {
      const maybeText = (textContent as any).text;
      textContent = typeof maybeText === "string" ? maybeText : undefined;
    }

    const hasContent = typeof textContent === "string" && textContent.trim().length > 0;
    if (!hasContent && !part.thoughtSignature) {
      return null;
    }

    const sanitized: Record<string, unknown> = { thought: true };
    if (textContent !== undefined) sanitized.text = textContent;
    if (part.thoughtSignature !== undefined) sanitized.thoughtSignature = part.thoughtSignature;
    return sanitized;
  }

  // Anthropic-style thinking/redacted_thinking blocks: { type: "thinking"|"redacted_thinking", thinking, signature }
  if (part.type === "thinking" || part.type === "redacted_thinking" || part.thinking !== undefined) {
    let thinkingContent: unknown = part.thinking ?? part.text;
    if (thinkingContent !== undefined && typeof thinkingContent === "object" && thinkingContent !== null) {
      const maybeText = (thinkingContent as any).text ?? (thinkingContent as any).thinking;
      thinkingContent = typeof maybeText === "string" ? maybeText : undefined;
    }

    const hasContent = typeof thinkingContent === "string" && thinkingContent.trim().length > 0;
    if (!hasContent && !part.signature) {
      return null;
    }

    const sanitized: Record<string, unknown> = { type: part.type === "redacted_thinking" ? "redacted_thinking" : "thinking" };
    if (thinkingContent !== undefined) sanitized.thinking = thinkingContent;
    if (part.signature !== undefined) sanitized.signature = part.signature;
    return sanitized;
  }

  // Reasoning blocks (OpenCode format): { type: "reasoning", text, signature }
  if (part.type === "reasoning") {
    let textContent: unknown = part.text;
    if (typeof textContent === "object" && textContent !== null) {
      const maybeText = (textContent as any).text;
      textContent = typeof maybeText === "string" ? maybeText : undefined;
    }

    const hasContent = typeof textContent === "string" && textContent.trim().length > 0;
    if (!hasContent && !part.signature) {
      return null;
    }

    const sanitized: Record<string, unknown> = { type: "reasoning" };
    if (textContent !== undefined) sanitized.text = textContent;
    if (part.signature !== undefined) sanitized.signature = part.signature;
    return sanitized;
  }

  // Fallback: strip cache_control recursively.
  return stripCacheControlRecursively(part) as Record<string, unknown>;
}

function findLastAssistantIndex(contents: any[], roleValue: "model" | "assistant"): number {
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i];
    if (content && typeof content === "object" && content.role === roleValue) {
      return i;
    }
  }
  return -1;
}

function filterContentArray(
  contentArray: any[],
  sessionId?: string,
  getCachedSignatureFn?: (sessionId: string, text: string) => string | undefined,
  isClaudeModel?: boolean,
  isLastAssistantMessage: boolean = false,
): any[] {
  // For Claude models, strip thinking blocks for reliability.
  if (isClaudeModel) {
    return stripAllThinkingBlocks(contentArray);
  }

  const filtered: any[] = [];

  for (const item of contentArray) {
    if (!item || typeof item !== "object") {
      filtered.push(item);
      continue;
    }

    if (isToolBlock(item)) {
      filtered.push(item);
      continue;
    }

    const isThinking = isThinkingPart(item);
    const hasSignature = hasSignatureField(item);

    if (!isThinking && !hasSignature) {
      filtered.push(item);
      continue;
    }

    // CRITICAL: For the LAST assistant message, thinking blocks MUST remain byte-for-byte
    // identical to what the API returned. Anthropic rejects any modification.
    // Pass through unchanged - do NOT sanitize or reconstruct.
    if (isLastAssistantMessage && (isThinking || hasSignature)) {
      filtered.push(item);
      continue;
    }

    if (isOurCachedSignature(item, sessionId, getCachedSignatureFn)) {
      const sanitized = sanitizeThinkingPart(item);
      if (sanitized) filtered.push(sanitized);
      continue;
    }

    if (sessionId && getCachedSignatureFn) {
      const text = getThinkingText(item);
      if (text) {
        const cachedSignature = getCachedSignatureFn(sessionId, text);
        if (cachedSignature && cachedSignature.length >= 50) {
          const restoredPart = { ...item };
          if ((item as any).thought === true) {
            (restoredPart as any).thoughtSignature = cachedSignature;
          } else {
            (restoredPart as any).signature = cachedSignature;
          }
          const sanitized = sanitizeThinkingPart(restoredPart as Record<string, unknown>);
          if (sanitized) filtered.push(sanitized);
          continue;
        }
      }
    }
  }

  return filtered;
}

/**
 * Filters thinking blocks from contents unless the signature matches our cache.
 * Attempts to restore signatures from cache for thinking blocks that lack signatures.
 *
 * @param contents - The contents array from the request
 * @param sessionId - Optional session ID for signature cache lookup
 * @param getCachedSignatureFn - Optional function to retrieve cached signatures
 */
function filterUnsignedThinkingBlocks(
  contents: any[],
  sessionId?: string,
  getCachedSignatureFn?: (sessionId: string, text: string) => string | undefined,
  isClaudeModel?: boolean,
): any[] {
  const lastAssistantIdx = findLastAssistantIndex(contents, "model");

  return contents.map((content: any, idx: number) => {
    if (!content || typeof content !== "object") {
      return content;
    }

    const isLastAssistant = idx === lastAssistantIdx;

    if (Array.isArray((content as any).parts)) {
      const filteredParts = filterContentArray(
        (content as any).parts,
        sessionId,
        getCachedSignatureFn,
        isClaudeModel,
        isLastAssistant,
      );

      const trimmedParts = (content as any).role === "model" && !isClaudeModel
        ? removeTrailingThinkingBlocks(filteredParts, sessionId, getCachedSignatureFn)
        : filteredParts;

      return { ...content, parts: trimmedParts };
    }

    if (Array.isArray((content as any).content)) {
      const isAssistantRole = (content as any).role === "assistant";
      const isLastAssistantContent = idx === lastAssistantIdx || 
        (isAssistantRole && idx === findLastAssistantIndex(contents, "assistant"));
      
      const filteredContent = filterContentArray(
        (content as any).content,
        sessionId,
        getCachedSignatureFn,
        isClaudeModel,
        isLastAssistantContent,
      );

      const trimmedContent = isAssistantRole && !isClaudeModel
        ? removeTrailingThinkingBlocks(filteredContent, sessionId, getCachedSignatureFn)
        : filteredContent;

      return { ...content, content: trimmedContent };
    }

    return content;
  });
}

/**
 * Filters thinking blocks from Anthropic-style messages[] payloads using cached signatures.
 */
function filterMessagesThinkingBlocks(
  messages: any[],
  sessionId?: string,
  getCachedSignatureFn?: (sessionId: string, text: string) => string | undefined,
  isClaudeModel?: boolean,
): any[] {
  const lastAssistantIdx = findLastAssistantIndex(messages, "assistant");

  return messages.map((message: any, idx: number) => {
    if (!message || typeof message !== "object") {
      return message;
    }

    if (Array.isArray((message as any).content)) {
      const isAssistantRole = (message as any).role === "assistant";
      const isLastAssistant = isAssistantRole && idx === lastAssistantIdx;
      
      const filteredContent = filterContentArray(
        (message as any).content,
        sessionId,
        getCachedSignatureFn,
        isClaudeModel,
        isLastAssistant,
      );

      const trimmedContent = isAssistantRole && !isClaudeModel
        ? removeTrailingThinkingBlocks(filteredContent, sessionId, getCachedSignatureFn)
        : filteredContent;

      return { ...message, content: trimmedContent };
    }

    return message;
  });
}

function deepFilterThinkingBlocks(
  payload: unknown,
  sessionId?: string,
  getCachedSignatureFn?: (sessionId: string, text: string) => string | undefined,
  isClaudeModel?: boolean,
): unknown {
  const visited = new WeakSet<object>();

  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }

    if (visited.has(value as object)) {
      return;
    }

    visited.add(value as object);

    if (Array.isArray(value)) {
      value.forEach((item) => walk(item));
      return;
    }

    const obj = value as Record<string, unknown>;

    if (Array.isArray(obj.contents)) {
      obj.contents = filterUnsignedThinkingBlocks(
        obj.contents as any[],
        sessionId,
        getCachedSignatureFn,
        isClaudeModel,
      );
    }

    if (Array.isArray(obj.messages)) {
      obj.messages = filterMessagesThinkingBlocks(
        obj.messages as any[],
        sessionId,
        getCachedSignatureFn,
        isClaudeModel,
      );
    }

    Object.keys(obj).forEach((key) => walk(obj[key]));
  };

  walk(payload);
  return payload;
}

/**
 * Transforms Gemini-style thought parts (thought: true) and Anthropic-style
 * thinking parts (type: "thinking") to reasoning format.
 * Claude responses through Antigravity may use candidates structure with Anthropic-style parts.
 */
function transformGeminiCandidate(candidate: any): any {
  if (!candidate || typeof candidate !== "object") {
    return candidate;
  }

  const content = candidate.content;
  if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
    return candidate;
  }

  const thinkingTexts: string[] = [];
  const transformedParts = content.parts.map((part: any) => {
    if (!part || typeof part !== "object") {
      return part;
    }

    // Handle Gemini-style: thought: true
    if (part.thought === true) {
      thinkingTexts.push(part.text || "");
      const transformed: Record<string, unknown> = { ...part, type: "reasoning" };
      if (part.cache_control) transformed.cache_control = part.cache_control;
      return transformed;
    }

    // Handle Anthropic-style in candidates: type: "thinking"
    if (part.type === "thinking") {
      const thinkingText = part.thinking || part.text || "";
      thinkingTexts.push(thinkingText);
      const transformed: Record<string, unknown> = {
        ...part,
        type: "reasoning",
        text: thinkingText,
        thought: true,
      };
      if (part.cache_control) transformed.cache_control = part.cache_control;
      return transformed;
    }

    // Handle functionCall: parse JSON strings in args
    // (Ported from LLM-API-Key-Proxy's _extract_tool_call)
    if (part.functionCall && part.functionCall.args) {
      const parsedArgs = recursivelyParseJsonStrings(part.functionCall.args);
      return {
        ...part,
        functionCall: {
          ...part.functionCall,
          args: parsedArgs,
        },
      };
    }

    return part;
  });

  return {
    ...candidate,
    content: { ...content, parts: transformedParts },
    ...(thinkingTexts.length > 0 ? { reasoning_content: thinkingTexts.join("\n\n") } : {}),
  };
}

/**
 * Transforms thinking/reasoning content in response parts to OpenCode's expected format.
 * Handles both Gemini-style (thought: true) and Anthropic-style (type: "thinking") formats.
 * Also extracts reasoning_content for Anthropic-style responses.
 */
function transformThinkingParts(response: unknown): unknown {
  if (!response || typeof response !== "object") {
    return response;
  }

  const resp = response as Record<string, unknown>;
  const result: Record<string, unknown> = { ...resp };
  const reasoningTexts: string[] = [];

  // Handle Anthropic-style content array (type: "thinking")
  if (Array.isArray(resp.content)) {
    const transformedContent: any[] = [];
    for (const block of resp.content) {
      if (block && typeof block === "object" && (block as any).type === "thinking") {
        const thinkingText = (block as any).thinking || (block as any).text || "";
        reasoningTexts.push(thinkingText);
        transformedContent.push({
          ...block,
          type: "reasoning",
          text: thinkingText,
          thought: true,
        });
      } else {
        transformedContent.push(block);
      }
    }
    result.content = transformedContent;
  }

  // Handle Gemini-style candidates array
  if (Array.isArray(resp.candidates)) {
    result.candidates = resp.candidates.map(transformGeminiCandidate);
  }

  // Add reasoning_content if we found any thinking blocks (for Anthropic-style)
  if (reasoningTexts.length > 0 && !result.reasoning_content) {
    result.reasoning_content = reasoningTexts.join("\n\n");
  }

  return result;
}

/**
 * Ensures thinkingConfig is valid: includeThoughts only allowed when budget > 0.
 */
function normalizeThinkingConfig(config: unknown): ThinkingConfig | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }

  const record = config as Record<string, unknown>;
  const budgetRaw = record.thinkingBudget ?? record.thinking_budget;
  const includeRaw = record.includeThoughts ?? record.include_thoughts;

  const thinkingBudget = typeof budgetRaw === "number" && Number.isFinite(budgetRaw) ? budgetRaw : undefined;
  const includeThoughts = typeof includeRaw === "boolean" ? includeRaw : undefined;

  const enableThinking = thinkingBudget !== undefined && thinkingBudget > 0;
  const finalInclude = enableThinking ? includeThoughts ?? false : false;

  if (!enableThinking && finalInclude === false && thinkingBudget === undefined && includeThoughts === undefined) {
    return undefined;
  }

  const normalized: ThinkingConfig = {};
  if (thinkingBudget !== undefined) {
    normalized.thinkingBudget = thinkingBudget;
  }
  if (finalInclude !== undefined) {
    normalized.includeThoughts = finalInclude;
  }
  return normalized;
}

