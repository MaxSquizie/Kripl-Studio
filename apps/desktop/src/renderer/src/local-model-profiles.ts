import type { LocalModelConnection, LocalModelServer } from "@kripl/core";

export const DEFAULT_LOCAL_MODEL_ENDPOINTS: Record<LocalModelServer, string> = {
  "lm-studio": "http://127.0.0.1:1234/v1",
  unsloth: "http://127.0.0.1:8888/v1"
};

export interface LocalModelProfile {
  endpoint: string;
  modelId: string;
}

export interface LocalModelProfiles {
  server: LocalModelServer;
  profiles: Record<LocalModelServer, LocalModelProfile>;
}

interface ProfileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "kripl.localModelProfiles";

function read(storage: Pick<ProfileStorage, "getItem">, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function profile(value: unknown, fallback: LocalModelProfile): LocalModelProfile {
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  return {
    endpoint: typeof record.endpoint === "string" ? record.endpoint : fallback.endpoint,
    modelId: typeof record.modelId === "string" ? record.modelId : fallback.modelId
  };
}

export function loadLocalModelProfiles(storage: Pick<ProfileStorage, "getItem">): LocalModelProfiles {
  const defaults: LocalModelProfiles = {
    server: "lm-studio",
    profiles: {
      "lm-studio": {
        endpoint: read(storage, "kripl.localEndpoint") ?? DEFAULT_LOCAL_MODEL_ENDPOINTS["lm-studio"],
        modelId: read(storage, "kripl.selectedModel") ?? ""
      },
      unsloth: { endpoint: DEFAULT_LOCAL_MODEL_ENDPOINTS.unsloth, modelId: "" }
    }
  };
  try {
    const raw = read(storage, STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== "object") {
      return defaults;
    }
    const profiles = parsed.profiles as Record<string, unknown>;
    return {
      server: parsed.server === "unsloth" ? "unsloth" : "lm-studio",
      profiles: {
        "lm-studio": profile(profiles["lm-studio"], defaults.profiles["lm-studio"]),
        unsloth: profile(profiles.unsloth, defaults.profiles.unsloth)
      }
    };
  } catch {
    return defaults;
  }
}

export function saveLocalModelProfiles(
  storage: Pick<ProfileStorage, "setItem">,
  state: LocalModelProfiles
): void {
  const { server, profiles } = state;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      server,
      profiles: {
        "lm-studio": { endpoint: profiles["lm-studio"].endpoint, modelId: profiles["lm-studio"].modelId },
        unsloth: { endpoint: profiles.unsloth.endpoint, modelId: profiles.unsloth.modelId }
      }
    }));
  } catch {}
}

function endpointIdentity(endpoint: string): string {
  try {
    const url = new URL(endpoint.trim());
    if (url.hostname.toLowerCase().replace(/\.$/, "") === "localhost") url.hostname = "127.0.0.1";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/v1";
    return url.toString().replace(/\/$/, "");
  } catch {
    return endpoint.trim();
  }
}

export function sameLocalModelConnection(a: LocalModelConnection, b: LocalModelConnection): boolean {
  return (a.server ?? "lm-studio") === (b.server ?? "lm-studio") &&
    endpointIdentity(a.endpoint) === endpointIdentity(b.endpoint);
}
