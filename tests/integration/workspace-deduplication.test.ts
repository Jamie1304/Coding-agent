import { AgentDatabase } from "@agent/database";
import { createDaemon } from "../../apps/daemon/src/server.js";

describe("workspace snapshot synchronization", () => {
  it("deduplicates identical snapshots while preserving real changes and client metadata", async () => {
    const database = new AgentDatabase();
    const daemon = await createDaemon({ token: "workspace-token", database });
    const send = async (snapshot: Record<string, unknown>, source: "desktop" | "vscode") => {
      const response = await fetch(`${daemon.url}/api/workspace/current`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-token": "workspace-token"
        },
        body: JSON.stringify({
          snapshot,
          metadata: {
            source,
            timestamp: new Date().toISOString(),
            clientInstanceId: `${source}-test`
          }
        })
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{
        changed: boolean;
        snapshotHash: string;
        metadata: { source: string };
      }>;
    };
    const initial = { path: process.cwd(), name: "agent", trusted: true, activeFile: null };
    const first = await send(initial, "desktop");
    const duplicate = await send(initial, "vscode");
    const changed = await send({ ...initial, activeFile: "README.md" }, "vscode");
    expect(first.changed).toBe(true);
    expect(duplicate.changed).toBe(false);
    expect(duplicate.snapshotHash).toBe(first.snapshotHash);
    expect(duplicate.metadata.source).toBe("vscode");
    expect(changed.changed).toBe(true);
    expect(changed.snapshotHash).not.toBe(first.snapshotHash);
    await daemon.close();
    database.close();
  });
});
