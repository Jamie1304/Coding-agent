import { AgentDatabase } from "@agent/database";
import {
  InvalidStepTransitionError,
  StepGateEngine,
  StepPlanService,
  canTransitionStep,
  stepExecutionStates
} from "@agent/core";
import {
  ApprovedStepPlanSchema,
  type ApprovedStepPlan,
  type StepCompletionGate
} from "@agent/shared";
import { temporaryProject } from "../helpers.js";

const timestamp = "2026-08-03T12:00:00.000Z";

function plan(runId: string): ApprovedStepPlan {
  return ApprovedStepPlanSchema.parse({
    version: 1,
    id: "gated-plan",
    runId,
    approvedRevision: 1,
    frozenAt: timestamp,
    createdAt: timestamp,
    steps: [
      {
        id: "first-step",
        order: 1,
        title: "First step",
        objective: "Establish the gated transition path.",
        reason: "Later work must remain locked.",
        acceptanceCriteria: [{ id: "first-complete", description: "The first step can complete." }]
      },
      {
        id: "second-step",
        order: 2,
        title: "Second step",
        objective: "Remain locked until the first step completes.",
        reason: "Chronological execution is mandatory.",
        dependencies: ["first-step"],
        acceptanceCriteria: [{ id: "second-locked", description: "The second step stays locked." }]
      }
    ]
  });
}

function completed(gate: StepCompletionGate): StepCompletionGate {
  return {
    ...gate,
    state: "STEP_PULL_REQUEST_UPDATE",
    blockingRequirements: [],
    criteria: Object.fromEntries(
      Object.keys(gate.criteria).map((criterion) => [
        criterion,
        { applicable: true, passed: true, evidenceIds: ["completion-evidence"] }
      ])
    ) as StepCompletionGate["criteria"]
  };
}

describe("StepGateEngine", () => {
  it("enforces ordered transitions and unlocks only the next completed step", async () => {
    const root = await temporaryProject();
    const database = new AgentDatabase();
    database.createRun({
      id: "step-gate-run",
      workspacePath: root,
      repositoryIdentity: null,
      startingCommit: null,
      state: "EXECUTING_STEPS",
      finalStatus: null,
      originalPrompt: "Gated workflow test",
      approvedPrompt: "Gated workflow test",
      approvedRevision: 1,
      createdAt: timestamp,
      approvedAt: timestamp,
      completedAt: null,
      retryCount: 0
    });
    const plans = new StepPlanService(database);
    await plans.initialize(plan("step-gate-run"), root);
    const engine = new StepGateEngine(plans);

    expect(engine.snapshot("step-gate-run").gates.map((gate) => gate.state)).toEqual([
      "STEP_READY",
      "STEP_LOCKED"
    ]);
    expect(() =>
      plans.saveGate({
        ...engine.snapshot("step-gate-run").gates[0]!,
        state: "STEP_CONTEXT_ANALYSIS"
      })
    ).toThrow(/must use the chronological StepGateEngine/);
    expect(() =>
      engine.transition(
        "step-gate-run",
        "second-step",
        "STEP_LOCKED",
        "STEP_CONTEXT_ANALYSIS",
        timestamp
      )
    ).toThrow(InvalidStepTransitionError);
    expect(() =>
      engine.transition(
        "step-gate-run",
        "first-step",
        "STEP_READY",
        "STEP_IMPLEMENTATION",
        timestamp
      )
    ).toThrow(/Invalid step transition/);

    const states = stepExecutionStates();
    engine.transition(
      "step-gate-run",
      "first-step",
      "STEP_READY",
      "STEP_CONTEXT_ANALYSIS",
      timestamp
    );
    expect(() =>
      engine.transition(
        "step-gate-run",
        "first-step",
        "STEP_READY",
        "STEP_CONTEXT_ANALYSIS",
        timestamp
      )
    ).toThrow(/Expected first-step to be STEP_READY, found STEP_CONTEXT_ANALYSIS/);
    for (let index = 1; index < states.length - 2; index += 1) {
      engine.transition(
        "step-gate-run",
        "first-step",
        states[index]!,
        states[index + 1]!,
        timestamp
      );
    }
    const awaitingCompletion = engine.snapshot("step-gate-run").gates[0]!;
    expect(awaitingCompletion.state).toBe("STEP_PULL_REQUEST_UPDATE");
    expect(() =>
      engine.transition(
        "step-gate-run",
        "first-step",
        "STEP_PULL_REQUEST_UPDATE",
        "STEP_COMPLETE",
        timestamp
      )
    ).toThrow(/completion gate/i);

    plans.saveEvidence({
      id: "completion-evidence",
      runId: "step-gate-run",
      stepId: "first-step",
      kind: "completion-gate",
      locator: "steps/001-first-step/completion-gate.json",
      contentHash: null,
      summary: "Every applicable completion criterion has evidence.",
      payload: {},
      createdAt: timestamp
    });
    plans.saveGate(completed(awaitingCompletion));
    const complete = engine.transition(
      "step-gate-run",
      "first-step",
      "STEP_PULL_REQUEST_UPDATE",
      "STEP_COMPLETE",
      timestamp
    );
    expect(complete.gates.map((gate) => gate.state)).toEqual(["STEP_COMPLETE", "STEP_READY"]);
    expect(complete.activeStep?.id).toBe("second-step");
    expect(() =>
      engine.transition(
        "step-gate-run",
        "second-step",
        "STEP_LOCKED",
        "STEP_CONTEXT_ANALYSIS",
        timestamp
      )
    ).toThrow(/Expected second-step to be STEP_LOCKED, found STEP_READY/);
    database.close();
  });

  it("permits the bounded runtime correction loop without allowing a skipped validation", () => {
    expect(canTransitionStep("STEP_RUNTIME_INTERACTION", "STEP_RUNTIME_ERROR_ANALYSIS")).toBe(true);
    expect(canTransitionStep("STEP_RUNTIME_ERROR_ANALYSIS", "STEP_RUNTIME_CORRECTION")).toBe(true);
    expect(canTransitionStep("STEP_RUNTIME_CORRECTION", "STEP_AUTOMATED_TEST_CREATION")).toBe(true);
    expect(canTransitionStep("STEP_FOCUSED_VALIDATION", "STEP_RUNTIME_RETEST")).toBe(true);
    expect(canTransitionStep("STEP_RUNTIME_RETEST", "STEP_RUNTIME_INTERACTION")).toBe(true);
    expect(canTransitionStep("STEP_IMPLEMENTATION", "STEP_FOCUSED_VALIDATION")).toBe(false);
    expect(canTransitionStep("STEP_RESTART", "STEP_DIFF_REVIEW")).toBe(false);
  });
});
