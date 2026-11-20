import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiEnvironment } from "../dist/rpc-process.js";
import { KRIPL_LOCAL_MODEL_API_KEY_ENV, KRIPL_PI_PROVIDER, writePiLocalModelConfig } from "../dist/pi-local-config.js";
import { writePiLocalCompatibility } from "../dist/pi-local-compat.js";

const packageRoot = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const loader = await import(pathToFileURL(join(packageRoot, "core", "extensions", "loader.js")).href);
const { resolveConfigValue } = await import(pathToFileURL(join(packageRoot, "core", "resolve-config-value.js")).href);

test("Pi resolves a connection key from its child environment without writing the key to models.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-pi-auth-"));
  const apiKey = randomUUID();
  try {
    await writePiLocalModelConfig(directory, { baseUrl: "http://127.0.0.1:8888/v1", modelId: "unsloth/coder", server: "unsloth", apiKey });
    const source = await readFile(join(directory, "models.json"), "utf8");
    assert.equal(source.includes(apiKey), false);
    const reference = JSON.parse(source).providers[KRIPL_PI_PROVIDER].apiKey;
    const environment = createPiEnvironment({ agentDir: directory, localModelServer: "unsloth", localModelApiKey: apiKey });
    assert.equal(reference, `$${KRIPL_LOCAL_MODEL_API_KEY_ENV}`);
    assert.equal(resolveConfigValue(reference, environment), apiKey);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("connection credentials and server selection cannot leak between child environments", () => {
  const previousKey = process.env[KRIPL_LOCAL_MODEL_API_KEY_ENV];
  const previousServer = process.env.KRIPL_LOCAL_MODEL_SERVER;
  const firstKey = randomUUID();
  const secondKey = randomUUID();
  process.env[KRIPL_LOCAL_MODEL_API_KEY_ENV] = firstKey;
  process.env.KRIPL_LOCAL_MODEL_SERVER = "unsloth";
  try {
    const first = createPiEnvironment({ agentDir: "first", localModelServer: "unsloth", localModelApiKey: firstKey });
    const second = createPiEnvironment({ agentDir: "second", localModelServer: "unsloth", localModelApiKey: secondKey });
    const lm = createPiEnvironment({ agentDir: "lm" });
    const keyless = createPiEnvironment({ agentDir: "keyless", localModelServer: "unsloth" });
    assert.equal(first[KRIPL_LOCAL_MODEL_API_KEY_ENV], firstKey);
    assert.equal(second[KRIPL_LOCAL_MODEL_API_KEY_ENV], secondKey);
    assert.equal(lm[KRIPL_LOCAL_MODEL_API_KEY_ENV], "kripl-local");
    assert.equal(lm.KRIPL_LOCAL_MODEL_SERVER, "lm-studio");
    assert.equal(keyless[KRIPL_LOCAL_MODEL_API_KEY_ENV], "not-needed");
    assert.equal(process.env[KRIPL_LOCAL_MODEL_API_KEY_ENV], firstKey);
  } finally {
    if (previousKey === undefined) delete process.env[KRIPL_LOCAL_MODEL_API_KEY_ENV];
    else process.env[KRIPL_LOCAL_MODEL_API_KEY_ENV] = previousKey;
    if (previousServer === undefined) delete process.env.KRIPL_LOCAL_MODEL_SERVER;
    else process.env.KRIPL_LOCAL_MODEL_SERVER = previousServer;
  }
});

test("the local compatibility extension only overrides the Unsloth transport", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-pi-compat-"));
  const previousServer = process.env.KRIPL_LOCAL_MODEL_SERVER;
  try {
    await writePiLocalCompatibility(directory);
    const path = join(directory, "extensions", "kripl-local-compat.ts");
    process.env.KRIPL_LOCAL_MODEL_SERVER = "lm-studio";
    const lm = await loader.loadExtensions([path], directory);
    assert.deepEqual(lm.errors, []);
    assert.equal(lm.runtime.pendingProviderRegistrations.length, 0);
    process.env.KRIPL_LOCAL_MODEL_SERVER = "unsloth";
    const unsloth = await loader.loadExtensions([path], directory);
    assert.deepEqual(unsloth.errors, []);
    const [provider] = unsloth.runtime.pendingProviderRegistrations;
    assert.equal(provider.name, KRIPL_PI_PROVIDER);
    assert.equal(provider.config.api, "openai-completions");
    assert.equal(typeof provider.config.streamSimple, "function");
    assert.equal(provider.config.apiKey, undefined);
  } finally {
    if (previousServer === undefined) delete process.env.KRIPL_LOCAL_MODEL_SERVER;
    else process.env.KRIPL_LOCAL_MODEL_SERVER = previousServer;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Unsloth disables server tools for direct summary requests and preserves payload and response callbacks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-pi-summary-"));
  const apiKey = randomUUID();
  const previousServer = process.env.KRIPL_LOCAL_MODEL_SERVER;
  const requests = [];
  const failures = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
      let source = "";
      for await (const chunk of request) source += chunk;
      requests.push(JSON.parse(source));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "summary", object: "chat.completion.chunk", model: "test-coder", choices: [{ index: 0, delta: { role: "assistant", content: "Summary." }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "summary", object: "chat.completion.chunk", model: "test-coder", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) {
      failures.push(error);
      response.writeHead(500);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await writePiLocalModelConfig(directory, { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId: "test-coder", server: "unsloth", apiKey });
    await writePiLocalCompatibility(directory);
    process.env.KRIPL_LOCAL_MODEL_SERVER = "unsloth";
    const extension = await loader.loadExtensions([join(directory, "extensions", "kripl-local-compat.ts")], directory);
    assert.deepEqual(extension.errors, []);
    const runtime = await ModelRuntime.create({ modelsPath: join(directory, "models.json"), authPath: join(directory, "auth.json"), allowModelNetwork: false, refreshOnCreate: false });
    const [provider] = extension.runtime.pendingProviderRegistrations;
    runtime.registerProvider(provider.name, provider.config);
    const model = runtime.getModel(KRIPL_PI_PROVIDER, "test-coder");
    const context = { messages: [{ role: "user", content: "Summarize the chat.", timestamp: 1 }] };
    const responses = [];
    const plain = await runtime.completeSimple(model, context, { apiKey, onResponse: (response) => responses.push(response.status) });
    const replaced = await runtime.completeSimple(model, context, { apiKey, onPayload: (payload) => ({ ...payload, enable_tools: true, fixture_marker: "preserved" }), onResponse: (response) => responses.push(response.status) });
    assert.equal(plain.stopReason, "stop");
    assert.equal(replaced.stopReason, "stop");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].enable_tools, false);
    assert.equal(requests[1].enable_tools, false);
    assert.equal(requests[1].fixture_marker, "preserved");
    assert.deepEqual(responses, [200, 200]);
    assert.deepEqual(failures, []);
  } finally {
    if (previousServer === undefined) delete process.env.KRIPL_LOCAL_MODEL_SERVER;
    else process.env.KRIPL_LOCAL_MODEL_SERVER = previousServer;
    server.close();
    server.closeAllConnections();
    await once(server, "close");
    await rm(directory, { recursive: true, force: true });
  }
});
