import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeGitHubAdapter, ReportGenerator } from "@agent/core";
import type { FinalReport } from "@agent/shared";
import { temporaryProject } from "../helpers.js";

describe("GitHub and reporting adapters", () => {
  it("executes a deterministic mocked GitHub lifecycle", async () => {
    const github = new FakeGitHubAdapter();
    expect((await github.checkAuthentication()).authenticated).toBe(true);
    expect(await github.createIssue("", "", "")).toBe(100);
    expect(
      (
        await github.createPullRequest({
          repository: "",
          title: "",
          body: "",
          branch: "",
          base: ""
        })
      ).number
    ).toBe(200);
    expect(await github.waitForCi("", "")).toBe("success");
    expect(await github.merge("", 200, "squash")).toBe("fake-merge-commit");
  });

  it("creates the complete artifact set and evidence JSON", async () => {
    const root = await temporaryProject();
    const generator = new ReportGenerator();
    const directory = await generator.initialize(root, "run-1");
    const report: FinalReport = {
      runId: "run-1",
      finalStatus: "success",
      workspace: root,
      startingCommit: "abc",
      finalCommit: "def",
      approvedRevision: 1,
      implementationSummary: ["Implemented behavior"],
      changedFiles: ["src/index.ts"],
      tests: { total: 1, passed: 1, failed: 0, skipped: 0 },
      qualityGates: [{ name: "test", status: "passed", evidence: "exit 0" }],
      securityFindings: [],
      dependencyChanges: [],
      github: { issue: null, branch: null, pullRequest: null, mergeCommit: null },
      deployments: {
        staging: "not_configured",
        production: "not_configured",
        rollback: "not_required"
      },
      version: { previous: "0.0.0", new: "0.1.0", tag: "v0.1.0" },
      knownLimitations: [],
      blockers: []
    };
    await generator.writeFinal(directory, report);
    await access(join(directory, "rollback-report.md"));
    expect(JSON.parse(await readFile(join(directory, "final-report.json"), "utf8"))).toEqual(
      report
    );
  });
});
