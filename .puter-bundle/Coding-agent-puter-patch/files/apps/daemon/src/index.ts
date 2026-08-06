import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AppServerCodexProvider,
  FakeCodexProvider,
  PuterCodexProvider,
  type CodexProvider
} from "@agent/codex-provider";
import { createDaemon } from "./server.js";

const dataDirectory =
  process.env.AGENT_DATA_DIR ??
  join(process.env.LOCALAPPDATA ?? process.cwd(), "PersonalCodexAgent");

await mkdir(dataDirectory, { recursive: true });

const daemon = await createDaemon({
  port: Number(process.env.AGENT_PORT ?? 0),
  dataDirectory,
  codexProvider: createCodexProvider()
});

await writeFile(
  join(dataDirectory, "daemon.json"),
  JSON.stringify({ url: daemon.url, token: daemon.token, pid: process.pid }, null, 2),
  { encoding: "utf8", mode: 0o600 }
);

console.log(JSON.stringify({ event: "daemon.ready", url: daemon.url, pid: process.pid }));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void daemon.close().finally(() => process.exit(0));
  });
}

function createCodexProvider(): CodexProvider {
  switch ((process.env.AGENT_CODEX_PROVIDER ?? "app-server").trim().toLocaleLowerCase()) {
    case "puter":
      return new PuterCodexProvider();
    case "fake":
      return new FakeCodexProvider();
    case "app-server":
    case "codex":
      return new AppServerCodexProvider();
    default:
      throw new Error(
        `Unsupported AGENT_CODEX_PROVIDER: ${String(process.env.AGENT_CODEX_PROVIDER)}`
      );
  }
}
