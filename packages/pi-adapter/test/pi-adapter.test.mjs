import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPiEnvironment } from "../dist/rpc-process.js";
import { writePiBrowserTools } from "../dist/pi-browser-tools.js";
import { writePiPermissionGate } from "../dist/pi-permission-gate.js";
import { writePiWebTools } from "../dist/pi-web-tools.js";
import { writePiTextToolBridge } from "../dist/pi-text-tools.js";

import { normalizePiEvent } from "../dist/pi-event-normalizer.js";
import {
  KRIPL_PI_PROVIDER,
  writePiLocalModelConfig
} from "../dist/pi-local-config.js";
import { writePiModelTuning } from "../dist/pi-model-tuning.js";

async function loadPiExtensions(paths, cwd) {
  const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const loaderPath = join(dirname(packageEntry), "core", "extensions", "loader.js");
  const loader = await import(pathToFileURL(loaderPath).href);
  return loader.loadExtensions(paths, cwd);
}

test("writes an isolated Pi provider config for the selected local model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-pi-"));

  try {
    await writePiLocalModelConfig(directory, {
      baseUrl: "http://127.0.0.1:1234/v1",
      modelId: "qwen-local"
    });

    const document = JSON.parse(await readFile(join(directory, "models.json"), "utf8"));
    const provider = document.providers[KRIPL_PI_PROVIDER];

    assert.equal(provider.baseUrl, "http://127.0.0.1:1234/v1");
    assert.equal(provider.api, "openai-completions");
    assert.equal(provider.apiKey, "kripl-local");
    assert.equal(provider.models[0].id, "qwen-local");
    assert.equal(provider.models[0].cost.input, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writes sampling temperature into the provider config only when set", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-pi-"));

  try {
    await writePiLocalModelConfig(directory, {
      baseUrl: "http://127.0.0.1:1234/v1",
      modelId: "qwen-local"
    });
    let document = JSON.parse(await readFile(join(directory, "models.json"), "utf8"));
    assert.equal(document.providers[KRIPL_PI_PROVIDER].models[0].samplingParams, undefined);

    await writePiLocalModelConfig(directory, {
      baseUrl: "http://127.0.0.1:1234/v1",
      modelId: "qwen-local",
      temperature: 0.4
    });
    document = JSON.parse(await readFile(join(directory, "models.json"), "utf8"));
    assert.deepEqual(document.providers[KRIPL_PI_PROVIDER].models[0].samplingParams, {
      temperature: 0.4
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writes the model tuning extension and settings file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-pi-"));

  try {
    await writePiModelTuning(directory, { systemPrompt: "Answer in Russian." });

    const file = JSON.parse(await readFile(join(directory, "kripl-model-tuning.json"), "utf8"));
    assert.equal(file.version, 1);
    assert.equal(file.systemPrompt, "Answer in Russian.");
    const source = await readFile(join(directory, "extensions", "kripl-model-tuning.ts"), "utf8");
    assert.match(source, /before_agent_start/);

    // No prompt: the file stays valid but carries no instructions.
    await writePiModelTuning(directory, {});
    const cleared = JSON.parse(await readFile(join(directory, "kripl-model-tuning.json"), "utf8"));
    assert.equal(cleared.systemPrompt, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi adapter refuses a remote model URL even if called directly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-pi-"));

  try {
    await assert.rejects(
      () =>
        writePiLocalModelConfig(directory, {
          baseUrl: "https://example.com/v1",
          modelId: "remote-model"
        }),
      /loopback/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizes Pi text deltas without leaking protocol details into the UI", () => {
  assert.deepEqual(
    normalizePiEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello"
      }
    }),
    [
      {
        type: "agent.stream",
        channel: "text",
        phase: "delta",
        contentIndex: 0,
        delta: "hello"
      }
    ]
  );
});

test("normalizes tool failures", () => {
  assert.deepEqual(
    normalizePiEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "failed" }] },
      isError: true
    }),
    [
      {
        type: "agent.tool",
        phase: "failed",
        callId: "call-1",
        name: "bash",
        payload: { content: [{ type: "text", text: "failed" }] }
      }
    ]
  );
});

test("uses agent_settled as the ready boundary", () => {
  assert.deepEqual(normalizePiEvent({ type: "agent_start" }), [
    { type: "agent.status", status: "running" }
  ]);
  assert.deepEqual(normalizePiEvent({ type: "agent_settled" }), [
    { type: "agent.status", status: "ready" }
  ]);
});


test("Pi uses online network mode by default while keeping the selected model local", () => {
  const previousOffline = process.env.PI_OFFLINE;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  const previousGitHub = process.env.GITHUB_TOKEN;

  process.env.PI_OFFLINE = "1";
  process.env.OPENAI_API_KEY = "cloud-model-secret";
  process.env.GITHUB_TOKEN = "tool-secret";

  try {
    const environment = createPiEnvironment({ agentDir: "C:/Kripl/pi-agent" });

    assert.equal(environment.PI_OFFLINE, undefined);
    assert.equal(environment.OPENAI_API_KEY, undefined);
    assert.equal(environment.GITHUB_TOKEN, "tool-secret");
    assert.equal(environment.PI_CODING_AGENT_DIR, "C:/Kripl/pi-agent");
    assert.equal(environment.KRIPL_NETWORK_MODE, "online");
  } finally {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;

    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;

    if (previousGitHub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGitHub;
  }
});

test("explicit offline mode enables PI_OFFLINE without changing model routing", () => {
  const environment = createPiEnvironment({
    agentDir: "C:/Kripl/pi-agent",
    networkMode: "offline"
  });

  assert.equal(environment.PI_OFFLINE, "1");
  assert.equal(environment.KRIPL_NETWORK_MODE, "offline");
  assert.equal(environment.PI_TELEMETRY, "0");
  assert.equal(environment.PI_SKIP_VERSION_CHECK, "1");
});


test("writes the Kripl permission extension and default policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-permissions-"));

  try {
    await writePiPermissionGate(directory);

    const policy = JSON.parse(await readFile(join(directory, "kripl-permissions.json"), "utf8"));
    const extension = await readFile(
      join(directory, "extensions", "kripl-permissions.ts"),
      "utf8"
    );

    assert.equal(policy.rules["filesystem.write.workspace"], "allow");
    assert.equal(policy.rules["filesystem.write.outside"], "ask");
    assert.equal(policy.rules["shell.dangerous"], "ask");
    assert.match(extension, /pi\.on\("tool_call"/);
    assert.match(extension, /Kripl permission/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizes Pi confirm requests into generic agent interactions", () => {
  assert.deepEqual(
    normalizePiEvent({
      type: "extension_ui_request",
      id: "permission-1",
      method: "confirm",
      title: "Kripl permission · shell.dangerous",
      message: "Allow dangerous shell command?\n\nrm -rf build"
    }),
    [
      {
        type: "agent.interaction",
        request: {
          id: "permission-1",
          kind: "confirm",
          title: "Kripl permission · shell.dangerous",
          message: "Allow dangerous shell command?\n\nrm -rf build"
        }
      }
    ]
  );
});

test("normalizes Pi extension notifications", () => {
  assert.deepEqual(
    normalizePiEvent({
      type: "extension_ui_request",
      id: "notice-1",
      method: "notify",
      message: "Command blocked",
      notifyType: "warning"
    }),
    [
      {
        type: "agent.notification",
        level: "warning",
        message: "Command blocked"
      }
    ]
  );
});


test("generated web extension loads and registers search/open tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-web-tools-"));

  try {
    await writePiWebTools(directory, "online");
    const extensionPath = join(directory, "extensions", "kripl-web-tools.ts");
    const result = await loadPiExtensions([extensionPath], directory);

    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.equal(result.extensions[0]?.tools.has("web_search"), true);
    assert.equal(result.extensions[0]?.tools.has("web_open"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("web tools fail closed in offline mode before issuing requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-web-offline-"));
  const previousMode = process.env.KRIPL_NETWORK_MODE;
  process.env.KRIPL_NETWORK_MODE = "offline";

  try {
    await writePiWebTools(directory, "offline");
    const extensionPath = join(directory, "extensions", "kripl-web-tools.ts");
    const result = await loadPiExtensions([extensionPath], directory);
    assert.deepEqual(result.errors, []);

    const search = result.extensions[0]?.tools.get("web_search");
    assert.ok(search);
    await assert.rejects(
      () => search.definition.execute("call-1", { query: "Kripl Studio" }, undefined, undefined, undefined),
      /offline mode/
    );
  } finally {
    if (previousMode === undefined) delete process.env.KRIPL_NETWORK_MODE;
    else process.env.KRIPL_NETWORK_MODE = previousMode;
    await rm(directory, { recursive: true, force: true });
  }
});

test("web_open blocks localhost without touching the network", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-web-ssrf-"));
  const previousMode = process.env.KRIPL_NETWORK_MODE;
  process.env.KRIPL_NETWORK_MODE = "online";

  try {
    await writePiWebTools(directory, "online");
    const extensionPath = join(directory, "extensions", "kripl-web-tools.ts");
    const result = await loadPiExtensions([extensionPath], directory);
    assert.deepEqual(result.errors, []);

    const open = result.extensions[0]?.tools.get("web_open");
    assert.ok(open);
    await assert.rejects(
      () => open.definition.execute("call-2", { url: "http://127.0.0.1:4317/" }, undefined, undefined, undefined),
      /Private or local network addresses are blocked/
    );
  } finally {
    if (previousMode === undefined) delete process.env.KRIPL_NETWORK_MODE;
    else process.env.KRIPL_NETWORK_MODE = previousMode;
    await rm(directory, { recursive: true, force: true });
  }
});

test("permission extension classifies Kripl web tools as network scopes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-web-permissions-"));

  try {
    await writePiPermissionGate(directory);
    const extension = await readFile(
      join(directory, "extensions", "kripl-permissions.ts"),
      "utf8"
    );

    assert.match(extension, /event\.toolName === "web_search"/);
    assert.match(extension, /"network\.search"/);
    assert.match(extension, /event\.toolName === "web_open"/);
    assert.match(extension, /"network\.read"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("Pi environment only exposes browser bridge credentials when configured", () => {
  const previousUrl = process.env.KRIPL_TOOL_BRIDGE_URL;
  const previousToken = process.env.KRIPL_TOOL_BRIDGE_TOKEN;
  process.env.KRIPL_TOOL_BRIDGE_URL = "http://127.0.0.1:9999";
  process.env.KRIPL_TOOL_BRIDGE_TOKEN = "inherited-secret";

  try {
    const withoutBridge = createPiEnvironment({ agentDir: "C:/Kripl/pi-agent" });
    assert.equal(withoutBridge.KRIPL_TOOL_BRIDGE_URL, undefined);
    assert.equal(withoutBridge.KRIPL_TOOL_BRIDGE_TOKEN, undefined);

    const withBridge = createPiEnvironment({
      agentDir: "C:/Kripl/pi-agent",
      toolBridge: {
        baseUrl: "http://127.0.0.1:43170",
        token: "bridge-secret"
      }
    });
    assert.equal(withBridge.KRIPL_TOOL_BRIDGE_URL, "http://127.0.0.1:43170");
    assert.equal(withBridge.KRIPL_TOOL_BRIDGE_TOKEN, "bridge-secret");
  } finally {
    if (previousUrl === undefined) delete process.env.KRIPL_TOOL_BRIDGE_URL;
    else process.env.KRIPL_TOOL_BRIDGE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.KRIPL_TOOL_BRIDGE_TOKEN;
    else process.env.KRIPL_TOOL_BRIDGE_TOKEN = previousToken;
  }
});

test("generated browser extension loads and registers interactive browser tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-browser-tools-"));

  try {
    await writePiBrowserTools(directory);
    const extensionPath = join(directory, "extensions", "kripl-browser-tools.ts");
    const result = await loadPiExtensions([extensionPath], directory);

    assert.deepEqual(result.errors, []);
    const tools = result.extensions[0]?.tools;
    assert.ok(tools);
    for (const name of [
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_back",
      "browser_forward"
    ]) {
      assert.equal(tools.has(name), true, `missing browser tool: ${name}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser tools reject offline mode before requiring the bridge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-browser-offline-"));
  const previousMode = process.env.KRIPL_NETWORK_MODE;
  const previousUrl = process.env.KRIPL_TOOL_BRIDGE_URL;
  const previousToken = process.env.KRIPL_TOOL_BRIDGE_TOKEN;

  process.env.KRIPL_NETWORK_MODE = "offline";
  delete process.env.KRIPL_TOOL_BRIDGE_URL;
  delete process.env.KRIPL_TOOL_BRIDGE_TOKEN;

  try {
    await writePiBrowserTools(directory);
    const result = await loadPiExtensions(
      [join(directory, "extensions", "kripl-browser-tools.ts")],
      directory
    );
    assert.deepEqual(result.errors, []);

    const navigate = result.extensions[0]?.tools.get("browser_navigate");
    assert.ok(navigate);
    await assert.rejects(
      () =>
        navigate.definition.execute(
          "browser-call-1",
          { url: "https://example.com/" },
          undefined,
          undefined,
          undefined
        ),
      /offline mode/
    );
  } finally {
    if (previousMode === undefined) delete process.env.KRIPL_NETWORK_MODE;
    else process.env.KRIPL_NETWORK_MODE = previousMode;
    if (previousUrl === undefined) delete process.env.KRIPL_TOOL_BRIDGE_URL;
    else process.env.KRIPL_TOOL_BRIDGE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.KRIPL_TOOL_BRIDGE_TOKEN;
    else process.env.KRIPL_TOOL_BRIDGE_TOKEN = previousToken;
    await rm(directory, { recursive: true, force: true });
  }
});

test("writes a text tool bridge that compiles and registers message_end", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-text-tools-"));

  try {
    await writePiTextToolBridge(directory);
    const source = await readFile(
      join(directory, "extensions", "kripl-text-tools.ts"),
      "utf8"
    );
    assert.match(source, /pi\.on\("message_end"/);

    const result = await loadPiExtensions(
      [join(directory, "extensions", "kripl-text-tools.ts")],
      directory
    );

    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.ok(result.extensions[0]?.handlers.has("message_end"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("permission extension requires approval for browser writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-browser-permissions-"));

  try {
    await writePiPermissionGate(directory);
    const extension = await readFile(
      join(directory, "extensions", "kripl-permissions.ts"),
      "utf8"
    );

    assert.match(extension, /event\.toolName === "browser_snapshot"/);
    assert.match(extension, /event\.toolName === "browser_click"/);
    assert.match(extension, /event\.toolName === "browser_type"/);
    assert.match(extension, /"network\.write"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
