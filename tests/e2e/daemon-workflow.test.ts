import { AgentDatabase } from "@agent/database";
import { RunService } from "@agent/core";
import { createDaemon } from "../../apps/daemon/src/server.js";
import { temporaryProject } from "../helpers.js";

describe("local API workflow", () => {
  it("handles workspace detection, prompt, questions, approval, restart recovery, and cancellation", async () => {
    const root = await temporaryProject({ git: true, space: true });
    const database = new AgentDatabase();
    const service = new RunService(database);
    const daemon = await createDaemon({
      token: "e2e-token",
      database,
      runService: service
    });
    const request = async (path: string, init?: RequestInit) =>
      fetch(`${daemon.url}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-agent-token": "e2e-token",
          ...init?.headers
        }
      });
    const workspace = await request("/api/workspace/current", {
      method: "POST",
      body: JSON.stringify({ path: root, name: "fixture", trusted: true, source: "vscode" })
    });
    expect(workspace.status).toBe(200);
    const createdResponse = await request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        workspacePath: root,
        prompt: "Create a new external integration with safe failure behavior",
        relevantPaths: []
      })
    });
    expect(createdResponse.status).toBe(201);
    let view = (await createdResponse.json()) as {
      run: { id: string; state: string };
      questions: Array<{ id: string; options: string[] }>;
    };
    expect(view.run.state).toBe("QUESTIONING");
    const answered = await request(`/api/runs/${view.run.id}/answers`, {
      method: "POST",
      body: JSON.stringify({
        answers: view.questions.map((question) => ({
          questionId: question.id,
          answer: question.options[0] ?? "Fail safely"
        }))
      })
    });
    view = await answered.json();
    expect(view.run.state).toBe("AWAITING_APPROVAL");
    expect(service.restore()).toHaveLength(1);
    const cancelled = await request(`/api/runs/${view.run.id}/cancel`, {
      method: "POST",
      body: "{}"
    });
    expect(((await cancelled.json()) as { run: { state: string } }).run.state).toBe("CANCELLED");
    await daemon.close();
    database.close();
  });
});
