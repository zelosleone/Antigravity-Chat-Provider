import type {RequestPayload, ThinkingConfig} from './types';
import {extractToolSchema, ensureObjectSchema} from '../utils';

export const CLAUDE_THINKING_MAX_OUTPUT_TOKENS = 64_000;

export function isClaudeModel(model: string): boolean {
  return model.toLowerCase().includes('claude');
}

export function isClaudeThinkingModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes('claude') && lower.includes('thinking');
}

function configureClaudeToolConfig(payload: RequestPayload): void {
  const toolConfig = (payload.toolConfig ?? {}) as Record<string, unknown>;
  const fnConfig = (toolConfig.functionCallingConfig ?? {}) as Record<
    string,
    unknown
  >;
  fnConfig.mode = 'VALIDATED';
  toolConfig.functionCallingConfig = fnConfig;
  payload.toolConfig = toolConfig;
}

function buildClaudeThinkingConfig(
  includeThoughts: boolean,
  thinkingBudget?: number,
): ThinkingConfig {
  return {
    include_thoughts: includeThoughts,
    ...(typeof thinkingBudget === 'number' && thinkingBudget > 0
      ? {thinking_budget: thinkingBudget}
      : {}),
  };
}

function ensureClaudeMaxOutputTokens(
  generationConfig: Record<string, unknown>,
  thinkingBudget: number,
): void {
  const currentMax = (generationConfig.maxOutputTokens ??
    generationConfig.max_output_tokens) as number | undefined;

  if (!currentMax || currentMax <= thinkingBudget) {
    generationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS;
    if (generationConfig.max_output_tokens !== undefined) {
      delete generationConfig.max_output_tokens;
    }
  }
}

function normalizeClaudeTools(
  payload: RequestPayload,
  cleanJSONSchema: (schema: unknown) => Record<string, unknown>,
): void {
  if (!Array.isArray(payload.tools)) {
    return;
  }

  const functionDeclarations: Array<Record<string, unknown>> = [];
  const passthroughTools: unknown[] = [];

  (payload.tools as unknown[]).forEach(tool => {
    const t = tool as Record<string, unknown>;

    const pushDeclaration = (
      decl: Record<string, unknown> | undefined,
    ): void => {
      const schema = extractToolSchema(t, decl);

      const rawName =
        decl?.name ||
        t.name ||
        (t.function as Record<string, unknown> | undefined)?.name ||
        (t.custom as Record<string, unknown> | undefined)?.name ||
        `tool-${functionDeclarations.length}`;

      const description =
        decl?.description ||
        t.description ||
        (t.function as Record<string, unknown> | undefined)?.description ||
        (t.custom as Record<string, unknown> | undefined)?.description ||
        '';

      functionDeclarations.push({
        name: String(rawName)
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .slice(0, 64),
        description: String(description),
        parameters: ensureObjectSchema(schema, cleanJSONSchema),
      });
    };

    if (
      Array.isArray(t.functionDeclarations) &&
      (t.functionDeclarations as unknown[]).length > 0
    ) {
      (t.functionDeclarations as Record<string, unknown>[]).forEach(decl =>
        pushDeclaration(decl),
      );
      return;
    }

    if (
      t.function ||
      t.custom ||
      t.parameters ||
      t.input_schema ||
      t.inputSchema
    ) {
      pushDeclaration(
        (t.function as Record<string, unknown> | undefined) ??
          (t.custom as Record<string, unknown> | undefined) ??
          t,
      );
      return;
    }

    passthroughTools.push(tool);
  });

  payload.tools =
    functionDeclarations.length > 0
      ? [{functionDeclarations}, ...passthroughTools]
      : passthroughTools;
}

function convertStopSequences(generationConfig: Record<string, unknown>): void {
  if (Array.isArray(generationConfig.stop_sequences)) {
    generationConfig.stopSequences = generationConfig.stop_sequences;
    delete generationConfig.stop_sequences;
  }
}

export interface ClaudeTransformOptions {
  model: string;
  tierThinkingBudget?: number;
  normalizedThinking?: {includeThoughts?: boolean; thinkingBudget?: number};
  cleanJSONSchema: (schema: unknown) => Record<string, unknown>;
}

export function applyClaudeTransforms(
  payload: RequestPayload,
  options: ClaudeTransformOptions,
): void {
  const {model, tierThinkingBudget, normalizedThinking, cleanJSONSchema} =
    options;
  const isThinking = isClaudeThinkingModel(model);

  configureClaudeToolConfig(payload);

  if (payload.generationConfig) {
    convertStopSequences(payload.generationConfig as Record<string, unknown>);
  }

  if (normalizedThinking && isThinking) {
    const thinkingBudget =
      tierThinkingBudget ?? normalizedThinking.thinkingBudget;
    const generationConfig = (payload.generationConfig ?? {}) as Record<
      string,
      unknown
    >;
    generationConfig.thinkingConfig = buildClaudeThinkingConfig(
      normalizedThinking.includeThoughts ?? true,
      thinkingBudget,
    );

    if (typeof thinkingBudget === 'number' && thinkingBudget > 0) {
      ensureClaudeMaxOutputTokens(generationConfig, thinkingBudget);
    }

    payload.generationConfig = generationConfig;
  }

  normalizeClaudeTools(payload, cleanJSONSchema);
}
