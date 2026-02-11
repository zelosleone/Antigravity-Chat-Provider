import {
  EMPTY_SCHEMA_PLACEHOLDER_NAME,
  EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
} from "./constants";

export function createPlaceholderSchema(base: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...base,
    type: "object",
    properties: {
      [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
        type: "boolean",
        description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
      },
    },
    required: Array.isArray(base.required)
      ? Array.from(new Set([...(base.required as string[]), EMPTY_SCHEMA_PLACEHOLDER_NAME]))
      : [EMPTY_SCHEMA_PLACEHOLDER_NAME],
  };
}

export function appendSystemInstructionText(payload: Record<string, unknown>, text: string): void {
  const existing = payload.systemInstruction;

  if (typeof existing === "string") {
    payload.systemInstruction = existing.trim() ? `${existing}\n\n${text}` : text;
    return;
  }

  if (existing && typeof existing === "object") {
    const sys = existing as Record<string, unknown>;
    if (Array.isArray(sys.parts)) {
      const parts = sys.parts as Array<Record<string, unknown>>;
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        if (typeof parts[i].text === "string") {
          parts[i].text = `${parts[i].text}\n\n${text}`;
          return;
        }
      }
      parts.push({ text });
      return;
    }
    sys.parts = [{ text }];
    return;
  }

  payload.systemInstruction = { parts: [{ text }] };
}

export function extractPartSignature(part: Record<string, unknown>): string | undefined {
  if (typeof part.thoughtSignature === "string") return part.thoughtSignature;
  if (typeof part.signature === "string") return part.signature;
  const meta = (part.metadata as Record<string, unknown> | undefined)?.google as Record<string, unknown> | undefined;
  return typeof meta?.thoughtSignature === "string" ? meta.thoughtSignature : undefined;
}

export function isThinkingPart(part: Record<string, unknown>): boolean {
  return part.thought === true
    || part.type === "thinking"
    || part.type === "redacted_thinking"
    || part.type === "reasoning";
}

export function extractToolSchema(tool: Record<string, unknown>, decl?: Record<string, unknown>): unknown {
  const fn = tool.function as Record<string, unknown> | undefined;
  const custom = tool.custom as Record<string, unknown> | undefined;
  return decl?.parameters ?? decl?.parametersJsonSchema ?? decl?.input_schema ?? decl?.inputSchema
    ?? tool.parameters ?? tool.parametersJsonSchema ?? tool.input_schema ?? tool.inputSchema
    ?? fn?.parameters ?? fn?.parametersJsonSchema ?? fn?.input_schema ?? fn?.inputSchema
    ?? custom?.parameters ?? custom?.parametersJsonSchema ?? custom?.input_schema;
}

export function ensureObjectSchema(schema: unknown, cleanFn?: (s: unknown) => unknown): Record<string, unknown> {
  const raw = cleanFn ? cleanFn(schema ?? {}) : schema;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createPlaceholderSchema();
  }

  const record = raw as Record<string, unknown>;
  if (record.type !== undefined && record.type !== "object") {
    return createPlaceholderSchema();
  }

  const hasProperties = record.properties
    && typeof record.properties === "object"
    && Object.keys(record.properties as Record<string, unknown>).length > 0;

  if (!hasProperties) {
    return createPlaceholderSchema(record);
  }

  return { ...record, type: "object" };
}
