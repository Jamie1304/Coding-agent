import { AgentDatabase } from "@agent/database";
import { RuntimeCorrectionController, StepGateEngine, StepPlanService } from "@agent/core";
import {
  ApprovedStepPlanSchema,
  type ApprovedStepPlan,
  type StepTerminalOperation
} from "@agent/shared";
import { temporaryProject } from "../helpers.js";

const timestamp = "2026-08-03T12:00:00.000Z";

describe("runtime correction control", () => {
  it("pauses on a recorded error and blocks repeated non-improving corrections", async () => {
    const context = await correctionContext("retry-run");
    const { controller, plans, gates } = context;
    const error = controller.recordTerminalOperation(failedOperation("retry-run"))[0]!;
    expect(gates.snapshot("retry-run").gates[0]?.state).toBe("STEP_RUNTIME_ERROR_ANALYSIS");
    controller.beginCorrection("retry-run", "runtime-step");

    expect(
      controller.recordAttempt({
        runId: "retry-run",
        stepId: "runtime-step",
        errorSignature: error.signature,
        hypothesis: "Retry the same startup configuration.",
        outcome: "no_change",
        notes: "The process continued to fail."
      })
    ).toBe("retry");
    expect(
      controller.recordAttempt({
        runId: "retry-run",
        stepId: "runtime-step",
        errorSignature: error.signature,
        hypothesis: "Try one more bounded configuration adjustment.",
        outcome: "failed",
        notes: "The signature did not improve."
      })
    ).toBe("independent_diagnosis");

    expect(plans.runtimeCorrections("retry-run", "runtime-step")).toHaveLength(2);
    expect(plans.runtimeErrors("retry-run", "runtime-step")[0]?.status).toBe("external");
    expect(gates.snapshot("retry-run").gates[0]?.state).toBe("STEP_BLOCKED");
    context.database.close();
  });

  it("requires persisted focused regression evidence before validation can resume", async () => {
    const context = await correctionContext("resolved-run");
    const { controller, plans, gates } = context;
    const error = controller.recordTerminalOperation(failedOperation("resolved-run"))[0]!;
    controller.beginCorrection("resolved-run", "runtime-step");
    expect(() =>
      controller.recordAttempt({
        runId: "resolved-run",
        stepId: "runtime-step",
        errorSignature: error.signature,
        hypothesis: "Apply the corrected startup option.",
        outcome: "resolved",
        notes: "The known error no longer occurs."
      })
    ).toThrow(/regression evidence/i);
    expect(plans.runtimeCorrections("resolved-run", "runtime-step")).toHaveLength(0);

    plans.saveEvidence({
      id: "focused-regression",
      runId: "resolved-run",
      stepId: "runtime-step",
      kind: "runtime-test",
      locator: "steps/001-runtime-step/focused-tests.md",
      contentHash: null,
      summary: "Focused regression test passed after correction.",
      payload: { passed: true },
      createdAt: timestamp
    });
    expect(
      controller.recordAttempt({
        runId: "resolved-run",
        stepId: "runtime-step",
        errorSignature: error.signature,
        hypothesis: "Apply the corrected startup option.",
        outcome: "resolved",
        notes: "The known error no longer occurs.",
        regressionEvidenceId: "focused-regression"
      })
    ).toBe("validation");
    expect(plans.runtimeErrors("resolved-run", "runtime-step")[0]?.status).toBe("resolved");
    expect(gates.snapshot("resolved-run").gates[0]?.state).toBe("STEP_AUTOMATED_TEST_CREATION");
    context.database.close();
  });
});

async function correctionContext(runId: string) {
  const workspacePath = await temporaryProject();
  const database = new AgentDatabase();
  database.createRun({
    id: runId,
    workspacePath,
    repositoryIdentity: null,
    startingCommit: null,
    state: "EXECUTING_STEPS",
    finalStatus: null,
    originalPrompt: "Control recorded runtime correction.",
    approvedPrompt: "Control recorded runtime correction.",
    approvedRevision: 1,
    createdAt: timestamp,
    approvedAt: timestamp,
    completedAt: null,
    retryCount: 0
  });
  const plans = new StepPlanService(database);
  await plans.initialize(plan(runId), workspacePath);
  const gates = new StepGateEngine(plans);
  for (const [from, to] of [
    ["STEP_READY", "STEP_CONTEXT_ANALYSIS"],
    ["STEP_CONTEXT_ANALYSIS", "STEP_IMPLEMENTATION"],
    ["STEP_IMPLEMENTATION", "STEP_AUTOMATED_TEST_CREATION"],
    ["STEP_AUTOMATED_TEST_CREATION", "STEP_FOCUSED_VALIDATION"],
    ["STEP_FOCUSED_VALIDATION", "STEP_RUNTIME_START"],
    ["STEP_RUNTIME_START", "STEP_RUNTIME_INTERACTION"]
  ] as const) {
    gates.transition(runId, "runtime-step", from, to, timestamp);
  }
  return {
    database,
    plans,
    gates,
    controller: new RuntimeCorrectionController(plans, gates, { maximumAttempts: 2 })
  };
}

function plan(runId: string): ApprovedStepPlan {
  return ApprovedStepPlanSchema.parse({
    version: 1,
    id: `${runId}-plan`,
    runId,
    approvedRevision: 1,
    frozenAt: timestamp,
    createdAt: timestamp,
    steps: [
      {
        id: "runtime-step",
        order: 1,
        title: "Runtime correction",
        objective: "Correct a recorded runtime error.",
        reason: "The runtime must be proven before progression.",
        acceptanceCriteria: [{ id: "corrected", description: "The error is corrected." }]
      }
    ]
  });
}

function failedOperation(runId: string): StepTerminalOperation {
  return {
    id: `${runId}-operation`,
    runId,
    stepId: "runtime-step",
    command: "node fixture.js",
    executable: "node",
    safeArguments: ["fixture.js"],
    workingDirectory: process.cwd(),
    startedAt: timestamp,
    readyAt: null,
    completedAt: timestamp,
    processId: 1,
    childProcessIds: [],
    exitCode: 1,
    signal: null,
    status: "failed",
    stdoutLocator: null,
    stderrLocator: "database://stderr",
    combinedLogLocator: "database://combined",
    normalizedLog: null,
    errorsDetected: [
      {
        id: `${runId}-error`,
        runId,
        stepId: "runtime-step",
        signature: "error:fixture",
        category: "startup",
        severity: "error",
        message: "Fixture startup error",
        source: "terminal-session:stderr",
        evidencePath: "database://combined",
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        occurrences: 1,
        status: "open",
        resolution: "Pending runtime correction"
      }
    ],
    warningsDetected: [],
    secretRedactionApplied: true
  };
}
