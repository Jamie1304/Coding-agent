import { FakeDeploymentAdapter } from "@agent/core";
import type { ProjectConfig } from "@agent/shared";

const config: ProjectConfig = {
  version: 1,
  quality: { install: [], focused: [], full: [], security: [] },
  github: { enabled: false, mergeMethod: "squash", autoMerge: false },
  deployment: {
    adapter: "custom",
    build: [],
    staging: [],
    stagingSmoke: [],
    production: [],
    productionSmoke: [],
    rollback: []
  }
};

describe("deployment adapters", () => {
  it("supports success and production-smoke rollback scenarios", async () => {
    const adapter = new FakeDeploymentAdapter();
    const context = { runId: "run", cwd: process.cwd(), commit: "abc", config };
    expect((await adapter.deployStaging(context)).status).toBe("success");
    expect((await adapter.testStaging(context)).status).toBe("success");
    expect((await adapter.deployProduction(context)).status).toBe("success");
    adapter.productionSmokeFails = true;
    expect((await adapter.testProduction(context)).status).toBe("failed");
    expect((await adapter.rollback(context)).status).toBe("success");
    expect(adapter.rolledBack).toBe(true);
  });
});
