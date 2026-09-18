# Kripl Studio

Kripl Studio is a Windows desktop workspace for agentic coding with local models and network-capable tools.

The primary profile is **local inference + online tools**: the model can run in LM Studio, llama.cpp, or another local backend while the agent still uses browser search, documentation, GitHub, package registries, and other network tools when permitted.

Kripl Studio must also remain usable offline. Offline mode is a separate runtime policy, not the default architecture.

## Core direction

```text
Kripl Studio
├─ WorkspaceRuntime     files / git / diffs / terminal / tests
├─ AgentRuntime         Pi first, replaceable later
├─ ModelProvider        LM Studio / llama.cpp / local OpenAI-compatible
├─ Tool + Network layer browser / search / GitHub / docs / downloads
└─ MemoryRuntime        Noop now, AG Memory later
```

Model routing and network access are deliberately orthogonal:

```text
default model routing: local-only
default network mode:  online
cloud fallback:        disabled
```

Planned network modes:

- **Online** — local model, network tools enabled according to permissions.
- **Restricted** — local model, network requests gated by approval/domain policy.
- **Offline** — first-party network tools disabled and Pi started with `PI_OFFLINE=1`.

`PI_OFFLINE` is not an OS firewall. Shell commands require a separate sandbox if hard egress blocking is needed.

## Current bootstrap

- Electron + React desktop shell
- secure preload/IPC boundary
- native Windows workspace picker
- `AgentRuntime`, `ModelProvider`, `MemoryRuntime`, `WorkspaceRuntime` contracts
- explicit network/model policy split
- isolated Pi RPC adapter
- strict local OpenAI-compatible model discovery
- Windows NSIS installer scaffold

## Development

Requirements:

- Node.js 22.19 or newer
- Windows 11 as primary target
- Git for Windows / Git Bash for Bash-based Pi tools

```powershell
git clone https://github.com/MaxSquizie/Kripl-Studio.git
cd Kripl-Studio
npm install
npm test
npm run typecheck
npm run build
npm run dev
```

Build a Windows installer:

```powershell
npm run dist:win
```

## License

No project license has been selected yet.
