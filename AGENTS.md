# Kripl Studio development rules

## Product invariants

1. Kripl Studio is local-model-first, network-capable, and offline-capable.
2. Model routing and network access are separate policies:
   - default model policy: `local-only`;
   - default network mode: `online`;
   - offline mode is explicit, not the permanent runtime default.
3. Never silently fall back from a local model to a cloud model.
4. Pi is an adapter, not the application core. UI/workspace code must not depend directly on Pi protocol types.
5. Memory is a replaceable subsystem. The application must work with `NoopMemoryRuntime` and later AG Memory without changing the UI contract.
6. Renderer isolation is mandatory: `contextIsolation: true`, `nodeIntegration: false`, narrow typed preload IPC only.
7. Windows is the primary desktop target.
8. Project filesystem state is independent from conversation/session state.

## Architectural boundaries

- `packages/core`: stable contracts, events, and policy types only.
- `packages/pi-adapter`: Pi process/RPC integration. No React/Electron UI dependencies.
- `apps/desktop`: Electron lifecycle, IPC, renderer, and desktop UX.
- Future memory implementations belong in separate packages such as `packages/ag-memory-adapter`.
- Browser/search/network tooling must stay separate from `ModelProvider`.

Never import `@earendil-works/pi-*` directly from renderer code.

## Network and model rules

Default runtime policy:

- `modelRouting = local-only`
- `networkMode = online`
- `PI_TELEMETRY=0`
- `PI_SKIP_VERSION_CHECK=1`

Set `PI_OFFLINE=1` only when Kripl Studio is explicitly running in offline mode.

Online mode is expected to support browser search, documentation lookup, GitHub/network integrations, downloads, package registries, and other agent tools. These capabilities are independent from where inference runs.

Offline mode must disable first-party network tools as well as Pi network operations. `PI_OFFLINE` is not an OS firewall and cannot by itself prevent arbitrary shell commands from reaching the network; hard shell egress isolation belongs in a separate sandbox layer.

## Change discipline

- Prefer small, reviewable changes.
- Do not collapse subsystem interfaces just to make an implementation easier.
- Do not add silent cloud-model fallback logic.
- Do not put credentials in renderer state, logs, fixtures, or repository files.
- Keep dependency versions pinned.
- Run `npm test`, `npm run typecheck`, and `npm run build` after code changes once dependencies are installed.
