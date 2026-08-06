import { app, utilityProcess } from "electron";
import { join } from "node:path";
import type { DaemonLaunch, DaemonManagerOptions, OwnedProcess } from "./runtime-manager.js";
import { PRODUCT_VERSION, isLoopbackUrl } from "./product.js";

export function createElectronDaemonLauncher(): DaemonManagerOptions["launch"] {
  return ({ token, safeMode }): DaemonLaunch => {
    const entry = app.isPackaged
      ? join(process.resourcesPath, "daemon", "index.cjs")
      : join(app.getAppPath(), "dist", "daemon", "index.cjs");
    const child = utilityProcess.fork(entry, [], {
      serviceName: "personal-codex-agent-daemon",
      env: {
        ...process.env,
        AGENT_TOKEN: token,
        AGENT_APP_VERSION: PRODUCT_VERSION,
        AGENT_SAFE_MODE: safeMode ? "1" : "0",
        AGENT_MANAGED_BY_DESKTOP: "1",
        NODE_PATH: app.isPackaged
          ? join(process.resourcesPath, "daemon", "node_modules")
          : join(app.getAppPath(), "dist", "daemon", "node_modules")
      },
      stdio: "pipe"
    });
    let standardError = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      standardError = `${standardError}${chunk.toString()}`.slice(-4_096);
    });
    const processHandle: OwnedProcess = {
      pid: child.pid ?? 0,
      kill: () => {
        child.kill();
      },
      onExit: (listener) => {
        child.once("exit", (code) => listener(code));
      }
    };
    const ready = new Promise<{ url: string; pid: number }>((resolve, reject) => {
      const fail = (reason: string): void => {
        const detail = standardError.trim();
        reject(new Error(detail ? `${reason}: ${detail}` : reason));
      };
      child.once("message", (message: unknown) => {
        const candidate = message as { event?: unknown; url?: unknown; pid?: unknown };
        if (
          candidate.event !== "daemon.ready" ||
          typeof candidate.url !== "string" ||
          !isLoopbackUrl(candidate.url) ||
          !Number.isInteger(candidate.pid)
        ) {
          fail("The bundled daemon sent an invalid readiness message.");
          return;
        }
        resolve({ url: candidate.url, pid: candidate.pid as number });
      });
      child.once("exit", (code) =>
        fail(`The bundled daemon exited before readiness (${String(code)}).`)
      );
      child.once("error", (error) => fail(`The bundled daemon could not start: ${error}`));
    });
    return { process: processHandle, ready };
  };
}
