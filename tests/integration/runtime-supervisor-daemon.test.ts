import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeSupervisor, isPortAvailable } from "@agent/core";

describe("runtime supervisor daemon validation", () => {
  it("starts, validates, restarts, and cleans up a real daemon process", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "agent-runtime-supervisor-"));
    const port = await freePort();
    const workspacePath = process.cwd();
    const supervisor = new RuntimeSupervisor({ portReleaseTimeoutMs: 5_000, killGraceMs: 500 });
    let activeSessionId: string | null = null;
    try {
      const first = await supervisor.start({
        runId: "runtime-daemon",
        stepId: "start",
        workspacePath,
        cwd: workspacePath,
        executable: process.execPath,
        args: [
          join(workspacePath, "node_modules", "tsx", "dist", "cli.mjs"),
          join(workspacePath, "apps", "daemon", "src", "index.ts")
        ],
        env: { AGENT_DATA_DIR: dataDirectory, AGENT_PORT: String(port) },
        readiness: {
          logPattern: "daemon.ready",
          httpUrl: `http://127.0.0.1:${port}/health`,
          timeoutMs: 10_000
        },
        expectedPorts: [port]
      });
      activeSessionId = first.snapshot().id;
      await assertDaemonResponsive(dataDirectory, port);

      const restarted = await supervisor.restart(activeSessionId);
      activeSessionId = restarted.snapshot().id;
      await assertDaemonResponsive(dataDirectory, port);

      await supervisor.stop(activeSessionId);
      activeSessionId = null;
      await expect(isPortAvailable(port)).resolves.toBe(true);
    } finally {
      if (activeSessionId) {
        try {
          await supervisor.stop(activeSessionId);
        } catch {
          // The supervisor reports the startup/shutdown failure through the test assertion.
        }
      }
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});

async function assertDaemonResponsive(dataDirectory: string, port: number): Promise<void> {
  expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
  const connection = JSON.parse(await readFile(join(dataDirectory, "daemon.json"), "utf8")) as {
    token: string;
  };
  expect(
    (
      await fetch(`http://127.0.0.1:${port}/api/runs`, {
        headers: { "x-agent-token": connection.token }
      })
    ).status
  ).toBe(200);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a test port")));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
