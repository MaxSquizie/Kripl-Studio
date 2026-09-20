import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import {
  LocalOpenAIProvider,
  NonLocalEndpointError,
  normalizeLocalOpenAIBaseUrl
} from "../dist/index.js";

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("normalizes localhost to an explicit loopback OpenAI endpoint", () => {
  assert.equal(
    normalizeLocalOpenAIBaseUrl("http://localhost:1234/"),
    "http://127.0.0.1:1234/v1"
  );
});

test("rejects non-loopback endpoints", () => {
  assert.throws(
    () => normalizeLocalOpenAIBaseUrl("https://example.com/v1"),
    NonLocalEndpointError
  );
});

test("rejects credentials embedded in endpoint URLs", () => {
  assert.throws(
    () => normalizeLocalOpenAIBaseUrl("http://user:password@127.0.0.1:1234/v1"),
    NonLocalEndpointError
  );
});

test("discovers OpenAI-compatible models from a loopback server", async () => {
  await withServer(
    (request, response) => {
      if (request.url === "/v1/models") {
        // OpenAI-compatible list without any context size reported.
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "local-coder" }] }));
      } else if (request.url === "/api/v0/models") {
        // LM Studio native API on the same port reports the context window.
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ data: [{ id: "local-coder", max_context_size: 131072 }] })
        );
      } else {
        response.writeHead(404);
        response.end();
      }
    },
    async (origin) => {
      const provider = new LocalOpenAIProvider({ baseUrl: origin });
      assert.deepEqual(await provider.listModels(), [
        {
          provider: "local-openai",
          id: "local-coder",
          name: "local-coder",
          local: true,
          input: ["text"],
          contextWindow: 131072
        }
      ]);
    }
  );
});

test("reads the context window reported by an OpenAI-compatible server", async () => {
  await withServer(
    (request, response) => {
      assert.equal(request.url, "/v1/models");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ data: [{ id: "local-coder", max_context_size: 65536 }] })
      );
    },
    async (origin) => {
      const provider = new LocalOpenAIProvider({ baseUrl: origin });
      assert.deepEqual(await provider.listModels(), [
        {
          provider: "local-openai",
          id: "local-coder",
          name: "local-coder",
          local: true,
          input: ["text"],
          contextWindow: 65536
        }
      ]);
    }
  );
});

test("reads LM Studio native max_context_length as the context window", async () => {
  await withServer(
    (request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "local-coder" }] }));
      } else if (request.url === "/api/v0/models") {
        // Current LM Studio field names for the native model list.
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: [
              {
                id: "local-coder",
                max_context_length: 131072,
                loaded_context_length: 32768
              }
            ]
          })
        );
      } else {
        response.writeHead(404);
        response.end();
      }
    },
    async (origin) => {
      const provider = new LocalOpenAIProvider({ baseUrl: origin });
      assert.deepEqual(await provider.listModels(), [
        {
          provider: "local-openai",
          id: "local-coder",
          name: "local-coder",
          local: true,
          input: ["text"],
          contextWindow: 131072
        }
      ]);
    }
  );
});

test("does not follow redirects from a loopback model endpoint", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(302, { location: "https://example.com/v1/models" });
      response.end();
    },
    async (origin) => {
      const provider = new LocalOpenAIProvider({ baseUrl: origin });
      await assert.rejects(() => provider.listModels());
    }
  );
});
