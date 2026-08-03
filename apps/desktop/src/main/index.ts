import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendRuntimeLog, diagnosticExport } from "./diagnostics.js";
import { APPLICATION_DATA_FOLDER, APPLICATION_ID, PRODUCT_NAME, isLoopbackUrl } from "./product.js";
import { DaemonManager, type DaemonConnection, type RuntimeStatus } from "./runtime-manager.js";
import { createElectronDaemonLauncher } from "./runtime-launcher.js";
import { SetupManager, type SetupComponentId } from "./setup-manager.js";

const allowedChannels = new Set([
  "agent:connection",
  "agent:runtime-status",
  "agent:retry-runtime",
  "agent:setup-status",
  "agent:setup-install",
  "agent:repair",
  "agent:export-diagnostics",
  "agent:open-logs",
  "agent:select-folder",
  "agent:quit"
]);

let mainWindow: BrowserWindow | null = null;
let quitting = false;

const configuredDataDirectory =
  process.env.AGENT_DATA_DIR ??
  join(process.env.LOCALAPPDATA ?? app.getPath("appData"), APPLICATION_DATA_FOLDER);
const instanceSuffix = process.env.PERSONAL_CODEX_AGENT_INSTANCE_ID;
if (instanceSuffix && !/^[a-z0-9-]{1,40}$/i.test(instanceSuffix)) {
  throw new Error("Invalid Personal Codex Agent instance identifier.");
}
app.setPath("userData", configuredDataDirectory);
if (instanceSuffix) app.setName(`${PRODUCT_NAME}-${instanceSuffix}`);
app.setAppUserModelId(instanceSuffix ? `${APPLICATION_ID}.${instanceSuffix}` : APPLICATION_ID);

const daemonManager = new DaemonManager({
  dataDirectory: configuredDataDirectory,
  launch: createElectronDaemonLauncher()
});
const setupManager = new SetupManager(
  configuredDataDirectory,
  app.isPackaged
    ? join(process.resourcesPath, "extensions", "personal-codex-agent-vscode-0.3.0.vsix")
    : join(app.getAppPath(), "artifacts", "personal-codex-agent-vscode-0.3.0.vsix")
);

function isDeveloperMode(): boolean {
  return Boolean(process.env.PERSONAL_CODEX_AGENT_DAEMON_URL);
}

function dataDirectory(): string {
  return configuredDataDirectory;
}

function developerStatus(): RuntimeStatus {
  return {
    phase: "ready",
    message: "Connected to the developer runtime.",
    attempts: 0,
    safeMode: false,
    updatedAt: new Date().toISOString()
  };
}

async function developerConnection(): Promise<DaemonConnection> {
  const explicitUrl = process.env.PERSONAL_CODEX_AGENT_DAEMON_URL;
  if (!explicitUrl || !isLoopbackUrl(explicitUrl)) {
    throw new Error("Developer mode requires a loopback daemon URL.");
  }
  const content = await readFile(join(dataDirectory(), "daemon.json"), "utf8");
  const parsed = JSON.parse(content) as { url?: unknown; token?: unknown; pid?: unknown };
  if (typeof parsed.token !== "string" || parsed.token.length < 20) {
    throw new Error("Developer daemon metadata does not contain a valid token.");
  }
  return {
    url: explicitUrl,
    token: parsed.token,
    pid: typeof parsed.pid === "number" ? parsed.pid : 0,
    version: "development",
    protocol: 1
  };
}

async function connection(): Promise<DaemonConnection> {
  if (isDeveloperMode()) return developerConnection();
  try {
    const result = await daemonManager.start();
    await appendRuntimeLog(dataDirectory(), "runtime.ready", {
      phase: daemonManager.getStatus().phase,
      pid: result.pid
    });
    return result;
  } catch (error) {
    await appendRuntimeLog(dataDirectory(), "runtime.failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1050,
    minHeight: 680,
    backgroundColor: "#09111f",
    title: PRODUCT_NAME,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  const developmentUrl =
    process.env.PERSONAL_CODEX_AGENT_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) await mainWindow.loadURL(developmentUrl);
  else await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

ipcMain.handle("agent:connection", connection);
ipcMain.handle("agent:runtime-status", () =>
  isDeveloperMode() ? developerStatus() : daemonManager.getStatus()
);
ipcMain.handle("agent:retry-runtime", async (_event, input?: { safeMode?: unknown }) => {
  if (isDeveloperMode()) return developerConnection();
  const safeMode = input?.safeMode === true;
  const result = await daemonManager.retry(safeMode);
  await appendRuntimeLog(dataDirectory(), "runtime.retry", { safeMode, pid: result.pid });
  return result;
});
ipcMain.handle("agent:setup-status", () => setupManager.status());
ipcMain.handle(
  "agent:setup-install",
  async (_event, input: { id?: unknown; consent?: unknown }) => {
    const ids = new Set<SetupComponentId>([
      "git",
      "codex",
      "vscode",
      "vscode-extension",
      "github",
      "ollama"
    ]);
    if (typeof input.id !== "string" || !ids.has(input.id as SetupComponentId)) {
      throw new Error("Unknown setup component.");
    }
    const state = await setupManager.install(input.id as SetupComponentId, input.consent === true);
    await appendRuntimeLog(dataDirectory(), "setup.install", { component: input.id });
    return state;
  }
);
ipcMain.handle("agent:repair", async () => {
  const setup = await setupManager.repair();
  if (isDeveloperMode()) return { setup, runtime: developerStatus() };
  try {
    await daemonManager.retry(false);
  } catch {
    // The returned status gives the renderer the actionable failure state.
  }
  return { setup, runtime: daemonManager.getStatus() };
});
ipcMain.handle("agent:export-diagnostics", async () => {
  await mkdir(dataDirectory(), { recursive: true });
  const defaultPath = join(dataDirectory(), "diagnostics", `desktop-${Date.now()}.json`);
  const saveOptions = {
    title: "Export diagnostics",
    defaultPath,
    filters: [{ name: "Diagnostic report", extensions: ["json"] }]
  };
  const destination = mainWindow
    ? await dialog.showSaveDialog(mainWindow, saveOptions)
    : await dialog.showSaveDialog(saveOptions);
  if (destination.canceled || !destination.filePath) return null;
  const report = await diagnosticExport(
    dataDirectory(),
    isDeveloperMode() ? developerStatus() : daemonManager.getStatus(),
    isDeveloperMode() ? "development" : "packaged"
  );
  await writeFile(destination.filePath, report, { encoding: "utf8", mode: 0o600 });
  await appendRuntimeLog(dataDirectory(), "diagnostics.exported", {
    destination: destination.filePath
  });
  return destination.filePath;
});
ipcMain.handle("agent:open-logs", () => shell.openPath(join(dataDirectory(), "logs")));
ipcMain.handle("agent:select-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
ipcMain.handle("agent:quit", () => app.quit());
ipcMain.on("new-window", (event) => event.preventDefault());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  void app.whenReady().then(async () => {
    await createWindow();
    const initialConnection = connection();
    void initialConnection.catch(() => undefined);
    const smokeDuration = Number(process.env.PERSONAL_CODEX_AGENT_SMOKE_MS ?? 0);
    if (Number.isInteger(smokeDuration) && smokeDuration > 0) {
      void initialConnection.then(
        () => setTimeout(() => app.quit(), smokeDuration),
        () => {
          process.exitCode = 1;
          app.quit();
        }
      );
    }
  });
}

app.on("before-quit", (event) => {
  if (quitting || isDeveloperMode()) return;
  event.preventDefault();
  quitting = true;
  void daemonManager.stop().finally(() => app.quit());
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

export { allowedChannels };
