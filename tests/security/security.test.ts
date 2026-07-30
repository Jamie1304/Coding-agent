import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { AgentDatabase } from "@agent/database";
import { RunService, redactSecrets, validatePathWithinWorkspace } from "@agent/core";
import { createDaemon } from "../../apps/daemon/src/server.js";
import { temporaryProject } from "../helpers.js";

describe("security boundaries", () => {
  it("rejects unauthenticated and invalid-token daemon requests", async () => {
    const database = new AgentDatabase();
    const daemon = await createDaemon({
      token: "correct-token",
      database,
      runService: new RunService(database)
    });
    expect((await fetch(`${daemon.url}/api/runs`)).status).toBe(401);
    expect(
      (
        await fetch(`${daemon.url}/api/runs`, {
          headers: { "x-agent-token": "wrong-token" }
        })
      ).status
    ).toBe(401);
    expect(
      (
        await fetch(`${daemon.url}/api/runs`, {
          headers: { "x-agent-token": "correct-token" }
        })
      ).status
    ).toBe(200);
    await daemon.close();
    database.close();
  });

  it("allows loopback desktop preflight without weakening API token checks", async () => {
    const database = new AgentDatabase();
    const daemon = await createDaemon({ token: "cors-token", database });
    const preflight = await fetch(`${daemon.url}/api/workspace/current`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-agent-token"
      }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    const unauthorized = await fetch(`${daemon.url}/api/workspace/current`, {
      headers: { origin: "http://127.0.0.1:5173" }
    });
    expect(unauthorized.status).toBe(401);
    const hostile = await fetch(`${daemon.url}/api/workspace/current`, {
      method: "OPTIONS",
      headers: { origin: "https://example.test" }
    });
    expect(hostile.status).toBe(403);
    await daemon.close();
    database.close();
  });

  it("rejects traversal and workspace escape", async () => {
    const root = await temporaryProject();
    await expect(validatePathWithinWorkspace(root, "..\\outside.txt")).rejects.toThrow(
      "escapes workspace"
    );
    await expect(
      validatePathWithinWorkspace(root, join(root, "src", "index.ts"))
    ).resolves.toContain("index.ts");
  });

  it("redacts common API and GitHub secrets", () => {
    const value = redactSecrets(
      "authorization: Bearer abcdefghijk token=super-secret sk-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz"
    );
    expect(value).not.toContain("super-secret");
    expect(value).not.toContain("sk-");
    expect(value).not.toContain("ghp_");
  });

  it("keeps renderer privilege isolation explicit", async () => {
    const source = await readFile(
      join(process.cwd(), "apps", "desktop", "src", "main", "index.ts"),
      "utf8"
    );
    expect(source).toContain("contextIsolation: true");
    expect(source).toContain("sandbox: true");
    expect(source).toContain("nodeIntegration: false");
  });
});
