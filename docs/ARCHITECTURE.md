# Kripl Studio architecture

## Purpose

Kripl Studio is a local desktop environment for agentic software development. The architecture must support local coding models today and higher-level systems such as AG Memory later without replacing the desktop UI or agent-control layer.

## Core rule

No implementation is allowed to become the architecture.

Pi, LM Studio, a particular local model, and AG Memory are all implementations behind contracts.

## Layers

```text
┌──────────────────────────────────────────────────────────┐
│                    Desktop UI                            │
│ Explorer | Agent | Editor | Changes | Terminal | Memory │
└─────────────────────────┬────────────────────────────────┘
                          │ typed IPC
┌─────────────────────────▼────────────────────────────────┐
│                 Application / desktop core               │
│ workspace selection | orchestration | settings | events │
└─────────────┬──────────────────┬──────────────────┬───────┘
              │                  │                  │
        AgentRuntime       MemoryRuntime       WorkspaceRuntime
              │                  │                  │
       PiAgentRuntime      Noop / AG Memory    files/git/pty
              │
         Pi JSONL RPC
              │
          local model
```

## `AgentRuntime`

The application talks to an abstract coding agent. An agent runtime owns the execution/session loop and emits normalized `AgentEvent` values.

The first implementation is `PiAgentRuntime`.

The UI must not consume Pi-specific messages directly. Raw Pi events may be preserved for diagnostics, but normalized events are the product-facing contract.

## `MemoryRuntime`

Memory is independent from the agent.

A memory runtime can:

- observe application/agent events;
- retrieve relevant memory for a query;
- later contribute structured context before model execution.

The initial implementation is effectively disabled/no-op. AG Memory should later be attached at this boundary, not embedded into React components or Pi internals.

## `ModelProvider`

Model discovery and health are modeled separately from the agent runtime even though Pi initially owns much of model execution.

This keeps the application open to:

- LM Studio;
- llama.cpp;
- Ollama;
- another OpenAI-compatible local server;
- a future custom inference runtime.

The long-term orchestrator may choose a model provider independently of the coding-agent implementation.

## `WorkspaceRuntime`

Conversation state and filesystem state are different concepts.

A workspace runtime will own:

- project path;
- file tree;
- file reads;
- git state;
- diff calculation;
- terminal sessions;
- tests and diagnostics;
- future filesystem checkpoints/worktrees.

Pi session forking must never be treated as a filesystem branch.

## Event model

Cross-system integration should happen through events rather than direct component knowledge.

Examples:

```text
workspace.opened
agent.status
agent.message
agent.tool
model.request
model.completed
memory.retrieved
memory.observed
workspace.changed
```

AG Memory can eventually subscribe to the same event stream that drives observability in the UI.

## Electron security boundary

Renderer code has no direct Node.js access.

The desktop process owns:

- filesystem/native dialogs;
- child processes;
- Pi;
- future PTY;
- credentials/configuration.

The renderer only receives explicitly exposed preload APIs.

## Offline behavior

Offline is an invariant, not a UI toggle added later.

Default runtime:

```text
PI_OFFLINE=1
PI_TELEMETRY=0
PI_SKIP_VERSION_CHECK=1
```

These flags suppress Pi startup/update networking; they do not constitute a complete inference-network sandbox. Before agent execution is enabled, Kripl Studio must validate that the active provider/model is local (for example, loopback-hosted LM Studio or llama.cpp).

There is no automatic remote fallback when the local model is unavailable. A future online mode must require an explicit user action and make the active provider visible.

## Planned implementation order

1. Desktop shell and subsystem boundaries.
2. Pi RPC lifecycle and normalized streaming events.
3. Local model discovery/configuration.
4. Agent chat and tool-call presentation.
5. File explorer and viewer.
6. Changes / project-wide diff review.
7. Integrated terminal.
8. Permission policy.
9. Task/agent-state observability.
10. Memory inspector.
11. AG Memory adapter.
12. Git worktrees/checkpoints and multi-agent workflows.
