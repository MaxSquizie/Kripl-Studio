import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiAgentRuntime } from "../dist/pi-agent-runtime.js";

function streamResponse(response, model, deltas, finishReason) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const id = `chatcmpl-${randomUUID()}`;
  for (const delta of deltas) {
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  }
  response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function assertNoKeyOnDisk(directory, apiKey) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertNoKeyOnDisk(path, apiKey);
    else assert.equal((await readFile(path, "utf8")).includes(apiKey), false, entry.name);
  }
}

test("Unsloth runs an authenticated streamed Pi tool cycle without saving credentials", { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-unsloth-runtime-"));
  const workspace = join(directory, "workspace");
  const apiKey = randomUUID();
  const modelId = "unsloth/test-coder";
  const requests = [];
  const events = [];
  const failures = [];
  await mkdir(workspace);
  await writeFile(join(workspace, "fixture.txt"), "The local fixture was read successfully.");
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
      let data = "";
      for await (const part of request) data += part;
      const body = JSON.parse(data);
      requests.push(body);
      assert.equal(body.model, modelId);
      assert.equal(body.stream, true);
      assert.equal(body.enable_tools, false);
      if (requests.length === 1) {
        assert.ok(body.tools.some((tool) => tool.function?.name === "read"));
        streamResponse(response, modelId, [
          { role: "assistant", reasoning_content: "Inspecting the local fixture." },
          { tool_calls: [{ index: 0, id: "call-fixture", type: "function", function: { name: "read", arguments: '{"path":' } }] },
          { tool_calls: [{ index: 0, function: { arguments: '"fixture.txt"}' } }] }
        ], "tool_calls");
      } else {
        assert.equal(requests.length, 2);
        const result = body.messages.find((message) => message.role === "tool");
        assert.ok(JSON.stringify(result?.content).includes("The local fixture was read successfully."));
        streamResponse(response, modelId, [{ role: "assistant", content: "Fixture " }, { content: "read." }], "stop");
      }
    } catch (error) {
      failures.push(error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Fixture request failed", type: "server_error" } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const agent = new PiAgentRuntime({
    agentDir: join(directory, "agent"),
    sessionDir: join(directory, "sessions"),
    localModel: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId, server: "unsloth", apiKey },
    networkMode: "offline"
  });
  t.after(async () => {
    await agent.dispose();
    server.close();
    server.closeAllConnections();
    await once(server, "close");
    await rm(directory, { recursive: true, force: true });
  });
  let running = false;
  let resolveSettled;
  let rejectSettled;
  const settled = new Promise((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject; });
  agent.subscribe((event) => {
    events.push(event);
    if (event.type !== "agent.status") return;
    if (event.status === "running") running = true;
    if (running && event.status === "ready") resolveSettled();
    if (event.status === "error") rejectSettled(new Error(event.message));
  });
  const abort = () => rejectSettled(new Error("Runtime test was aborted."));
  t.signal.addEventListener("abort", abort, { once: true });
  try {
    await Promise.all([
      agent.start({ workspacePath: workspace }).then(() => agent.send({ text: "Read fixture.txt and briefly confirm its contents." })),
      settled
    ]);
    assert.deepEqual(failures, []);
    assert.equal(requests.length, 2);
    assert.ok(events.some((event) => event.type === "agent.tool" && event.phase === "completed"));
    assert.ok(events.some((event) => event.type === "agent.stream" && event.channel === "thinking"));
    const snapshot = await agent.getSessionSnapshot();
    assert.ok(snapshot.messages.some((message) => message.role === "assistant" && message.text === "Fixture read."));
    assert.equal(JSON.stringify(snapshot).includes(apiKey), false);
    assert.equal(JSON.stringify(events).includes(apiKey), false);
    await agent.dispose();
    await assertNoKeyOnDisk(directory, apiKey);
  } finally {
    t.signal.removeEventListener("abort", abort);
  }
});

test("a saved LM Studio chat resumes on a different Unsloth endpoint and model with its history intact", { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-model-reconnect-"));
  const workspace = join(directory, "workspace");
  const sessionDir = join(directory, "sessions");
  const oldAgentDir = join(directory, "lm-agent");
  const apiKey = randomUUID();
  const failures = [];
  const endpoints = [];
  const agents = [];
  await mkdir(workspace);

  async function createEndpoint(modelId, authorization, answer, unsloth) {
    const requests = [];
    const server = createServer(async (request, response) => {
      try {
        assert.equal(request.url, "/v1/chat/completions");
        assert.equal(request.headers.authorization, authorization);
        let source = "";
        for await (const part of request) source += part;
        const body = JSON.parse(source);
        requests.push(body);
        assert.equal(body.model, modelId);
        assert.equal(body.enable_tools, unsloth ? false : undefined);
        streamResponse(response, modelId, [{ role: "assistant", content: answer }], "stop");
      } catch (error) {
        failures.push(error);
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Reconnect fixture failed", type: "server_error" } }));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    endpoints.push(server);
    return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
  }

  async function sendAndSettle(agent, text) {
    let running = false;
    let unsubscribe;
    let abort;
    const settled = new Promise((resolve, reject) => {
      unsubscribe = agent.subscribe((event) => {
        if (event.type !== "agent.status") return;
        if (event.status === "running") running = true;
        if (running && event.status === "ready") resolve();
        if (event.status === "error") reject(new Error(event.message));
      });
      abort = () => reject(new Error("Reconnect test was aborted."));
      t.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      await Promise.all([agent.send({ text }), settled]);
    } finally {
      unsubscribe();
      t.signal.removeEventListener("abort", abort);
    }
  }

  t.after(async () => {
    await Promise.all(agents.map((agent) => agent.dispose()));
    await Promise.all(endpoints.map(async (server) => {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    }));
    await rm(directory, { recursive: true, force: true });
  });

  const lm = await createEndpoint("lm/first-coder", "Bearer kripl-local", "Original LM Studio answer.", false);
  const first = new PiAgentRuntime({
    agentDir: oldAgentDir,
    sessionDir,
    localModel: { baseUrl: lm.baseUrl, modelId: "lm/first-coder", server: "lm-studio" },
    networkMode: "offline"
  });
  agents.push(first);
  await first.start({ workspacePath: workspace });
  await sendAndSettle(first, "Remember the original chat request.");
  const saved = await first.getSessionSnapshot();
  assert.ok(saved.sessionFile);
  assert.equal(saved.messages.length, 2);
  await first.dispose();
  await rm(oldAgentDir, { recursive: true, force: true });

  const unsloth = await createEndpoint("unsloth/second-coder", `Bearer ${apiKey}`, "Continued with Unsloth.", true);
  const resumed = new PiAgentRuntime({
    agentDir: join(directory, "unsloth-agent"),
    sessionDir,
    localModel: { baseUrl: unsloth.baseUrl, modelId: "unsloth/second-coder", server: "unsloth", apiKey },
    networkMode: "offline"
  });
  agents.push(resumed);
  await resumed.start({ workspacePath: workspace, sessionPath: saved.sessionFile });
  const before = await resumed.getSessionSnapshot();
  assert.equal(before.sessionFile, saved.sessionFile);
  assert.equal(before.sessionId, saved.sessionId);
  assert.deepEqual(before.messages, saved.messages);
  await sendAndSettle(resumed, "Continue the same chat using the new model.");
  assert.deepEqual(failures, []);
  assert.equal(lm.requests.length, 1);
  assert.equal(unsloth.requests.length, 1);
  const sentHistory = JSON.stringify(unsloth.requests[0].messages);
  assert.ok(sentHistory.includes("Remember the original chat request."));
  assert.ok(sentHistory.includes("Original LM Studio answer."));
  assert.ok(sentHistory.includes("Continue the same chat using the new model."));
  const after = await resumed.getSessionSnapshot();
  assert.equal(after.sessionFile, saved.sessionFile);
  assert.deepEqual(after.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "Remember the original chat request." },
    { role: "assistant", text: "Original LM Studio answer." },
    { role: "user", text: "Continue the same chat using the new model." },
    { role: "assistant", text: "Continued with Unsloth." }
  ]);
});
