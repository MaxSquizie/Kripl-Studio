import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const EXTENSION_SOURCE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openAICompletionsApi } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
  if (process.env.KRIPL_LOCAL_MODEL_SERVER !== "unsloth") return;
  const api = openAICompletionsApi();
  pi.registerProvider("kripl-local", {
    api: "openai-completions",
    streamSimple(model, context, options) {
      return api.streamSimple(model, context, {
        ...options,
        onPayload: async (payload, requestModel) => {
          const replacement = await options?.onPayload?.(payload, requestModel);
          const body = replacement === undefined ? payload : replacement;
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new Error("Local model request payload is invalid.");
          }
          return { ...body, enable_tools: false };
        }
      });
    }
  });
}
`;

export async function writePiLocalCompatibility(agentDir: string): Promise<void> {
  const extensionsDir = join(agentDir, "extensions");
  await mkdir(extensionsDir, { recursive: true });
  await writeFile(join(extensionsDir, "kripl-local-compat.ts"), EXTENSION_SOURCE, {
    encoding: "utf8",
    mode: 0o600
  });
}
