import type { ModelDescriptor, ModelProvider, ModelProviderHealth } from "@kripl/core";
import { localModelsUrl, normalizeLocalOpenAIBaseUrl } from "./endpoint-policy.js";

interface OpenAIModelRecord {
  id?: unknown;
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
      models.push({
        provider: "local-openai",
        id,
        name: id,
        local: true,
        input: ["text"]
      });
    }

    return models;
  }
}
