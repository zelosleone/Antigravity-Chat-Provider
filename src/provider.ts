import * as vscode from "vscode";
import { ANTIGRAVITY_DEFAULT_PROJECT_ID } from "./antigravity/constants";
import { CLAUDE_THINKING_MAX_OUTPUT_TOKENS, isClaudeThinkingModel } from "./antigravity/transform/claude";
import { resolveModelWithTier } from "./antigravity/transform/model-resolver";
import { ensureValidAuth, getProjectIdFromAuth } from "./auth";
import { MODELS } from "./models";
import {
  applyModelTransforms,
  buildRequestPayload,
  toTextParts,
  type ThoughtSignatureCache,
} from "./provider-request";
import {
  STREAM_ACTION,
  buildEndpoint,
  buildRequestHeaders,
  buildWrappedRequest,
  handleResponseParts,
  hasToolCalls,
  injectCachedThinkingSignature,
  streamResponse,
  warmupGeminiThinkingSignature,
} from "./provider-response";

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
    const headers = buildRequestHeaders(accessToken, headerStyle, "text/event-stream");

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
