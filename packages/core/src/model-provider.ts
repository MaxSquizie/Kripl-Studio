export type LocalModelServer = "lm-studio" | "unsloth";

export interface LocalModelConnection {
  endpoint: string;
  server?: LocalModelServer;
}

export interface LocalModelSelection extends LocalModelConnection {
  modelId: string;
}

export interface LocalModelCredentialStatus {
  ok: boolean;
  hasApiKey: boolean;
  persistent: boolean;
  error?: string;
}

export interface ModelDescriptor {
  provider: string;
  id: string;
  name: string;
  local: boolean;
  contextWindow?: number;
  input?: Array<"text" | "image">;
}

export interface ModelProviderHealth {
  status: "ready" | "offline" | "error";
  endpoint?: string;
  message?: string;
}

export interface ModelProvider {
  readonly id: string;

  health(): Promise<ModelProviderHealth>;
  listModels(): Promise<ModelDescriptor[]>;
}
