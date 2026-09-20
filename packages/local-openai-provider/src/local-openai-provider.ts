import type { ModelDescriptor, ModelProvider, ModelProviderHealth } from "@kripl/core";
import { localModelsUrl, normalizeLocalOpenAIBaseUrl } from "./endpoint-policy.js";

interface OpenAIModelRecord {
  id?: unknown;
  /** LM Studio and some servers report the context window here. */
  max_context_size?: unknown;
  /** LM Studio native API (>=0.3) field name for the configured limit. */
  max_context_length?: unknown;
  /** LM Studio: context length actually loaded right now. */
  loaded_context_length?: unknown;
  context_window?: unknown;
  max_model_len?: unknown;
}

interface OpenAIModelsPayload {
  data?: unknown;
}

export interface LocalOpenAIProviderOptions {
  baseUrl: string;
  requestTimeoutMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  // Guard against servers that report absurd values (e.g. 2^31 placeholders).
  return value > 1_048_576 ? undefined : value;
}

export class LocalOpenAIProvider implements ModelProvider {
  readonly id = "model:local-openai";
  readonly baseUrl: string;

  private readonly requestTimeoutMs: number;

  constructor(options: LocalOpenAIProviderOptions) {
    this.baseUrl = normalizeLocalOpenAIBaseUrl(options.baseUrl);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2_500;
  }

  async health(): Promise<ModelProviderHealth> {
    try {
      await this.listModels();
      return { status: "ready", endpoint: this.baseUrl };
    } catch (error) {
      return {
        status: "offline",
        endpoint: this.baseUrl,
        message: errorMessage(error)
      };
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const response = await fetch(localModelsUrl(this.baseUrl), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });

    if (!response.ok) {
      throw new Error(`Local model server returned HTTP ${response.status}.`);
    }

    const payload = (await response.json()) as OpenAIModelsPayload;
    if (!Array.isArray(payload.data)) {
      throw new Error("Local model server returned an invalid /models payload.");
    }

    const models: ModelDescriptor[] = [];
    for (const item of payload.data as OpenAIModelRecord[]) {
      if (!item || typeof item.id !== "string" || !item.id.trim()) continue;
      const id = item.id.trim();
      const contextWindow = positiveInt(
        item.max_context_size ??
          item.max_context_length ??
          item.loaded_context_length ??
          item.context_window ??
          item.max_model_len
      );
      models.push({
        provider: "local-openai",
        id,
        name: id,
        local: true,
        input: ["text"],
        ...(contextWindow ? { contextWindow } : {})
      });
    }

    if (!models.some((model) => model.contextWindow)) {
      const lmStudioContext = await this.fetchLmStudioContextWindows();
      for (const model of models) {
        if (model.contextWindow) continue;
        const contextWindow = lmStudioContext.get(model.id.toLowerCase());
        if (contextWindow) model.contextWindow = contextWindow;
      }
    }

    return models;
  }

  /**
   * LM Studio's OpenAI-compatible /v1/models often omits the context size,
   * but its native API on the same port reports max_context_length. Used
   * only as a fallback when nothing was reported above.
   *
   * The native endpoint can take several seconds to answer while a large
   * model is loaded, so it gets a longer timeout than the /v1 probe.
   */
  private async fetchLmStudioContextWindows(): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    let url: URL;
    try {
      url = new URL(this.baseUrl);
    } catch {
      return found;
    }
    url.pathname = "/api/v0/models";
    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(this.requestTimeoutMs, 8_000))
      });
      if (!response.ok) return found;
      const payload = (await response.json()) as OpenAIModelsPayload;
      if (!Array.isArray(payload.data)) return found;
      for (const item of payload.data as OpenAIModelRecord[]) {
        if (!item || typeof item.id !== "string" || !item.id.trim()) continue;
        const contextWindow = positiveInt(
          item.max_context_size ??
            item.max_context_length ??
            item.loaded_context_length ??
            item.context_window
        );
        if (contextWindow) found.set(item.id.trim().toLowerCase(), contextWindow);
      }
    } catch {
      // Native LM Studio API unavailable — the OpenAI-compatible list stands.
    }
    return found;
  }
}
