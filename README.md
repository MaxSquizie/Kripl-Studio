# Kripl Studio

A Windows desktop workspace for agentic coding that is **local-model-first, network-capable, and offline-capable**. The agent runs on [Pi](https://github.com/earendil-works/pi) behind an isolated RPC adapter; inference runs against a local OpenAI-compatible server (LM Studio, Unsloth Studio, llama.cpp, or similar). Browser search, documentation lookup, GitHub, package registries, and other network tools remain available when the policy allows — and everything keeps working when they don't.

## Design principles

- **Local model first.** The default model routing is `local-only`. There is no silent fallback to a cloud model, ever.
- **Routing and network are separate policies.** Where inference runs and which tools may reach the network are orthogonal axes:

  ```text
  default model routing: local-only
  default network mode:  online
  cloud fallback:        disabled (by design)
  ```

- **Offline is a mode, not the architecture.** `offline` disables first-party network tools and starts Pi with `PI_OFFLINE=1`. Note that `PI_OFFLINE` is not an OS firewall — hard egress isolation for arbitrary shell commands belongs in a separate sandbox layer.
- **Replaceable subsystems.** The UI consumes stable contracts (`AgentRuntime`, `ModelProvider`, `WorkspaceRuntime`, `TerminalRuntime`, `MemoryRuntime`, …) from `@kripl/core`. Pi is one adapter behind `AgentRuntime`; memory is a Noop implementation today and can be swapped (e.g. for AG Memory) without touching the UI.
- **Secure desktop boundary.** Electron with `contextIsolation: true`, `nodeIntegration: false`, and a narrow typed preload/IPC surface. Renderer code never imports Pi protocol types directly.

## Features

**Agent chat**
- Streaming answers from a local model with per-message tok/s stats.
- Ordered *reasoning* timeline inside each answer bubble: thinking text interleaved with tool calls, in the order they happened; every step is expandable (tool payload preview) and the block shows how long the agent spent working on it.
- Hover actions on answers: copy to clipboard, regenerate (drops the disliked reply and reruns the prompt).
- Copy button on every code block; jump-to-bottom pill with a new-message counter while you're scrolled up.
- Permission requests from the agent surface as in-chat interaction prompts.

**Sessions**
- Per-project session list: create, rename, resume. Sessions are Pi JSONL transcripts kept in the app's user-data directory (`pi-sessions`) and grouped by project.

**Workspace**
- File explorer with editor tabs (files and git diffs), unsaved-change tracking.
- Git integration: changes view, stage/unstage/revert, commit from the UI.
- Integrated terminal (xterm.js + node-pty) for Bash-based tools.
- Workspace-wide text search palette.

**Model provider**
- Discovery of local OpenAI-compatible servers on loopback endpoints; model list with context-window sizes.
- LM Studio and Unsloth profiles with separate addresses, model selections, and optional API keys.
- Model tuning per run: system prompt and temperature.
- Context inspector showing what the agent currently sees.

**Policy & settings**
- Per-scope permission matrix (filesystem, shell, network) with `allow` / `ask` / `deny`.
- Network mode switch (`online` / `offline`) applied to both first-party tools and Pi.

## Repository layout

npm workspaces monorepo:

```text
apps/
  desktop/            Electron app: main process, preload IPC, React renderer
packages/
  core/               Stable contracts, events, and policy types only
  pi-adapter/         Pi process/RPC integration (no UI dependencies)
  local-openai-provider/  Local model discovery + endpoint policy
  workspace/          Files / git / diffs runtime
  terminal/           node-pty terminal runtime
  permissions/        Permission policy evaluation
  context-runtime/    Inspectable agent-context runtime
  app-state/          JSON desktop state store
docs/
  ARCHITECTURE.md     Layering, policy axes, and subsystem contracts
AGENTS.md             Development rules for AI-assisted contributions
```

Architectural boundaries are enforced by convention and review: `@kripl/core` holds contracts only; `pi-adapter` never imports UI code; renderer code never imports `@earendil-works/pi-*`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## Connecting a model server

Open **Settings → Model**, select the server, enter its address, and press **Connect**.

| Server | Default address | Preparation |
| --- | --- | --- |
| LM Studio | `http://127.0.0.1:1234/v1` | Load a chat model and enable its local server. |
| Unsloth | `http://127.0.0.1:8888/v1` | Load a chat model and create an API key in Unsloth **Settings → API**. |

Use the port shown by your server; it can differ from these defaults. For Unsloth, paste the key into Kripl's **API key** field before connecting. A blank field reuses the saved key. If keyless inference was explicitly enabled in Unsloth, a saved key is optional. When the server reports loading status, Kripl lists its loaded chat models and excludes downloaded-only and media models.

Each profile remembers its own address and model. API keys are scoped to the selected server and address, encrypted using the operating system's credential protection, and passed to Pi through its private process environment. If operating-system encryption is unavailable, the key is kept for the current application session. The saved key is never returned to the renderer. After changing a running chat's server, model, or key, use **Reconnect chat** once its current response has finished or been stopped.

Unsloth uses the existing OpenAI-compatible transport for streaming, reasoning, images, and client tool calls. Kripl sends `enable_tools: false` so Pi handles tool execution and permissions. If launching Unsloth with `unsloth run`, use `--disable-tools`; an explicit `--enable-tools` can override the request setting. Each Pi runtime has its own configuration directory, so changing the foreground connection does not change a background runtime's endpoint or key.

Protocol references: [Unsloth API](https://unsloth.ai/docs/basics/api), [OpenAI-compatible SDK examples](https://unsloth.ai/docs/integrations/connect-python-sdk-to-unsloth), and [Electron credential encryption](https://www.electronjs.org/docs/latest/api/safe-storage).

## Development

Requirements:

- Node.js 22.19 or newer
- Windows 11 as the primary desktop target
- Git for Windows / Git Bash for Bash-based Pi tools
- A local OpenAI-compatible model server (e.g. LM Studio or Unsloth Studio) to use the agent

```powershell
git clone https://github.com/MaxSquizie/Kripl-Studio.git
cd Kripl-Studio
npm install
npm run dev        # builds all packages, then starts Electron in watch mode
```

Useful scripts (run from the repository root):

| Script | Purpose |
| --- | --- |
| `npm test` | Unit tests for every package |
| `npm run typecheck` | Strict TypeScript check across workspaces |
| `npm run build` | Production build of all packages + desktop app |
| `npm run dist:win` | Build the NSIS installer (`apps/desktop/release/Kripl Studio Setup 0.0.2.exe`) |

After code changes, run at least `npm test`, `npm run typecheck`, and `npm run build`.

## License

No project license has been selected yet.
