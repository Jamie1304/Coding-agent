import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskDescriptor } from "@agent/ai";
import { EvidenceVerifier, ParallelTaskScheduler, validateOwnership } from "@agent/core";
import { temporaryProject } from "../helpers.js";

function task(id: string, dependencies: string[] = [], files: string[] = []): TaskDescriptor {
  return {
    id,
    runId: "run",
    title: id,
    description: id,
    role: files.length ? "coding" : "repository_analysis",
    expectedInputTokens: 100,
    expectedOutputTokens: 100,
    requiredTools: false,
    requiredVision: false,
    repositoryWrite: files.length > 0,
    sensitive: false,
    likelyFiles: files,
    dependencies,
    risk: "low"
  };
}

describe("parallel scheduler", () => {
  it("runs independent tasks concurrently and observes dependencies/provider limits", async () => {
    let active = 0;
    let maximum = 0;
    const order: string[] = [];
    const scheduler = new ParallelTaskScheduler(3, { provider: 2 });
    const results = await scheduler.run(
      [task("a"), task("b"), task("c", ["a", "b"])],
      () => "provider",
      async (item) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(item.id);
        active -= 1;
        return item.id;
      }
    );
    expect(maximum).toBe(2);
    expect(order.at(-1)).toBe("c");
    expect(results.every((result) => result.state === "passed")).toBe(true);
  });

  it("blocks dependents after worker failure", async () => {
    const results = await new ParallelTaskScheduler(2).run(
      [task("a"), task("b", ["a"])],
      () => "provider",
      async () => {
        throw new Error("worker failed");
      }
    );
    expect(results).toEqual([
      expect.objectContaining({ taskId: "a", state: "failed" }),
      expect.objectContaining({ taskId: "b", state: "blocked" })
    ]);
  });

  it("rejects overlapping write ownership and dependency cycles", async () => {
    expect(() =>
      validateOwnership([task("a", [], ["src/a.ts"]), task("b", [], ["SRC/A.ts"])])
    ).toThrow("Overlapping file ownership");
    await expect(
      new ParallelTaskScheduler(1).run(
        [task("a", ["b"]), task("b", ["a"])],
        () => "provider",
        async () => true
      )
    ).rejects.toThrow("cycle");
  });

  it("cancels active and queued work", async () => {
    const scheduler = new ParallelTaskScheduler(1);
    const run = scheduler.run(
      [task("a"), task("b")],
      () => "provider",
      async (_item, signal) =>
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    scheduler.cancel();
    expect(await run).toEqual([
      expect.objectContaining({ state: "cancelled" }),
      expect.objectContaining({ state: "cancelled" })
    ]);
  });
});

describe("evidence verification", () => {
  it("accepts real files and command artifacts and rejects fabricated claims", async () => {
    const workspace = await temporaryProject();
    await writeFile(join(workspace, "proof.txt"), "proof", "utf8");
    const verifier = new EvidenceVerifier();
    expect(
      await verifier.verify(
        workspace,
        { id: "file", claim: "exists", type: "file", locator: "proof.txt" },
        { commandEvidence: [] }
      )
    ).toMatchObject({ state: "verified", confidence: 1 });
    expect(
      await verifier.verify(
        workspace,
        { id: "fake", claim: "exists", type: "file", locator: "fabricated.txt" },
        { commandEvidence: [] }
      )
    ).toMatchObject({ state: "rejected", requiresEscalation: true });
    expect(
      await verifier.verify(
        workspace,
        { id: "test", claim: "tests passed", type: "test", locator: "npm test" },
        { commandEvidence: [] }
      )
    ).toMatchObject({ state: "rejected" });
  });

  it("validates structured output and abstains on unsupported external claims", async () => {
    const verifier = new EvidenceVerifier();
    const workspace = await temporaryProject();
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false
    };
    expect(
      await verifier.verify(
        workspace,
        { id: "structured", claim: "valid", type: "structured", locator: "", payload: {} },
        { commandEvidence: [], schema }
      )
    ).toMatchObject({ state: "rejected" });
    const unknown = await verifier.verify(
      workspace,
      { id: "external", claim: "current fact", type: "external", locator: "web" },
      { commandEvidence: [] }
    );
    expect(unknown).toMatchObject({ state: "unknown", confidence: 0, requiresEscalation: true });
    expect(() => verifier.requireSuccess([unknown])).toThrow("Insufficient evidence");
  });
});
