import { contextBridge, ipcRenderer } from "electron";

const api = Object.freeze({
  connection: () =>
    ipcRenderer.invoke("agent:connection") as Promise<{ url: string; token: string }>,
  selectFolder: () => ipcRenderer.invoke("agent:select-folder") as Promise<string | null>,
  openPath: (path: string) => ipcRenderer.invoke("agent:open-path", path) as Promise<string>
});

contextBridge.exposeInMainWorld("agentDesktop", api);
