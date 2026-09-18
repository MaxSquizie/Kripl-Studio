# Kripl Studio development rules

## Product invariants

1. Kripl Studio is offline-first. Runtime behavior must not silently fall back to cloud services.
2. Pi is an adapter, not the application core. UI and workspace code must not depend directly on Pi protocol types.
3. Memory is a replaceable subsystem. The application must work with `NoopMemoryRuntime` and later with AG Memory without changing the UI contract.
4. The renderer is untrusted relative to the desktop process:
   - `contextIsolation: true`
   - `nodeIntegration: false`
   - expose only narrow typed IPC methods through preload
5. Windows is the primary desktop target.
6. Project filesystem state is first-class and must remain independent from conversation/session state.

## Architectural boundaries

- `packages/core`: stable contracts and shared event types only. No Electron, Pi, LM Studio, or filesystem implementation details.
- `packages/pi-adapter`: Pi process/RPC integration. It may depend on Pi packages and Node APIs, but not on React/Electron UI code.
- `apps/desktop`: Electron lifecycle, IPC, renderer, and desktop UX.
- Future memory implementations belong in separate packages such as `packages/ag-memory-adapter`.

Never import `@earendil-works/pi-*` directly from renderer code.

## Offline rules

Pi processes started by Kripl Studio must default to:

- `PI_OFFLINE=1`
- `PI_TELEMETRY=0`
- `PI_SKIP_VERSION_CHECK=1`

Any network-capable feature must be explicit and opt-in.

## Change discipline

- Prefer small, reviewable changes.
- Do not collapse subsystem interfaces just to make an implementation easier.
- Do not add cloud fallback logic.
- Do not put credentials in renderer state, logs, fixtures, or repository files.
- Keep dependency versions pinned.
- Run `npm run typecheck` and `npm run build` after code changes once dependencies are installed.
