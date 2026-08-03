import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const dataDirectory = join(root, "artifacts", "packaged-smoke");
const executable = join(
  root,
  "artifacts",
  "installers",
  "win-unpacked",
  "Personal Codex Agent.exe"
);
await rm(dataDirectory, { recursive: true, force: true });
await mkdir(dataDirectory, { recursive: true });
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_OVERRIDE_DIST_PATH;
environment.AGENT_DATA_DIR = dataDirectory;
environment.PERSONAL_CODEX_AGENT_INSTANCE_ID = "packaged-smoke";
environment.PERSONAL_CODEX_AGENT_SMOKE_MS = "3000";

const child = spawn(executable, [], {
  cwd: root,
  env: environment,
  shell: false,
  windowsHide: true,
  stdio: "ignore"
});
const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
const metadataPath = join(dataDirectory, "daemon.json");
let metadata: { url: string; token: string };
try {
  metadata = await waitForMetadata(metadataPath, exit, 30_000);
} catch (error) {
  const logs = await readFile(join(dataDirectory, "logs", "desktop.jsonl"), "utf8").catch(() => "");
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}${logs ? `\nRuntime diagnostics:\n${logs}` : ""}`,
    { cause: error }
  );
}
const response = await fetch(`${metadata.url}/health`, {
  headers: { "x-agent-token": metadata.token }
});
if (!response.ok) throw new Error(`Packaged daemon health returned ${String(response.status)}.`);
const health = (await response.json()) as { status?: unknown; bind?: unknown; version?: unknown };
if (health.status !== "ok" || health.bind !== "127.0.0.1" || health.version !== "0.3.0") {
  throw new Error("Packaged daemon returned an invalid health response.");
}
const exitCode = await exit;
if (exitCode !== 0) throw new Error(`Packaged app exited with ${String(exitCode)}.`);
console.log("Packaged application smoke test passed.");

async function waitForMetadata(
  path: string,
  exitPromise: Promise<number | null>,
  timeoutMs: number
): Promise<{ url: string; token: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as {
        url?: unknown;
        token?: unknown;
      };
      if (typeof parsed.url === "string" && typeof parsed.token === "string") {
        return { url: parsed.url, token: parsed.token };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error("Packaged app did not publish readiness metadata.");
    const exited = await Promise.race([
      exitPromise.then((code) => ({ exited: true, code })),
      new Promise<{ exited: false }>((resolve) => setTimeout(() => resolve({ exited: false }), 150))
    ]);
    if (exited.exited)
      throw new Error(`Packaged app exited before readiness (${String(exited.code)}).`);
  }
}
