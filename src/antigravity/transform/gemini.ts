import type {RequestPayload, ThinkingConfig, ThinkingTier} from './types';
import {createPlaceholderSchema, extractToolSchema} from '../utils';

function isGemini3Model(model: string): boolean {
  return model.toLowerCase().includes('gemini-3');
}

function buildGemini3ThinkingConfig(
  includeThoughts: boolean,
  thinkingLevel: ThinkingTier,
): ThinkingConfig {
  return {includeThoughts, thinkingLevel};
}

function buildGemini25ThinkingConfig(
  includeThoughts: boolean,
  thinkingBudget?: number,
): ThinkingConfig {
  return {
    includeThoughts,
    ...(typeof thinkingBudget === 'number' && thinkingBudget > 0
      ? {thinkingBudget}
      : {}),
  };
}

function normalizeGeminiTools(payload: RequestPayload): void {
  if (!Array.isArray(payload.tools)) return;

  const hasFnDecls = (payload.tools as unknown[]).some(t => {
    const r = t as Record<string, unknown> | null;
    return !!r && Array.isArray(r.functionDeclarations);
  });
  if (hasFnDecls) return;

  payload.tools = (payload.tools as unknown[]).map((tool: unknown) => {
    const newTool = {...(tool as Record<string, unknown>)};
    const rawSchema = extractToolSchema(newTool);
    const schema =
      rawSchema && typeof rawSchema === 'object' && !Array.isArray(rawSchema)
        ? (rawSchema as Record<string, unknown>)
        : createPlaceholderSchema();

    if (
      newTool.function &&
      !(newTool.function as Record<string, unknown>).input_schema
    ) {
      (newTool.function as Record<string, unknown>).input_schema = schema;
    }

    if (
      !newTool.function &&
      !newTool.parameters &&
      !newTool.input_schema &&
      !newTool.inputSchema
    ) {
      newTool.parameters = schema;
    }

    delete newTool.custom;
    return newTool;
  });
}

export interface GeminiTransformOptions {
  model: string;
  tierThinkingBudget?: number;
  tierThinkingLevel?: ThinkingTier;
  normalizedThinking?: {includeThoughts?: boolean; thinkingBudget?: number};
}

export function applyGeminiTransforms(
  payload: RequestPayload,
  options: GeminiTransformOptions,
): void {
  const {model, tierThinkingBudget, tierThinkingLevel, normalizedThinking} =
    options;

  if (normalizedThinking) {
    const thinkingConfig =
      tierThinkingLevel && isGemini3Model(model)
        ? buildGemini3ThinkingConfig(
            normalizedThinking.includeThoughts ?? true,
            tierThinkingLevel,
          )
        : buildGemini25ThinkingConfig(
            normalizedThinking.includeThoughts ?? true,
            tierThinkingBudget ?? normalizedThinking.thinkingBudget,
          );

    const generationConfig = (payload.generationConfig ?? {}) as Record<
      string,
      unknown
    >;
    generationConfig.thinkingConfig = thinkingConfig;
    payload.generationConfig = generationConfig;
  }

  normalizeGeminiTools(payload);
}
