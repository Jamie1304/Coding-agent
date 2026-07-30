import { AgentDatabase } from "@agent/database";
import { RunService } from "@agent/core";
import { temporaryProject } from "../helpers.js";

describe("prompt run service", () => {
  it("submits, analyzes, questions, revises, rejects differently, approves, and freezes", async () => {
    const root = await temporaryProject({ git: true });
    const database = new AgentDatabase();
    const service = new RunService(database);
    let view = await service.create(root, "Add authenticated upload support with tests");
    expect(view.run.state).toBe("QUESTIONING");
    expect(view.run.approvedPrompt).toBeNull();
    view = await service.answer(
      view.run.id,
      view.questions.map((question) => ({
        questionId: question.id,
        answer: question.options[0] ?? "Fail safely and show retry"
      }))
    );
    expect(view.run.state).toBe("AWAITING_APPROVAL");
    const firstIds = new Set(view.questions.map((question) => question.id));
    view = await service.reject(view.run.id, "Use explicit retry controls, not automatic retries");
    expect(view.run.state).toBe("QUESTIONING");
    expect(view.questions.some((question) => !firstIds.has(question.id))).toBe(true);
    const pending = view.questions.filter(
      (question) => !question.confirmed && !question.superseded
    );
    view = await service.answer(
      view.run.id,
      pending.map((question) => ({ questionId: question.id, answer: "Show a Retry button" }))
    );
    expect(view.run.state).toBe("AWAITING_APPROVAL");
    view = await service.approve(view.run.id);
    expect(view.run.state).toBe("PREFLIGHT");
    expect(view.run.approvedPrompt).toContain("Approved implementation specification");
    expect(view.revisions.at(-1)?.approved).toBe(true);
    expect(view.revisions.at(-1)?.frozenAt).not.toBeNull();
    database.close();
  });

  it("prevents approval and execution before alignment", async () => {
    const root = await temporaryProject();
    const service = new RunService(new AgentDatabase());
    const view = await service.create(root, "Add a feature with external API behavior");
    await expect(service.approve(view.run.id)).rejects.toThrow("not awaiting approval");
  });
});
