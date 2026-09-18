# Kripl Studio

Kripl Studio is an offline-first desktop workspace for agentic coding with local models.

The long-term goal is a Windows application where the coding agent, model backend, memory system, workspace tools, and UI are independent subsystems. Pi is the first agent runtime, not the permanent application core.

## Direction

```text
Kripl Studio Desktop
        |
        +-- Workspace runtime
        |     +-- files
        |     +-- git / diffs
        |     +-- terminal / tests
        |
        +-- AgentRuntime
        |     +-- Pi adapter (first implementation)
        |
        +-- ModelProvider
        |     +-- local OpenAI-compatible servers
        |     +-- LM Studio / llama.cpp / others
        |
        +-- MemoryRuntime
              +-- Noop memory
              +-- AG Memory (future)
```

Runtime operation is intended to remain fully local. Cloud providers may be added later only as explicit opt-in integrations; there must be no silent cloud fallback.

## Current bootstrap

The repository currently contains:

- Electron desktop shell;
- React renderer;
- secure preload bridge and narrow IPC surface;
- native Windows folder picker;
- subsystem contracts in `@kripl/core`;
- isolated Pi RPC adapter in `@kripl/pi-adapter`;
- Pi startup defaults that disable update checks and telemetry and force offline mode.

The first UI is intentionally minimal. Explorer, agent chat, Changes/Diff review, terminal, model management, permissions, and memory inspection will be built on top of these boundaries.

## Development

Requirements:

- Node.js 22.19 or newer;
- Windows 11 is the primary target;
- Git for Windows / Git Bash will be required when Pi executes Bash-based tools.

Install:

```powershell
git clone https://github.com/MaxSquizie/Kripl-Studio.git
cd Kripl-Studio
npm install
```

Run the desktop app:

```powershell
npm run dev
```

Static checks:

```powershell
npm run typecheck
npm run build
```

Build a Windows installer:

```powershell
npm run dist:win
```

The installer pipeline is scaffolded now; product metadata, icons, signing, and release automation will be finalized after the first functional agent loop is integrated.

## Offline-first runtime policy

Kripl Studio's Pi adapter starts Pi with:

```text
PI_OFFLINE=1
PI_TELEMETRY=0
PI_SKIP_VERSION_CHECK=1
```

These variables disable Pi startup/update network work, but they are not a general network firewall and do not by themselves prevent a configured remote inference provider from making requests. Kripl Studio will therefore keep the agent composer disabled until a model/provider is explicitly classified as local. A stronger egress guard can be added later as defense in depth.

Features requiring remote network access must be explicit and opt-in; there is no automatic cloud fallback.

## License

No project license has been selected yet.
