import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  acquireDevelopmentLock,
  desktopDevelopmentEnvironment,
  startRenderer
} from "../../scripts/dev-supervisor.js";
import { temporaryProject } from "../helpers.js";

describe("development startup lock", () => {
  it("replaces a stale lock and rejects a live duplicate", async () => {
    const root = await temporaryProject({ space: true });
    const lock = join(root, ".agent", "dev-run.lock.json");
    await acquireDevelopmentLock(lock, root);
    const current = JSON.parse(await readFile(lock, "utf8")) as { pid: number };
    expect(current.pid).toBe(process.pid);
    await writeFile(lock, JSON.stringify({ ...current, pid: 2_147_483_000 }), "utf8");
    await acquireDevelopmentLock(lock, root);
    await expect(acquireDevelopmentLock(lock, root)).rejects.toThrow(/already running/i);
  });

  it("selects and communicates an alternative renderer port, then releases it", async () => {
    const blocker = createServer();
    await new Promise<void>((resolveListen) => blocker.listen(0, "127.0.0.1", resolveListen));
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("No blocker port");
    const renderer = await startRenderer(process.cwd(), address.port);
    expect(renderer.url).not.toBe(`http://127.0.0.1:${address.port}`);
    const environment = desktopDevelopmentEnvironment(
      { ELECTRON_RUN_AS_NODE: "1" },
      "http://127.0.0.1:60100",
      renderer.url,
      "C:\\Agent Data"
    );
    expect(environment.PERSONAL_CODEX_AGENT_RENDERER_URL).toBe(renderer.url);
    expect(environment.PERSONAL_CODEX_AGENT_DAEMON_URL).toBe("http://127.0.0.1:60100");
    expect(environment.ELECTRON_RUN_AS_NODE).toBeUndefined();
    await renderer.server.close();
    await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
    const rendererPort = Number(new URL(renderer.url).port);
    const releaseProbe = createServer();
    await new Promise<void>((resolveListen) =>
      releaseProbe.listen(rendererPort, "127.0.0.1", resolveListen)
    );
    await new Promise<void>((resolveClose) => releaseProbe.close(() => resolveClose()));
  });
});
