import type {HeaderStyle} from '../constants';

export type ThinkingTier = 'minimal' | 'low' | 'medium' | 'high';

export type RequestPayload = Record<string, unknown>;

export interface ThinkingConfig {
  thinkingBudget?: number;
  thinking_budget?: number;
  thinkingLevel?: string;
  includeThoughts?: boolean;
  include_thoughts?: boolean;
}

export interface ResolvedModel {
  actualModel: string;
  thinkingLevel?: ThinkingTier;
  thinkingBudget?: number;
  tier?: ThinkingTier;
  isThinkingModel?: boolean;
  quotaPreference?: HeaderStyle;
  explicitQuota?: boolean;
}
