import assert from "node:assert/strict";
import test from "node:test";

import { PiAgentRuntime } from "../dist/pi-agent-runtime.js";
import { PiRpcProcess } from "../dist/rpc-process.js";

function runtime() {
  return new PiAgentRuntime({
    agentDir: "C:/Kripl/pi-agent",
    localModel: { baseUrl: "http://127.0.0.1:1234/v1", modelId: "test-local" }
  });
}

test("repeated session metadata reads never request conversation history", async (t) => {
  const commands = [];
  let messageCount = 1;
  t.mock.method(PiRpcProcess.prototype, "send", async (command) => {
    commands.push(command.type);
    assert.equal(command.type, "get_state", "metadata lookup must not send get_messages");
    return {
      success: true,
      data: {
        sessionId: "session-1",
        sessionFile: "C:/sessions/session-1.jsonl",
        sessionName: "Long conversation",
        messageCount,
        model: { apiKey: "not-part-of-the-session-contract" }
      }
    };
  });

  const agent = runtime();
  for (messageCount = 1; messageCount <= 80; messageCount += 1) {
    assert.deepEqual(await agent.getSessionInfo(), {
      sessionId: "session-1",
      sessionFile: "C:/sessions/session-1.jsonl",
      sessionName: "Long conversation",
      messageCount
    });
  }
  assert.equal(commands.length, 80);
});

test("session metadata follows changed state instead of caching a stale binding", async (t) => {
  let state = { sessionId: "first", messageCount: 0 };
  t.mock.method(PiRpcProcess.prototype, "send", async () => ({ success: true, data: state }));

  const agent = runtime();
  assert.deepEqual(await agent.getSessionInfo(), { sessionId: "first", messageCount: 0 });
  state = {
    sessionId: "second",
    sessionFile: "C:/sessions/second.jsonl",
    sessionName: "Renamed",
    messageCount: 12.9
  };
  assert.deepEqual(await agent.getSessionInfo(), {
    sessionId: "second",
    sessionFile: "C:/sessions/second.jsonl",
    sessionName: "Renamed",
    messageCount: 12
  });
});

test("explicit transcript snapshots still fetch and normalize messages", async (t) => {
  const commands = [];
  t.mock.method(PiRpcProcess.prototype, "send", async (command) => {
    commands.push(command.type);
    if (command.type === "get_state") {
      return { success: true, data: { sessionId: "session-1", messageCount: 2 } };
    }
    assert.equal(command.type, "get_messages");
    return {
      success: true,
      data: {
        messages: [
          { role: "user", content: "Inspect the project" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Internal details" },
              { type: "text", text: "Done" }
            ]
          }
        ]
      }
    };
  });

  assert.deepEqual(await runtime().getSessionSnapshot(), {
    sessionId: "session-1",
    messageCount: 2,
    messages: [
      { role: "user", text: "Inspect the project" },
      { role: "assistant", text: "Done" }
    ]
  });
  assert.deepEqual(commands.sort(), ["get_messages", "get_state"]);
});

test("session metadata rejects failed and incomplete Pi responses", async (t) => {
  let response = { success: false, error: "Pi unavailable" };
  t.mock.method(PiRpcProcess.prototype, "send", async () => response);
  const agent = runtime();

  await assert.rejects(agent.getSessionInfo(), /Pi unavailable/);
  response = { success: true, data: { messageCount: 4 } };
  await assert.rejects(agent.getSessionInfo(), /missing sessionId/);
});
