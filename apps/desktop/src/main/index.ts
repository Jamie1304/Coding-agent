import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const allowedChannels = new Set(["agent:connection", "agent:select-folder", "agent:open-path"]);

function dataDirectory(): string {
  return (
    process.env.AGENT_DATA_DIR ??
    join(process.env.LOCALAPPDATA ?? app.getPath("userData"), "PersonalCodexAgent")
  );
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1050,
    minHeight: 680,
    backgroundColor: "#09111f",
    title: "Personal Codex Agent",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const developmentUrl =
    process.env.PERSONAL_CODEX_AGENT_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) await window.loadURL(developmentUrl);
  else await window.loadFile(join(__dirname, "../renderer/index.html"));
}

ipcMain.handle("agent:connection", async () => {
  const content = await readFile(join(dataDirectory(), "daemon.json"), "utf8");
  const parsed = JSON.parse(content) as { url: string; token: string };
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(parsed.url)) throw new Error("Invalid daemon endpoint");
  const explicitUrl = process.env.PERSONAL_CODEX_AGENT_DAEMON_URL;
  if (explicitUrl && !/^http:\/\/127\.0\.0\.1:\d+$/.test(explicitUrl)) {
    throw new Error("Invalid explicit daemon endpoint");
  }
  return { ...parsed, url: explicitUrl ?? parsed.url };
});

ipcMain.handle("agent:select-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle("agent:open-path", async (_event, path: string) => {
  if (typeof path !== "string" || path.length === 0) throw new Error("Invalid path");
  return shell.openPath(path);
});

ipcMain.on("new-window", (event) => event.preventDefault());

void app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

export { allowedChannels };
