import type { LocalModelConnection } from "@kripl/core";
import { LocalOpenAIProvider } from "@kripl/local-openai-provider";
import { LocalModelCredentialStore, parseLocalModelConnection } from "./local-model-credentials.js";

export interface ConnectedLocalModel extends Required<LocalModelConnection> {
  modelId: string;
  apiKey?: string;
}

export async function resolveLocalModel(
  connection: LocalModelConnection,
  modelId: string,
  credentials: LocalModelCredentialStore
): Promise<ConnectedLocalModel> {
  const normalized = parseLocalModelConnection(connection);
  const apiKey = await credentials.get(normalized);
  const provider = new LocalOpenAIProvider({
    baseUrl: normalized.endpoint,
    server: normalized.server,
    ...(apiKey ? { apiKey } : {})
  });
  const models = await provider.listModels();
  const selected = models.find((model) => model.id === modelId);
  if (!selected) {
    throw new Error(normalized.server === "unsloth"
      ? "Load the selected chat model in Unsloth, then connect again."
      : `Local model "${modelId}" is no longer available from the selected endpoint.`);
  }
  if (await credentials.get(normalized) !== apiKey) {
    throw new Error("The server credentials changed. Connect again before starting the agent.");
  }
  return { ...normalized, endpoint: provider.baseUrl, modelId: selected.id, ...(apiKey ? { apiKey } : {}) };
}

export async function generateLocalSessionTitle(
  model: ConnectedLocalModel,
  firstMessage: string
): Promise<string | undefined> {
  try {
    const response = await fetch(`${model.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {})
      },
      redirect: "error",
      body: JSON.stringify({
        model: model.modelId,
        max_tokens: 24,
        temperature: 0,
        ...(model.server === "unsloth" ? { enable_tools: false } : {}),
        messages: [{
          role: "user",
          content: "Create a very short topic title (maximum 5 words) for a coding chat that starts with this request. Reply with the title only, without quotes or punctuation at the end.\n\nRequest:\n" + firstMessage.slice(0, 600)
        }]
      }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const raw = payload.choices?.[0]?.message?.content;
    const title = typeof raw === "string"
      ? raw.replace(/^[\"'\u201c\u201d\s]+|[\"'\u201c\u201d.!?\s]+$/g, "").trim().slice(0, 80)
      : undefined;
    return title || undefined;
  } catch {
    return undefined;
  }
}
