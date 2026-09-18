import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const KRIPL_PI_PROVIDER = "kripl-local";

export interface PiLocalModelConfig {
  baseUrl: string;
  modelId: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function assertLoopbackUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Pi local model base URL is invalid.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Pi local model base URL must use http or https.");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error("Pi local model base URL must resolve to an explicit loopback host.");
  }

  if (url.username || url.password) {
    throw new Error("Pi local model base URL must not contain credentials.");
  }

  return value.replace(/\/+$/, "");
}

function assertModelId(value: string): string {
  const id = value.trim();
  if (!id || id.length > 512 || id.includes("\0")) {
    throw new Error("Pi local model id is invalid.");
  }
  return id;
}

export async function writePiLocalModelConfig(
  agentDir: string,
  config: PiLocalModelConfig
): Promise<void> {
  const baseUrl = assertLoopbackUrl(config.baseUrl);
  const modelId = assertModelId(config.modelId);

  await mkdir(agentDir, { recursive: true });

  const document = {
    providers: {
      [KRIPL_PI_PROVIDER]: {
        baseUrl,
        api: "openai-completions",
        apiKey: "kripl-local",
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false
        },
        models: [
          {
            id: modelId,
            name: modelId,
            reasoning: false,
            input: ["text"],
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0
            }
          }
        ]
      }
    }
  };

  await writeFile(join(agentDir, "models.json"), `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}
