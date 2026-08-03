import { contextBridge, ipcRenderer } from "electron";

const api = Object.freeze({
  connection: () =>
    ipcRenderer.invoke("agent:connection") as Promise<{ url: string; token: string }>,
  runtimeStatus: () =>
    ipcRenderer.invoke("agent:runtime-status") as Promise<{
      phase: "starting" | "ready" | "recovering" | "failed" | "stopped";
      message: string;
      attempts: number;
      safeMode: boolean;
      updatedAt: string;
    }>,
  retryRuntime: (safeMode = false) =>
    ipcRenderer.invoke("agent:retry-runtime", { safeMode }) as Promise<{
      url: string;
      token: string;
    }>,
  setupStatus: () => ipcRenderer.invoke("agent:setup-status") as Promise<unknown>,
  installSetupComponent: (id: string, consent: boolean) =>
    ipcRenderer.invoke("agent:setup-install", { id, consent }) as Promise<unknown>,
  repair: () => ipcRenderer.invoke("agent:repair") as Promise<unknown>,
  exportDiagnostics: () => ipcRenderer.invoke("agent:export-diagnostics") as Promise<string | null>,
  openLogs: () => ipcRenderer.invoke("agent:open-logs") as Promise<string>,
  selectFolder: () => ipcRenderer.invoke("agent:select-folder") as Promise<string | null>,
  quit: () => ipcRenderer.invoke("agent:quit") as Promise<void>
});

contextBridge.exposeInMainWorld("agentDesktop", api);
