import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { createCodexProviderFromEnvironment } from "@agent/codex-provider";
import { createDaemon, type DaemonHandle } from "../apps/daemon/src/server.js";
import {
  diagnoseElectron,
  electronEnvironment,
  type ElectronDiagnostic
} from "./electron-runtime.js";

interface DevelopmentLock {
  pid: number;
  startedAt: string;
  repositoryPath: string;
  daemonUrl: string | null;
  rendererUrl: string | null;
}

export interface DevelopmentResult {
  exitCode: number;
  daemonUrl: string;
  rendererUrl: string;
  electron: ElectronDiagnostic;
  reason: string;
}

export interface DevelopmentOptions {
  repositoryRoot?: string;
  preferredRendererPort?: number;
  smokeDurationMs?: number | null;
  onReady?: (details: {
    daemonUrl: string;
    rendererUrl: string;
    electronExecutable: string;
    electronPid: number;
  }) => void;
}

export async function runDevelopment(options: DevelopmentOptions = {}): Promise<DevelopmentResult> {
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const lockPath = join(repositoryRoot, ".agent", "dev-run.lock.json");
  let daemon: DaemonHandle | null = null;
  let vite: ViteDevServer | null = null;
  let electron: ChildProcess | null = null;
  let stopping = false;
  let daemonUrl: string;
  let rendererUrl: string;
  let electronDiagnostic: ElectronDiagnostic;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (electron?.pid) await terminateOwnedProcessTree(electron.pid);
    electron = null;
    if (vite) await vite.close();
    vite = null;
    if (daemon) await daemon.close();
    daemon = null;
    await rm(lockPath, { force: true });
  };
  let signalResolve: ((signal: NodeJS.Signals) => void) | null = null;
  const signalPromise = new Promise<NodeJS.Signals>((resolveSignal) => {
    signalResolve = resolveSignal;
  });
  const onSigint = (): void => signalResolve?.("SIGINT");
  const onSigterm = (): void => signalResolve?.("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    await acquireDevelopmentLock(lockPath, repositoryRoot);
    console.log("[dev 1/5] Validating Electron runtime");
    electronDiagnostic = await diagnoseElectron(repositoryRoot);
    if (!electronDiagnostic.selectedExecutable || !electronDiagnostic.selectedKind) {
      throw electronStartupError(electronDiagnostic, repositoryRoot);
    }

    console.log("[dev 2/5] Starting local daemon");
    const dataDirectory =
      process.env.AGENT_DATA_DIR ??
      join(process.env.LOCALAPPDATA ?? repositoryRoot, "PersonalCodexAgent");
    await mkdir(dataDirectory, { recursive: true });
    daemon = await createDaemon({
      port: 0,
      dataDirectory,
      codexProvider: createCodexProviderFromEnvironment()
    });
    daemonUrl = daemon.url;
    await writeFile(
      join(dataDirectory, "daemon.json"),
      JSON.stringify({ url: daemon.url, token: daemon.token, pid: process.pid }, null, 2),
      { encoding: "utf8", mode: 0o600 }
    );

    console.log("[dev 3/5] Starting Vite renderer");
    const renderer = await startRenderer(repositoryRoot, options.preferredRendererPort ?? 5173);
    vite = renderer.server;
    rendererUrl = renderer.url;
    const rendererResponse = await fetch(rendererUrl);
    if (!rendererResponse.ok) {
      throw new Error(`Vite health check returned ${rendererResponse.status}`);
    }

    await updateDevelopmentLock(lockPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      repositoryPath: repositoryRoot,
      daemonUrl,
      rendererUrl
    });
    console.log(`[dev 4/5] Starting Electron from ${electronDiagnostic.selectedExecutable}`);
    const electronArgs = electronDiagnostic.selectedKind === "raw-electron" ? [repositoryRoot] : [];
    const environment = desktopDevelopmentEnvironment(
      process.env,
      daemonUrl,
      rendererUrl,
      dataDirectory
    );
    try {
      electron = spawn(electronDiagnostic.selectedExecutable, electronArgs, {
        cwd: repositoryRoot,
        env: environment,
        stdio: "inherit",
        shell: false,
        windowsHide: false
      });
    } catch (error) {
      throw electronStartupError(
        electronDiagnostic,
        repositoryRoot,
        error instanceof Error ? error : new Error(String(error))
      );
    }
    const spawnFailure = new Promise<Error>((resolveFailure) =>
      electron!.once("error", resolveFailure)
    );
    const earlyExit = new Promise<number | null>((resolveExit) =>
      electron!.once("exit", resolveExit)
    );
    const startup = await Promise.race([
      new Promise<"ready">((resolveReady) => setTimeout(() => resolveReady("ready"), 1_500)),
      spawnFailure,
      earlyExit
    ]);
    if (startup instanceof Error) {
      throw electronStartupError(electronDiagnostic, repositoryRoot, startup);
    }
    if (startup !== "ready") {
      throw electronStartupError(
        electronDiagnostic,
        repositoryRoot,
        new Error(`Electron exited during startup with code ${String(startup)}`)
      );
    }
    if (!electron.pid) throw new Error("Electron started without a process ID");
    options.onReady?.({
      daemonUrl,
      rendererUrl,
      electronExecutable: electronDiagnostic.selectedExecutable,
      electronPid: electron.pid
    });
    console.log(`[dev 5/5] Ready: daemon ${daemonUrl}, renderer ${rendererUrl}`);

    const exitPromise = new Promise<{ reason: string; code: number }>((resolveExit) => {
      electron!.once("exit", (code) =>
        resolveExit({
          reason: `Electron exited with code ${String(code)}`,
          code: code ?? 1
        })
      );
    });
    const signalExit = signalPromise.then((signal) => ({
      reason: `Received ${signal}`,
      code: signal === "SIGINT" ? 130 : 143
    }));
    const smokeDuration =
      options.smokeDurationMs ??
      (process.env.PERSONAL_CODEX_AGENT_SMOKE_MS
        ? Number(process.env.PERSONAL_CODEX_AGENT_SMOKE_MS)
        : null);
    const completion = await Promise.race([
      exitPromise,
      signalExit,
      ...(smokeDuration && smokeDuration > 0
        ? [
            new Promise<{ reason: string; code: number }>((resolveSmoke) =>
              setTimeout(
                () => resolveSmoke({ reason: "Smoke duration completed", code: 0 }),
                smokeDuration
              )
            )
          ]
        : [])
    ]);
    return {
      exitCode: completion.code,
      daemonUrl,
      rendererUrl,
      electron: electronDiagnostic,
      reason: completion.reason
    };
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await stop();
  }
}

export async function startRenderer(
  repositoryRoot: string,
  preferredPort: number
): Promise<{ server: ViteDevServer; url: string }> {
  const port = await rendererPort(preferredPort);
  const server = await createServer({
    configFile: join(repositoryRoot, "apps", "desktop", "vite.config.ts"),
    server: {
      host: "127.0.0.1",
      port,
      strictPort: false
    },
    clearScreen: false
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    await server.close();
    throw new Error("Vite did not expose a TCP address");
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function rendererPort(preferredPort: number): Promise<number> {
  const probe = createTcpServer();
  return new Promise((resolvePort) => {
    probe.once("error", () => resolvePort(0));
    probe.once("listening", () => {
      probe.close(() => resolvePort(preferredPort));
    });
    probe.listen(preferredPort, "127.0.0.1");
  });
}

export function desktopDevelopmentEnvironment(
  base: NodeJS.ProcessEnv,
  daemonUrl: string,
  rendererUrl: string,
  dataDirectory: string
): NodeJS.ProcessEnv {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(daemonUrl)) throw new Error("Invalid daemon URL");
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(rendererUrl)) throw new Error("Invalid renderer URL");
  const environment = electronEnvironment(base);
  environment.PERSONAL_CODEX_AGENT_DAEMON_URL = daemonUrl;
  environment.PERSONAL_CODEX_AGENT_RENDERER_URL = rendererUrl;
  environment.VITE_DEV_SERVER_URL = rendererUrl;
  environment.AGENT_DATA_DIR = dataDirectory;
  return environment;
}

export async function acquireDevelopmentLock(
  lockPath: string,
  repositoryRoot: string
): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    const existing = JSON.parse(await readFile(lockPath, "utf8")) as DevelopmentLock;
    if (isProcessAlive(existing.pid)) {
      throw new Error(
        `Development mode is already running for this repository (PID ${existing.pid}, renderer ${existing.rendererUrl ?? "starting"}).`
      );
    }
    await rm(lockPath, { force: true });
  } catch (error) {
    if (
      error instanceof Error &&
      !("code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")
    ) {
      throw error;
    }
  }
  await updateDevelopmentLock(lockPath, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    repositoryPath: repositoryRoot,
    daemonUrl: null,
    rendererUrl: null
  });
}

export async function terminateOwnedProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new Error(`Refusing to terminate invalid owned PID ${String(pid)}`);
  }
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already exited.
    }
    return;
  }
  const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  await new Promise<void>((resolveTree) => {
    const child = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore"
    });
    child.once("error", () => resolveTree());
    child.once("close", () => resolveTree());
  });
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function updateDevelopmentLock(path: string, lock: DevelopmentLock): Promise<void> {
  await writeFile(path, JSON.stringify(lock, null, 2), "utf8");
}

function electronStartupError(
  diagnostic: ElectronDiagnostic,
  repositoryRoot: string,
  cause?: Error
): Error {
  return new Error(
    [
      "Electron could not start.",
      "",
      `Resolved executable: ${diagnostic.selectedExecutable ?? "none"}`,
      `Raw executable: ${diagnostic.rawExecutable}`,
      `Executable exists: ${diagnostic.rawExists ? "Yes" : "No"}`,
      `Executable size: ${diagnostic.rawSize ?? "unknown"}`,
      `Electron package version: ${diagnostic.packageVersion}`,
      `Electron version check: ${diagnostic.rawLaunchStatus}`,
      `Packaged executable: ${diagnostic.packagedExecutable}`,
      `Packaged executable exists: ${diagnostic.packagedExists ? "Yes" : "No"}`,
      `Packaged version check: ${diagnostic.packagedLaunchStatus}`,
      `Application entry: ${join(repositoryRoot, "dist", "desktop", "main", "index.cjs")}`,
      `Working directory: ${repositoryRoot}`,
      `ELECTRON_RUN_AS_NODE was set: ${Boolean(process.env.ELECTRON_RUN_AS_NODE)}`,
      `ELECTRON_OVERRIDE_DIST_PATH was set: ${Boolean(process.env.ELECTRON_OVERRIDE_DIST_PATH)}`,
      `Windows error: ${cause?.message ?? diagnostic.packagedError ?? diagnostic.rawError ?? "none recorded"}`,
      "",
      "Repair actions:",
      ...(diagnostic.repairActions.length
        ? diagnostic.repairActions.map((item, index) => `${index + 1}. ${item}`)
        : ["1. Run npm run electron:install.", "2. Run npm run doctor."])
    ].join("\n"),
    cause ? { cause } : undefined
  );
}
