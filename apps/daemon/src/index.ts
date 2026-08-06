import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "dotenv";
import { createDaemon } from "./server.js";
import { createCodexProviderFromEnvironment } from "@agent/codex-provider";

config({ path: join(process.cwd(), ".env"), override: false });

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const dataDirectory =
    process.env.AGENT_DATA_DIR ??
    join(process.env.LOCALAPPDATA ?? process.cwd(), "PersonalCodexAgent");
  await mkdir(dataDirectory, { recursive: true });
  const daemon = await createDaemon({
    port: Number(process.env.AGENT_PORT ?? 0),
    dataDirectory,
    protocolVersion: 1,
    ...(process.env.AGENT_TOKEN ? { token: process.env.AGENT_TOKEN } : {}),
    ...(process.env.AGENT_APP_VERSION ? { productVersion: process.env.AGENT_APP_VERSION } : {}),
    ...(process.env.AGENT_SAFE_MODE === "1"
      ? {}
      : { codexProvider: createCodexProviderFromEnvironment() })
  });
  const ready = { event: "daemon.ready", url: daemon.url, pid: process.pid };
  if (process.env.AGENT_MANAGED_BY_DESKTOP === "1") {
    const parentPort = (
      process as unknown as {
        parentPort: { postMessage(message: unknown): void };
      }
    ).parentPort;
    parentPort.postMessage(ready);
  } else {
    await writeFile(
      join(dataDirectory, "daemon.json"),
      JSON.stringify({ url: daemon.url, token: daemon.token, pid: process.pid }, null, 2),
      { encoding: "utf8", mode: 0o600 }
    );
  }
  console.log(JSON.stringify(ready));

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void daemon.close().finally(() => process.exit(0));
    });
  }
}
