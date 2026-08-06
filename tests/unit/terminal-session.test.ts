import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { AgentDatabase } from "@agent/database";
import { RuntimeSupervisor, TerminalSession, isPortAvailable } from "@agent/core";
import { temporaryProject } from "../helpers.js";

describe("terminal sessions and runtime supervision", () => {
  it("streams only redacted output, records diagnostics, and preserves real completion status", async () => {
    const workspacePath = await temporaryProject({ space: true });
    const database = new AgentDatabase();
    const timestamp = "2026-08-03T10:00:00.000Z";
    database.createRun({
      id: "terminal-run",
      workspacePath,
      repositoryIdentity: null,
      startingCommit: null,
      state: "AWAITING_APPROVAL",
      finalStatus: null,
      originalPrompt: "Test durable terminal operation persistence.",
      approvedPrompt: "Test durable terminal operation persistence.",
      approvedRevision: 1,
      createdAt: timestamp,
      approvedAt: timestamp,
      completedAt: null,
      retryCount: 0
    });
    database.raw
      .prepare(
        "INSERT INTO approved_plan_steps(run_id,step_id,step_order,state,payload_json) VALUES(?,?,?,?,?)"
      )
      .run("terminal-run", "terminal-step", 1, "STEP_READY", "{}");
    const streamed: string[] = [];
    const recordedErrors: number[] = [];
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz";
    try {
      const session = await TerminalSession.start(
        {
          runId: "terminal-run",
          stepId: "terminal-step",
          workspacePath,
          cwd: workspacePath,
          executable: process.execPath,
          args: [
            "-e",
            `console.log('ready'); console.log('token=${secret}'); console.error('WARNING deliberate'); console.error('ERROR deliberate'); setTimeout(() => process.exit(0), 500)`
          ],
          onOutput(event) {
            streamed.push(event.text);
          }
        },
        {
          store: database,
          errorRecorder: {
            recordTerminalOperation(operation) {
              recordedErrors.push(operation.errorsDetected.length);
              return operation.errorsDetected;
            }
          }
        }
      );

      await session.waitForReadiness({ logPattern: "ready" });
      const completed = await session.completion;
      const streamedText = streamed.join("");

      expect(completed.status).toBe("passed");
      expect(completed.exitCode).toBe(0);
      expect(completed.readyAt).not.toBeNull();
      expect(completed.warningsDetected).toHaveLength(1);
      expect(completed.errorsDetected).toHaveLength(1);
      expect(recordedErrors).toEqual([1]);
      expect(completed.normalizedLog?.combined).toContain("ready");
      expect(completed.normalizedLog?.combined).not.toContain(secret);
      expect(streamedText).not.toContain(secret);
      expect(completed.safeArguments.join(" ")).not.toContain(secret);
      expect(database.stepTerminalOperations("terminal-run")).toEqual([completed]);
    } finally {
      database.close();
    }
  });

  it("times out an owned process rather than reporting a false successful exit", async () => {
    const workspacePath = await temporaryProject();
    const session = await TerminalSession.start(
      {
        runId: "timeout-run",
        stepId: "timeout-step",
        workspacePath,
        cwd: workspacePath,
        executable: process.execPath,
        args: ["-e", "setTimeout(() => undefined, 30_000)"],
        timeoutMs: 40
      },
      { killGraceMs: 100 }
    );

    const completed = await session.completion;
    expect(completed.status).toBe("timed_out");
    expect(completed.exitCode).not.toBe(0);
  });

  it("stops an owned child process tree", async () => {
    const workspacePath = await temporaryProject();
    const nestedProgram = "setInterval(() => undefined, 30_000)";
    const streamed: string[] = [];
    const session = await TerminalSession.start(
      {
        runId: "tree-run",
        stepId: "tree-step",
        workspacePath,
        cwd: workspacePath,
        executable: process.execPath,
        args: [
          "-e",
          `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(nestedProgram)}], { stdio: 'ignore' }); console.log('child:' + child.pid); setInterval(() => undefined, 30_000)`
        ],
        onOutput(event) {
          streamed.push(event.text);
        }
      },
      { killGraceMs: 200 }
    );
    await session.waitForReadiness({ logPattern: "child:" });
    const childPid = Number(streamed.join("").match(/child:(\d+)/)?.[1]);
    expect(childPid).toBeGreaterThan(0);

    try {
      await session.stop();
      await expect(waitForTermination(childPid)).resolves.toBe(true);
    } finally {
      if (!(await isTerminated(childPid))) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The cleanup assertion already reports a failed owned-tree shutdown.
        }
      }
    }
  });

  it("waits for readiness, restarts the owned runtime, and releases its port", async () => {
    const workspacePath = await temporaryProject({ space: true });
    const port = await freePort();
    const supervisor = new RuntimeSupervisor({ portReleaseTimeoutMs: 5_000, killGraceMs: 200 });
    const request = {
      runId: "runtime-run",
      stepId: "runtime-step",
      workspacePath,
      cwd: workspacePath,
      executable: process.execPath,
      args: [
        "-e",
        "const http = require('node:http'); const server = http.createServer((_, response) => response.end('ok')); server.listen(process.env.TEST_PORT, '127.0.0.1', () => console.log('ready')); process.once('SIGTERM', () => server.close(() => process.exit(0)));"
      ],
      env: { TEST_PORT: String(port) },
      readiness: {
        logPattern: "ready",
        httpUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 5_000
      },
      expectedPorts: [port]
    };

    const first = await supervisor.start(request);
    expect((await fetch(`http://127.0.0.1:${port}`)).status).toBe(200);
    const restarted = await supervisor.restart(first.snapshot().id);
    expect(restarted.snapshot().id).not.toBe(first.snapshot().id);
    expect((await fetch(`http://127.0.0.1:${port}`)).status).toBe(200);

    const completed = await supervisor.stop(restarted.snapshot().id);
    expect(completed.status).toBe("cancelled");
    await expect(isPortAvailable(port)).resolves.toBe(true);
  });
});

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

async function waitForTermination(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await isTerminated(pid)) return true;
    await delay(25);
  }
  return isTerminated(pid);
}

async function isTerminated(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
