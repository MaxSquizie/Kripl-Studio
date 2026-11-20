import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { LocalOpenAIProvider } from "../dist/index.js";

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
}

test("Unsloth discovers loaded chat models with authentication and the running context window", async () => {
  const apiKey = randomUUID();
  const paths = [];
  await withServer((request, response) => {
    paths.push(request.url);
    assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [
      { id: "unsloth/coder", owned_by: "unsloth-studio", loaded: true, status: { value: "loaded" }, display_name: "Local coder", context_length: 32768, max_context_length: 8192 },
      { id: "unloaded-coder", loaded: false },
      { id: "speech", loaded: true, task: "text-to-speech" },
      { id: "image", loaded: true, task: "text-to-image" },
      { id: "video", loaded: true, task: "text-to-video" },
      { id: "transcription", loaded: true, task: "automatic-speech-recognition" },
      { id: "separation", loaded: true, task: "audio-to-audio" }
    ] }));
  }, async (baseUrl) => {
    const models = await new LocalOpenAIProvider({ baseUrl, server: "unsloth", apiKey }).listModels();
    assert.deepEqual(models, [{ provider: "local-openai", id: "unsloth/coder", name: "Local coder", local: true, input: ["text"], contextWindow: 32768 }]);
  });
  assert.deepEqual(paths, ["/v1/models"]);
});

test("Unsloth accepts older OpenAI model lists and never probes LM Studio routes", async () => {
  const paths = [];
  await withServer((request, response) => {
    paths.push(request.url);
    assert.equal(request.headers.authorization, undefined);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "legacy-coder" }] }));
  }, async (baseUrl) => {
    const models = await new LocalOpenAIProvider({ baseUrl, server: "unsloth" }).listModels();
    assert.equal(models[0].id, "legacy-coder");
    assert.equal(models[0].contextWindow, undefined);
  });
  assert.deepEqual(paths, ["/v1/models"]);
});

test("Unsloth excludes unavailable models when only status identifies residency", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [
      { id: "unloaded", status: { value: "unloaded" } },
      { id: "loading", status: "loading" },
      { id: "unavailable", loaded: false, status: { value: "loaded" } }
    ] }));
  }, async (baseUrl) => {
    assert.deepEqual(await new LocalOpenAIProvider({ baseUrl, server: "unsloth" }).listModels(), []);
  });
});

test("LM Studio authenticates both model discovery and native context fallback", async () => {
  const apiKey = randomUUID();
  const paths = [];
  await withServer((request, response) => {
    paths.push(request.url);
    assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "lm-coder", ...(request.url === "/api/v0/models" ? { max_context_length: 65536 } : {}) }] }));
  }, async (baseUrl) => {
    const models = await new LocalOpenAIProvider({ baseUrl, server: "lm-studio", apiKey }).listModels();
    assert.equal(models[0].contextWindow, 65536);
  });
  assert.deepEqual(paths, ["/v1/models", "/api/v0/models"]);
});

test("authentication failures report the action to take without echoing server secrets", async () => {
  const apiKey = randomUUID();
  for (const status of [401, 403]) {
    await withServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: apiKey }));
    }, async (baseUrl) => {
      await assert.rejects(new LocalOpenAIProvider({ baseUrl, server: "unsloth", apiKey }).listModels(), (error) => {
        assert.match(error.message, /API key.*model access/);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.equal(error.message.includes(apiKey), false);
        return true;
      });
    });
  }
});

test("authenticated discovery refuses redirects and malformed response text", async () => {
  const apiKey = randomUUID();
  let mode = "redirect";
  const paths = [];
  await withServer((request, response) => {
    paths.push(request.url);
    if (mode === "redirect") {
      response.writeHead(302, { location: "/other-server/models" });
      response.end();
    } else {
      response.end(apiKey);
    }
  }, async (baseUrl) => {
    const provider = new LocalOpenAIProvider({ baseUrl, server: "unsloth", apiKey });
    await assert.rejects(provider.listModels());
    mode = "invalid";
    await assert.rejects(provider.listModels(), (error) => {
      assert.equal(error.message.includes(apiKey), false);
      assert.match(error.message, /invalid \/models payload/);
      return true;
    });
  });
  assert.deepEqual(paths, ["/v1/models", "/v1/models"]);
});
