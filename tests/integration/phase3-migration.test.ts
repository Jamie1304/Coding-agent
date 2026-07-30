import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentDatabase } from "@agent/database";
import { StepPlanService } from "@agent/core";
import type { ApprovedStepPlan } from "@agent/shared";

const timestamp = "2026-07-30T13:00:00.000Z";

function approvedPlan(runId: string): ApprovedStepPlan {
  return {
    version: 1,
    id: "phase-3",
    runId,
    approvedRevision: 1,
    frozenAt: timestamp,
    createdAt: timestamp,
    steps: [
      {
        id: "schema",
        order: 1,
        title: "Schema",
        objective: "Persist the plan.",
        reason: "Gates require durable state.",
        prerequisites: [],
        dependencies: [],
        acceptanceCriteria: [{ id: "persisted", description: "Plan reloads." }],
        expectedChanges: {
          filesToCreate: [],
          filesToModify: [],
          components: [],
          routes: [],
          APIs: [],
          databaseChanges: []
        },
        requiredTests: {
          unit: [],
          integration: [],
          api: [],
          ui: [],
          endToEnd: [],
          security: [],
          runtime: [],
          restart: []
        },
        runtimeValidation: {
          startCommands: [],
          expectedProcesses: [],
          expectedPorts: [],
          routesToVisit: [],
          apiRequests: [],
          uiActions: [],
          expectedLogs: [],
          forbiddenErrors: [],
          restartCount: 1
        },
        documentationUpdates: [],
        projectKnowledgeUpdates: [],
        completionEvidence: [],
        gitCheckpoint: {
          commitType: "feat",
          commitScope: "steps",
          expectedCommitMessage: "feat(steps): persist approved plans and completion evidence",
          pushRequired: true,
          pullRequestUpdateRequired: true
        }
      }
    ]
  };
}

describe("Phase 2 to Phase 3 database migration", () => {
  it("preserves legacy runs and reloads durable plan evidence after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-phase3-migration-"));
    const path = join(directory, "phase2.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES(1, '2026-01-01T00:00:00.000Z');
      INSERT INTO schema_migrations VALUES(2, '2026-01-02T00:00:00.000Z');
      CREATE TABLE runs(
        id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, repository_identity TEXT, starting_commit TEXT,
        state TEXT NOT NULL, final_status TEXT, original_prompt TEXT NOT NULL, approved_prompt TEXT,
        approved_revision INTEGER, created_at TEXT NOT NULL, approved_at TEXT, completed_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0
      );
    `);
    old
      .prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        "legacy-run",
        directory,
        null,
        null,
        "AWAITING_APPROVAL",
        null,
        "Legacy frozen prompt",
        "Legacy frozen prompt",
        1,
        timestamp,
        timestamp,
        null,
        0
      );
    old.close();

    const migrated = new AgentDatabase(path);
    expect(migrated.getRun("legacy-run")?.state).toBe("AWAITING_APPROVAL");
    const service = new StepPlanService(migrated);
    const plan = approvedPlan("legacy-run");
    await service.initialize(plan, directory);
    const inProgressGate = {
      ...service.gates("legacy-run")[0]!,
      state: "IN_PROGRESS" as const,
      updatedAt: timestamp
    };
    service.saveGate(inProgressGate);
    service.saveAmendment({
      id: "amendment-1",
      runId: "legacy-run",
      stepId: "schema",
      reason: "Clarify evidence naming.",
      impact: "No change to the frozen acceptance criteria.",
      status: "approved",
      proposedAt: timestamp,
      approvedAt: timestamp,
      priorPlanHash: "before",
      amendedPlanHash: "after"
    });
    service.saveEvidence({
      id: "evidence-1",
      runId: "legacy-run",
      stepId: "schema",
      kind: "terminal-operation",
      locator: "steps/001-schema/terminal-operations.jsonl",
      contentHash: null,
      summary: "Migration initialized.",
      payload: { exitCode: 0 },
      createdAt: timestamp
    });
    service.saveTerminalOperation({
      id: "operation-1",
      runId: "legacy-run",
      stepId: "schema",
      executable: "npm.cmd",
      command: "npm.cmd run test",
      safeArguments: ["run", "test"],
      workingDirectory: directory,
      startedAt: timestamp,
      readyAt: timestamp,
      completedAt: timestamp,
      processId: 1,
      childProcessIds: [],
      exitCode: 0,
      signal: null,
      status: "passed",
      stdoutLocator: "logs/test.stdout.log",
      stderrLocator: null,
      combinedLogLocator: "logs/test.combined.log",
      errorsDetected: [],
      warningsDetected: [],
      secretRedactionApplied: true
    });
    service.saveRuntimeError({
      id: "error-1",
      runId: "legacy-run",
      stepId: "schema",
      signature: "none",
      category: "database",
      severity: "warning",
      message: "No runtime error occurred; durable migration evidence was verified.",
      source: "migration test",
      evidencePath: "steps/001-schema/runtime-errors.json",
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      occurrences: 1,
      status: "resolved",
      resolution: "Verified by migration test."
    });
    await access(
      join(directory, ".agent-runs", "legacy-run", "steps", "001-schema", "completion-gate.json")
    );
    await access(join(directory, ".agent-runs", "legacy-run", "approved-step-plan.md"));
    const contextPath = join(
      directory,
      ".agent-runs",
      "legacy-run",
      "steps",
      "001-schema",
      "context-analysis.md"
    );
    await writeFile(contextPath, "preserve this evidence", "utf8");
    await service.initialize(plan, directory);
    expect(await readFile(contextPath, "utf8")).toBe("preserve this evidence");
    expect(migrated.stepCompletionGates("legacy-run")[0]?.state).toBe("IN_PROGRESS");
    expect(migrated.planSteps("legacy-run")[0]?.state).toBe("IN_PROGRESS");
    const changedPlan = structuredClone(plan);
    changedPlan.steps[0]!.title = "Changed after approval";
    await expect(service.initialize(changedPlan, directory)).rejects.toThrow(/cannot be replaced/i);
    expect(migrated.stepEvidence("legacy-run")).toHaveLength(1);
    migrated.close();

    const reopened = new AgentDatabase(path);
    expect(new StepPlanService(reopened).plan("legacy-run")).toEqual(plan);
    expect(reopened.getRun("legacy-run")?.state).toBe("AWAITING_APPROVAL");
    expect(reopened.planSteps("legacy-run")).toHaveLength(1);
    expect(reopened.stepCompletionGates("legacy-run")).toHaveLength(1);
    expect(reopened.stepCompletionGates("legacy-run")[0]?.state).toBe("IN_PROGRESS");
    expect(reopened.planSteps("legacy-run")[0]?.state).toBe("IN_PROGRESS");
    expect(reopened.stepAmendments("legacy-run")).toHaveLength(1);
    expect(reopened.stepTerminalOperations("legacy-run")).toHaveLength(1);
    expect(reopened.stepRuntimeErrors("legacy-run")).toHaveLength(1);
    expect(
      reopened.raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    reopened.close();
  });
});
