import type { LocalModelServer, ModelDescriptor, ModelProvider, ModelProviderHealth } from "@kripl/core";
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
  context_length?: unknown;
  display_name?: unknown;
  loaded?: unknown;
  status?: unknown;
  task?: unknown;
}

interface OpenAIModelsPayload {
  data?: unknown;
}

export interface LocalOpenAIProviderOptions {
  baseUrl: string;
  server?: LocalModelServer;
  apiKey?: string;
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

function isUnslothChatModel(item: OpenAIModelRecord): boolean {
  if (item.loaded === false) return false;
  const status = item.status && typeof item.status === "object"
    ? (item.status as { value?: unknown }).value : item.status;
  if (typeof status === "string" && status !== "loaded" && status !== "ready") return false;
  return item.task === undefined || item.task === null || item.task === "" ||
    item.task === "chat" || item.task === "text-generation" || item.task === "conversational";
}

export class LocalOpenAIProvider implements ModelProvider {
  readonly id = "model:local-openai";
  readonly baseUrl: string;

  private readonly requestTimeoutMs: number;
  private readonly server: LocalModelServer;
  private readonly headers: Record<string, string>;

  constructor(options: LocalOpenAIProviderOptions) {
    this.baseUrl = normalizeLocalOpenAIBaseUrl(options.baseUrl);
    this.server = options.server ?? "lm-studio";
    this.requestTimeoutMs = options.requestTimeoutMs ?? (this.server === "unsloth" ? 15_000 : 2_500);
    const apiKey = options.apiKey?.trim();
    if (apiKey && (apiKey.length > 8192 || /[^\x21-\x7e]/.test(apiKey))) {
      throw new Error("Local model API key is invalid.");
    }
    this.headers = { accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
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
      headers: this.headers,
      redirect: "error",
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Local model server requires a valid API key with model access (HTTP ${response.status}). Check the API key in Settings → Model.`);
      }
      throw new Error(`Local model server returned HTTP ${response.status}.`);
    }

    const payload = await response.json().catch(() => {
      throw new Error("Local model server returned an invalid /models payload.");
    }) as OpenAIModelsPayload;
    if (!Array.isArray(payload.data)) {
      throw new Error("Local model server returned an invalid /models payload.");
    }

    const models: ModelDescriptor[] = [];
    for (const item of payload.data as OpenAIModelRecord[]) {
      if (!item || typeof item.id !== "string" || !item.id.trim()) continue;
      if (this.server === "unsloth" && !isUnslothChatModel(item)) continue;
      const id = item.id.trim();
      const contextWindow = positiveInt(
        (this.server === "unsloth" ? item.context_length : undefined) ??
          item.max_context_size ??
          item.max_context_length ??
          item.loaded_context_length ??
          item.context_window ??
          item.max_model_len
      );
      models.push({
        provider: "local-openai",
        id,
        name: this.server === "unsloth" && typeof item.display_name === "string" && item.display_name.trim()
          ? item.display_name.trim() : id,
        local: true,
        input: ["text"],
        ...(contextWindow ? { contextWindow } : {})
      });
    }

    if (this.server === "lm-studio" && !models.some((model) => model.contextWindow)) {
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
        headers: this.headers,
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
