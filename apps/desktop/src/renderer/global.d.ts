export {};

declare global {
  interface Window {
    agentDesktop: {
      connection(): Promise<{ url: string; token: string }>;
      selectFolder(): Promise<string | null>;
      openPath(path: string): Promise<string>;
    };
  }
}
