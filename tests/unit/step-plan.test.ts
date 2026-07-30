import {
  ApprovedStepPlanSchema,
  StepEvidenceSchema,
  type ApprovedStepPlan,
  type StepCompletionGate
} from "@agent/shared";
import { assertStepMayStart, completionGatePassed, createPendingCompletionGate } from "@agent/core";

const timestamp = "2026-07-30T13:00:00.000Z";

function plan(): ApprovedStepPlan {
  return ApprovedStepPlanSchema.parse({
    version: 1,
    id: "phase-3",
    runId: "run-1",
    approvedRevision: 1,
    frozenAt: timestamp,
    createdAt: timestamp,
    steps: [
      {
        id: "step-one",
        order: 1,
        title: "Step one",
        objective: "Persist the approved plan.",
        reason: "All later steps depend on it.",
        acceptanceCriteria: [{ id: "one", description: "It persists." }]
      },
      {
        id: "step-two",
        order: 2,
        title: "Step two",
        objective: "Use the persisted plan.",
        reason: "Execution must be gated.",
        dependencies: ["step-one"],
        acceptanceCriteria: [{ id: "two", description: "It remains gated." }]
      }
    ]
  });
}

function complete(gate: StepCompletionGate): StepCompletionGate {
  return {
    ...gate,
    state: "COMPLETE",
    blockingRequirements: [],
    criteria: Object.fromEntries(
      Object.keys(gate.criteria).map((criterion) => [
        criterion,
        { applicable: true, passed: true, evidenceIds: [`evidence-${criterion}`] }
      ])
    ) as StepCompletionGate["criteria"]
  };
}

describe("approved step plan contracts", () => {
  it("rejects invalid order, missing acceptance criteria, and cyclic dependencies", () => {
    const invalidOrder = structuredClone(plan());
    invalidOrder.steps[1]!.order = 3;
    expect(ApprovedStepPlanSchema.safeParse(invalidOrder).success).toBe(false);

    const missingCriteria = structuredClone(plan());
    missingCriteria.steps[0]!.acceptanceCriteria = [];
    expect(ApprovedStepPlanSchema.safeParse(missingCriteria).success).toBe(false);

    const cycle = structuredClone(plan());
    cycle.steps[0]!.dependencies = ["step-two"];
    expect(ApprovedStepPlanSchema.safeParse(cycle).success).toBe(false);
  });

  it("requires evidence for applicable gate criteria and blocks later steps chronologically", () => {
    const approvedPlan = plan();
    const pending = createPendingCompletionGate("run-1", "step-one", timestamp);
    expect(approvedPlan.steps[0]?.completionEvidence).toEqual([]);
    expect(Object.keys(pending.criteria)).toEqual([
      "scopeAnalysis",
      "implementation",
      "acceptance",
      "requiredTests",
      "focusedTests",
      "runtimeStart",
      "runtimeInteraction",
      "runtimeErrorsResolved",
      "restart",
      "postRestartValidation",
      "fullAffectedValidation",
      "diffReview",
      "independentReview",
      "documentation",
      "projectKnowledge",
      "commit",
      "push",
      "pullRequest",
      "evidenceStored"
    ]);
    expect(completionGatePassed(pending)).toBe(false);
    expect(() => assertStepMayStart(approvedPlan, [pending], "step-two")).toThrow(
      /earlier steps are incomplete/i
    );

    const completed = complete(pending);
    expect(completionGatePassed(completed)).toBe(true);
    expect(assertStepMayStart(approvedPlan, [completed], "step-two").id).toBe("step-two");

    const notApplicable = structuredClone(completed);
    notApplicable.criteria.restart = {
      applicable: false,
      justification: "No executable behavior changed."
    };
    expect(completionGatePassed(notApplicable)).toBe(true);
  });

  it("rejects secret-like content from serialized evidence", () => {
    expect(
      StepEvidenceSchema.safeParse({
        id: "evidence-1",
        runId: "run-1",
        stepId: "step-one",
        kind: "terminal-operation",
        locator: "logs/operation.log",
        contentHash: null,
        summary: "Safe command output",
        payload: { token: "gho_abcdefghijklmnopqrstuvwxyz" },
        createdAt: timestamp
      }).success
    ).toBe(false);

    expect(
      StepEvidenceSchema.safeParse({
        id: "evidence-2",
        runId: "run-1",
        stepId: "step-one",
        kind: "terminal-operation",
        locator: "logs/operation.log",
        contentHash: null,
        summary: "Unsafe payload",
        payload: { callback: () => "not JSON" },
        createdAt: timestamp
      }).success
    ).toBe(false);
  });
});
