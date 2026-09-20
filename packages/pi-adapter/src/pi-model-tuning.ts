import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Static Pi extension that appends the user's custom system prompt (stored in
 * `kripl-model-tuning.json` next to the agent dir) to the assembled system
 * prompt on every turn. The JSON file is rewritten by Kripl Studio whenever
 * model tuning settings change, so edits apply from the next message onward.
 */
const EXTENSION_SOURCE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface ModelTuningFile {
  version?: unknown;
  systemPrompt?: unknown;
}

const settingsPath = join(dirname(fileURLToPath(import.meta.url)), "..", "kripl-model-tuning.json");

function loadSystemPrompt(): string {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as ModelTuningFile;
    if (parsed?.version === 1 && typeof parsed.systemPrompt === "string") {
      return parsed.systemPrompt.trim();
    }
  } catch {}
  return "";
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const custom = loadSystemPrompt();
    if (!custom) return undefined;
    return {
      systemPrompt: event.systemPrompt + "\\n\\n<user_instructions>\\n" + custom + "\\n</user_instructions>"
    };
  });
}
`;

export interface PiModelTuningFile {
  version: 1;
  systemPrompt?: string;
}

/**
 * Write the model-tuning extension and its settings file into the agent dir.
 * Call on every agent start so the on-disk state always matches the UI.
 */
export async function writePiModelTuning(
  agentDir: string,
  tuning: { systemPrompt?: string } = {}
): Promise<void> {
  const extensionsDir = join(agentDir, "extensions");
  await mkdir(extensionsDir, { recursive: true });

  const file: PiModelTuningFile = { version: 1 };
  const prompt = tuning.systemPrompt?.trim();
  if (prompt) file.systemPrompt = prompt;

  await Promise.all([
    writeFile(join(agentDir, "kripl-model-tuning.json"), `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    }),
    writeFile(join(extensionsDir, "kripl-model-tuning.ts"), EXTENSION_SOURCE, {
      encoding: "utf8",
      mode: 0o600
    })
  ]);
}
