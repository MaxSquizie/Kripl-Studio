# Kripl Studio architecture

## Purpose

Kripl Studio is a desktop environment for agentic software development. Its primary profile combines local inference with online-capable agent tools while preserving a separate offline mode.

No implementation is allowed to become the architecture. Pi, LM Studio, browser/search backends, and AG Memory are implementations behind contracts.

## High-level layers

```text
Desktop UI
   │
   ├─ AgentRuntime ── Pi adapter
   ├─ ModelProvider ── local model server
   ├─ WorkspaceRuntime ── files / git / terminal / tests
   ├─ Tool + Network layer ── browser / search / GitHub / docs
   └─ MemoryRuntime ── Noop / AG Memory
```

## Two independent policy axes

Model location and network access are orthogonal.

```text
                     network
                 online  offline
local model         yes      yes
remote model      future      no
```

Default:

```text
modelRouting = local-only
networkMode  = online
```

This lets LM Studio/llama.cpp inference remain local while browser search, documentation lookup, GitHub, downloads, package registries, and similar tools remain available.

There is no automatic cloud-model fallback.

## Network modes

### Online
Network-capable tools may operate subject to normal permission policy. Pi is not started with `PI_OFFLINE`.

### Restricted
Network requests are allowed only after policy checks such as user approval, domain allow/deny lists, tool-specific permissions, and credential scope.

### Offline
First-party network tools are disabled and Pi is started with `PI_OFFLINE=1`.

`PI_OFFLINE` is not an operating-system firewall. Arbitrary shell processes can still attempt network access; hard offline guarantees require a separate egress sandbox/firewall layer.

## AgentRuntime

The UI consumes normalized `AgentEvent` values, never raw Pi protocol. Raw Pi events may remain inside the desktop process for diagnostics.

## ModelProvider

Model discovery and inference routing are separate from browser/search/network tooling. Initial policy is local-only; remote providers can be added later behind an explicit policy.

## Tool and network layer

Browser/search is a first-class agent capability. This layer will own browser navigation, web search, HTTP/document retrieval, GitHub/docs integrations, downloads, permissions, credential scope, and offline/restricted enforcement.

## MemoryRuntime

Memory is independent from agent and network policy. AG Memory should later attach through this boundary and subscribe to the same application event stream.

## WorkspaceRuntime

Workspace state owns files, git state, diffs, terminal sessions, tests, diagnostics, and future filesystem checkpoints/worktrees. Pi session forking must never be treated as a filesystem branch.

## Planned implementation order

1. Desktop shell and subsystem boundaries.
2. Pi RPC lifecycle and normalized streaming events.
3. Local model discovery/configuration.
4. Agent chat and tool-call presentation.
5. File explorer and viewer.
6. Changes / project-wide diff review.
7. Permission policy.
8. Browser/search/network tool layer.
9. Integrated terminal.
10. Task/agent-state observability.
11. Memory inspector.
12. AG Memory adapter.
13. Git worktrees/checkpoints and multi-agent workflows.
