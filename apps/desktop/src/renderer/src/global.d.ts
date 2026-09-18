export {};

declare global {
  interface Window {
    kripl: {
      getAppInfo(): Promise<{
        name: string;
        version: string;
        platform: string;
        offlineFirst: boolean;
      }>;
      pickWorkspace(): Promise<string | null>;
      probeLocalModels(endpoint: string): Promise<{
        ok: boolean;
        endpoint: string;
        models: Array<{
          provider: string;
          id: string;
          name: string;
          local: boolean;
          contextWindow?: number;
          input?: Array<"text" | "image">;
        }>;
        error?: string;
      }>;
    };
  }
}
