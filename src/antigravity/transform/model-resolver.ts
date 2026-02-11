import type { ResolvedModel, ThinkingTier } from "./types";

const THINKING_TIER_BUDGETS = {
  claude: { low: 8192, medium: 16384, high: 32768 },
  "gemini-2.5-pro": { low: 8192, medium: 16384, high: 32768 },
  "gemini-2.5-flash": { low: 6144, medium: 12288, high: 24576 },
  default: { low: 4096, medium: 8192, high: 16384 },
} as const;

const MODEL_ALIASES: Record<string, string> = {
  "gemini-3-pro-low": "gemini-3-pro",
  "gemini-3-pro-high": "gemini-3-pro",
  "gemini-3-flash-low": "gemini-3-flash",
  "gemini-3-flash-medium": "gemini-3-flash",
  "gemini-3-flash-high": "gemini-3-flash",
  "gemini-claude-sonnet-4-5": "claude-sonnet-4-5",
  "gemini-claude-sonnet-4-5-thinking-low": "claude-sonnet-4-5-thinking",
  "gemini-claude-sonnet-4-5-thinking-medium": "claude-sonnet-4-5-thinking",
  "gemini-claude-sonnet-4-5-thinking-high": "claude-sonnet-4-5-thinking",
  "gemini-claude-opus-4-6-thinking-low": "claude-opus-4-6-thinking",
  "gemini-claude-opus-4-6-thinking-medium": "claude-opus-4-6-thinking",
  "gemini-claude-opus-4-6-thinking-high": "claude-opus-4-6-thinking",
  "claude-opus-4-6-thinking-max": "claude-opus-4-6-thinking",
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
};

const MODEL_FALLBACKS: Record<string, string> = {
  "gemini-2.5-flash-image": "gemini-2.5-flash",
};

const TIER_REGEX = /-(minimal|low|medium|high)$/;
const QUOTA_PREFIX_REGEX = /^antigravity-/i;
const ANTIGRAVITY_ONLY_MODELS = /^(claude|gpt)/i;

function supportsThinkingTiers(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("gemini-3")
    || lower.includes("gemini-2.5")
    || (lower.includes("claude") && lower.includes("thinking"))
  );
}

function extractThinkingTierFromModel(model: string): ThinkingTier | undefined {
  if (!supportsThinkingTiers(model)) {
    return undefined;
  }
  const tierMatch = model.match(TIER_REGEX);
  return tierMatch?.[1] as ThinkingTier | undefined;
}

function getBudgetFamily(model: string): keyof typeof THINKING_TIER_BUDGETS {
  if (model.includes("claude")) {
    return "claude";
  }
  if (model.includes("gemini-2.5-pro")) {
    return "gemini-2.5-pro";
  }
  if (model.includes("gemini-2.5-flash")) {
    return "gemini-2.5-flash";
  }
  return "default";
}

function isThinkingCapableModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes("thinking") || lower.includes("gemini-3") || lower.includes("gemini-2.5");
}

export function resolveModelWithTier(requestedModel: string): ResolvedModel {
  const isAntigravity = QUOTA_PREFIX_REGEX.test(requestedModel);
  const modelWithoutQuota = requestedModel.replace(QUOTA_PREFIX_REGEX, "");

  const tier = extractThinkingTierFromModel(modelWithoutQuota);
  const baseName = tier ? modelWithoutQuota.replace(TIER_REGEX, "") : modelWithoutQuota;

  const isAntigravityOnly = ANTIGRAVITY_ONLY_MODELS.test(modelWithoutQuota);
  const quotaPreference = isAntigravity || isAntigravityOnly ? "antigravity" : "gemini-cli";
  const explicitQuota = isAntigravity;

  const isGemini3 = modelWithoutQuota.toLowerCase().startsWith("gemini-3");
  const skipAlias = isAntigravity && isGemini3;

  const isGemini3Pro = modelWithoutQuota.toLowerCase().startsWith("gemini-3-pro");
  const isGemini3Flash = modelWithoutQuota.toLowerCase().startsWith("gemini-3-flash");

  let antigravityModel = modelWithoutQuota;
  if (skipAlias) {
    if (isGemini3Pro && !tier) {
      antigravityModel = `${modelWithoutQuota}-low`;
    } else if (isGemini3Flash && tier) {
      antigravityModel = baseName;
    }
  }

  const actualModel = skipAlias
    ? antigravityModel
    : MODEL_ALIASES[modelWithoutQuota] || MODEL_ALIASES[baseName] || baseName;

  const resolvedModel = MODEL_FALLBACKS[actualModel] || actualModel;
  const isThinking = isThinkingCapableModel(resolvedModel);

  const isEffectiveGemini3 = resolvedModel.toLowerCase().includes("gemini-3");
  const isClaudeThinking = resolvedModel.toLowerCase().includes("claude")
    && resolvedModel.toLowerCase().includes("thinking");

  if (!tier) {
    if (isEffectiveGemini3) {
      return {
        actualModel: resolvedModel,
        thinkingLevel: "low",
        isThinkingModel: true,
        quotaPreference,
        explicitQuota,
      };
    }

    if (isClaudeThinking) {
      return {
        actualModel: resolvedModel,
        thinkingBudget: THINKING_TIER_BUDGETS.claude.high,
        isThinkingModel: true,
        quotaPreference,
        explicitQuota,
      };
    }

    return { actualModel: resolvedModel, isThinkingModel: isThinking, quotaPreference, explicitQuota };
  }

  if (isEffectiveGemini3) {
    return {
      actualModel: resolvedModel,
      thinkingLevel: tier,
      tier,
      isThinkingModel: true,
      quotaPreference,
      explicitQuota,
    };
  }

  const budgetFamily = getBudgetFamily(resolvedModel);
  const budgets = THINKING_TIER_BUDGETS[budgetFamily];
  const budgetTier = tier === "minimal" ? "low" : tier;
  const thinkingBudget = budgets[budgetTier];

  return {
    actualModel: resolvedModel,
    thinkingBudget,
    tier,
    isThinkingModel: isThinking,
    quotaPreference,
    explicitQuota,
  };
}
