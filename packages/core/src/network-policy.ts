export type NetworkMode = "online" | "restricted" | "offline";

export type ModelRoutingPolicy = "local-only" | "allow-remote";

export interface RuntimePolicy {
  networkMode: NetworkMode;
  modelRouting: ModelRoutingPolicy;
}

export const DEFAULT_RUNTIME_POLICY: RuntimePolicy = {
  networkMode: "online",
  modelRouting: "local-only"
};
