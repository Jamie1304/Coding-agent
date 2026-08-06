import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DaemonManager, type OwnedProcess } from "../../apps/desktop/src/main/runtime-manager.js";
import { temporaryProject } from "../helpers.js";

describe("desktop daemon manager", () => {
  it("uses a fresh token, verifies authenticated readiness, and removes only its own metadata", async () => {
    const directory = await temporaryProject();
    let token = "";
    const process = ownedProcess();
    const manager = new DaemonManager({
      dataDirectory: directory,
      productVersion: "1.2.3",
      launch: (input) => {
        token = input.token;
        return {
          process,
          ready: Promise.resolve({ url: "http://127.0.0.1:43121", pid: process.pid })
        };
      },
      fetcher: async (input, init) => {
        expect(input).toBe("http://127.0.0.1:43121/health");
        expect(init?.headers).toEqual({ "x-agent-token": token });
        return new Response(
          JSON.stringify({ status: "ok", bind: "127.0.0.1", version: "1.2.3", protocol: 1 }),
          { status: 200 }
        );
      }
    });

    const connection = await manager.start();
    expect(connection.token).toBe(token);
    expect(connection.token).toHaveLength(43);
    expect(manager.getStatus().phase).toBe("ready");
    const metadata = JSON.parse(await readFile(join(directory, "daemon.json"), "utf8")) as {
      owner: string;
      token: string;
    };
    expect(metadata.owner).toBe("desktop");
    expect(metadata.token).toBe(token);

    await manager.stop();
    expect(process.killed).toBe(true);
    await expect(readFile(join(directory, "daemon.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("fails closed when the daemon version or protocol is incompatible", async () => {
    const manager = new DaemonManager({
      dataDirectory: await temporaryProject(),
      productVersion: "1.2.3",
      restartLimit: 0,
      launch: () => {
        const process = ownedProcess();
        return {
          process,
          ready: Promise.resolve({ url: "http://127.0.0.1:43122", pid: process.pid })
        };
      },
      fetcher: async () =>
        new Response(
          JSON.stringify({ status: "ok", bind: "127.0.0.1", version: "9.9.9", protocol: 2 }),
          { status: 200 }
        )
    });

    await expect(manager.start()).rejects.toThrow("Runtime compatibility check failed");
    expect(manager.getStatus().phase).toBe("failed");
  });

  it("never deletes connection metadata that it does not own", async () => {
    const directory = await temporaryProject();
    const metadataPath = join(directory, "daemon.json");
    await writeFile(metadataPath, JSON.stringify({ owner: "developer", token: "keep" }), "utf8");
    const manager = new DaemonManager({
      dataDirectory: directory,
      restartLimit: 0,
      launch: () => ({ process: ownedProcess(), ready: Promise.reject(new Error("boom")) })
    });

    await expect(manager.start()).rejects.toThrow("boom");
    expect(await readFile(metadataPath, "utf8")).toContain('"owner":"developer"');
  });
});

function ownedProcess(onExit?: (listener: (code: number | null) => void) => void): OwnedProcess & {
  killed: boolean;
} {
  return {
    pid: 4422,
    killed: false,
    kill() {
      this.killed = true;
    },
    onExit(listener) {
      onExit?.(listener);
    }
  };
}
