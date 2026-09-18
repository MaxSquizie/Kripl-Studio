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
    };
  }
}
