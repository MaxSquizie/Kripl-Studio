import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const compiled = buildSync({
  entryPoints: [fileURLToPath(new URL("../src/main/local-model-requests.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", packages: "external", write: false,
  alias: {
    "@kripl/local-openai-provider": fileURLToPath(new URL("../../../packages/local-openai-provider/src/index.ts", import.meta.url))
  }
}).outputFiles[0].text;
const requestModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  createRequire(import.meta.url), requestModule, requestModule.exports
);
const { resolveLocalModel, generateLocalSessionTitle } = requestModule.exports;

async function fixture(t, handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let content = "";
    for await (const chunk of request) content += chunk;
    const entry = {
      path: request.url, headers: request.headers,
      body: content ? JSON.parse(content) : undefined
    };
    requests.push(entry);
    response.setHeader("content-type", "application/json");
    handler(entry, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

test("Unsloth validation and automatic titles use the selected server credential", async (t) => {
  const { endpoint, requests } = await fixture(t, (request, response) => {
    if (request.headers.authorization !== "Bearer fixture-api-key") {
      response.writeHead(401).end("{}");
    } else if (request.path === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "local-chat", loaded: true, context_length: 65536 }] }));
    } else {
      response.end(JSON.stringify({ choices: [{ message: { content: '"Local model support."' } }] }));
    }
  });
  const connection = { server: "unsloth", endpoint };
  const credentials = { get: async (value) => {
    assert.deepEqual(value, connection);
    return "fixture-api-key";
  } };
  const model = await resolveLocalModel(connection, "local-chat", credentials);
  assert.equal(await generateLocalSessionTitle(model, "Connect another server"), "Local model support");
  assert.deepEqual(requests.map((request) => request.path), ["/v1/models", "/v1/chat/completions"]);
  assert.equal(requests[1].body.model, "local-chat");
  assert.equal(requests[1].body.enable_tools, false);
  assert.equal(requests[1].body.max_tokens, 24);
  assert.equal(requests[1].body.stream, undefined);
  assert.equal(JSON.stringify(requests[1].body).includes("fixture-api-key"), false);
});

test("legacy LM Studio connections remain usable without an API key", async (t) => {
  const { endpoint, requests } = await fixture(t, (request, response) => {
    response.end(JSON.stringify(request.path === "/v1/models"
      ? { data: [{ id: "lm-chat", max_context_length: 32768 }] }
      : { choices: [{ message: { content: "Existing chat" } }] }));
  });
  const model = await resolveLocalModel({ endpoint }, "lm-chat", { get: async () => undefined });
  assert.equal(model.server, "lm-studio");
  assert.equal(await generateLocalSessionTitle(model, "Continue"), "Existing chat");
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[1].headers.authorization, undefined);
  assert.equal(Object.hasOwn(requests[1].body, "enable_tools"), false);
});

test("starting a downloaded but unloaded Unsloth model requires loading it first", async (t) => {
  const { endpoint, requests } = await fixture(t, (_request, response) => {
    response.end(JSON.stringify({ data: [{ id: "downloaded", loaded: false }] }));
  });
  await assert.rejects(
    resolveLocalModel({ server: "unsloth", endpoint }, "downloaded", { get: async () => "fixture-api-key" }),
    /Load the selected chat model in Unsloth/
  );
  assert.equal(requests.length, 1);
});

test("a credential rotation during validation cannot start a runtime with the old key", async (t) => {
  const { endpoint } = await fixture(t, (_request, response) => {
    response.end(JSON.stringify({ data: [{ id: "chat", loaded: true }] }));
  });
  let reads = 0;
  await assert.rejects(
    resolveLocalModel({ server: "unsloth", endpoint }, "chat", {
      get: async () => ++reads === 1 ? "fixture-old-key" : "fixture-new-key"
    }),
    /server credentials changed/
  );
});

test("authenticated title requests never follow server redirects", async (t) => {
  const { endpoint, requests } = await fixture(t, (_request, response) => {
    response.writeHead(307, { location: "/redirect-target" }).end("{}");
  });
  const title = await generateLocalSessionTitle({
    server: "unsloth", endpoint, modelId: "chat", apiKey: "fixture-api-key"
  }, "Example");
  assert.equal(title, undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/v1/chat/completions");
});
