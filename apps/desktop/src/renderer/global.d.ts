export {};

declare global {
  interface Window {
    agentDesktop: {
      connection(): Promise<{ url: string; token: string }>;
      runtimeStatus(): Promise<{
        phase: "starting" | "ready" | "recovering" | "failed" | "stopped";
        message: string;
        attempts: number;
        safeMode: boolean;
        updatedAt: string;
      }>;
      retryRuntime(safeMode?: boolean): Promise<{ url: string; token: string }>;
      setupStatus(): Promise<unknown>;
      installSetupComponent(id: string, consent: boolean): Promise<unknown>;
      repair(): Promise<unknown>;
      exportDiagnostics(): Promise<string | null>;
      openLogs(): Promise<string>;
      selectFolder(): Promise<string | null>;
      quit(): Promise<void>;
    };
  }
}
