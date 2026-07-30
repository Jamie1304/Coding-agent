import type { AgentDatabase } from "@agent/database";
import {
  ApprovedStepPlanSchema,
  type ApprovedStepPlan,
  type GateCheck,
  type PlanStep,
  StepAmendmentSchema,
  StepCompletionGateSchema,
  type StepAmendment,
  type StepCompletionGate,
  StepEvidenceSchema,
  type StepEvidence,
  StepRuntimeErrorSchema,
  type StepRuntimeError,
  StepTerminalOperationSchema,
  type StepTerminalOperation,
  type StepState
} from "@agent/shared";
import { ReportGenerator } from "./reporting.js";

const gateCriteria = [
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
] as const;

export function createPendingCompletionGate(
  runId: string,
  stepId: string,
  state: StepState = "STEP_LOCKED",
  updatedAt = new Date().toISOString()
): StepCompletionGate {
  return StepCompletionGateSchema.parse({
    runId,
    stepId,
    state,
    criteria: Object.fromEntries(
      gateCriteria.map((criterion) => [
        criterion,
        { applicable: true, passed: false, evidenceIds: [] } satisfies GateCheck
      ])
    ),
    blockingRequirements: ["Completion gate has not yet been satisfied."],
    updatedAt
  });
}

export function completionGatePassed(gate: StepCompletionGate): boolean {
  return Object.values(gate.criteria).every(
    (check) => !check.applicable || (check.passed && check.evidenceIds.length > 0)
  );
}

export function assertStepMayStart(
  plan: ApprovedStepPlan,
  gates: StepCompletionGate[],
  stepId: string
): PlanStep {
  const parsedPlan = ApprovedStepPlanSchema.parse(plan);
  const step = parsedPlan.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`Unknown plan step: ${stepId}`);
  const gatesByStep = new Map(
    gates.map((gate) => [gate.stepId, StepCompletionGateSchema.parse(gate)])
  );
  const incomplete = parsedPlan.steps
    .filter((candidate) => candidate.order < step.order)
    .filter((candidate) => {
      const gate = gatesByStep.get(candidate.id);
      return !gate || gate.state !== "STEP_COMPLETE" || !completionGatePassed(gate);
    })
    .map((candidate) => candidate.id);
  if (incomplete.length) {
    throw new Error(
      `Cannot start ${stepId}; earlier steps are incomplete: ${incomplete.join(", ")}`
    );
  }
  return step;
}

export class StepPlanService {
  constructor(
    private readonly database: AgentDatabase,
    private readonly reports = new ReportGenerator()
  ) {}

  async initialize(plan: ApprovedStepPlan, workspacePath: string): Promise<ApprovedStepPlan> {
    const parsedPlan = ApprovedStepPlanSchema.parse(plan);
    const existingPlan = this.database.stepPlan(parsedPlan.runId);
    if (existingPlan) {
      if (JSON.stringify(existingPlan) !== JSON.stringify(parsedPlan)) {
        throw new Error(`Frozen step plan for run ${parsedPlan.runId} cannot be replaced`);
      }
      await this.reports.initializeStepPlan(workspacePath, existingPlan);
      const existingGates = new Map(
        this.database.stepCompletionGates(parsedPlan.runId).map((gate) => [gate.stepId, gate])
      );
      for (const step of existingPlan.steps) {
        const gate = existingGates.get(step.id);
        if (!gate) {
          throw new Error(`Frozen step plan is missing its completion gate: ${step.id}`);
        }
        await this.reports.initializeStepEvidence(workspacePath, parsedPlan.runId, step, gate);
      }
      return existingPlan;
    }

    this.database.saveStepPlan(parsedPlan);
    await this.reports.initializeStepPlan(workspacePath, parsedPlan);
    for (const [index, step] of parsedPlan.steps.entries()) {
      const state: StepState = index === 0 ? "STEP_READY" : "STEP_LOCKED";
      this.database.savePlanStep(parsedPlan.runId, step, state);
      const gate = createPendingCompletionGate(parsedPlan.runId, step.id, state, parsedPlan.createdAt);
      this.database.saveStepCompletionGate(gate);
      await this.reports.initializeStepEvidence(workspacePath, parsedPlan.runId, step, gate);
    }
    return parsedPlan;
  }

  plan(runId: string): ApprovedStepPlan | null {
    return this.database.stepPlan(runId);
  }

  gates(runId: string): StepCompletionGate[] {
    return this.database.stepCompletionGates(runId);
  }

  saveGate(gate: StepCompletionGate): void {
    const { parsed, planStep } = this.validateGate(gate);
    this.database.saveStepCompletionGate(parsed);
    this.database.savePlanStep(parsed.runId, planStep, parsed.state);
  }

  transitionGate(
    gate: StepCompletionGate,
    expectedState: StepCompletionGate["state"]
  ): void {
    const { parsed } = this.validateGate(gate);
    if (!this.database.transitionStepCompletionGate(parsed, expectedState)) {
      throw new Error(
        `Step gate transition rejected because the persisted state is not ${expectedState}`
      );
    }
  }

  private validateGate(gate: StepCompletionGate): {
    parsed: StepCompletionGate;
    planStep: PlanStep;
  } {
    const parsed = StepCompletionGateSchema.parse(gate);
    const planStep = this.database
      .planSteps(parsed.runId)
      .find((candidate) => candidate.step.id === parsed.stepId)?.step;
    if (!planStep) {
      throw new Error(`Cannot save a gate for an unknown plan step: ${parsed.stepId}`);
    }
    if (parsed.state === "STEP_COMPLETE" && !completionGatePassed(parsed)) {
      throw new Error(
        "A completion gate cannot be complete until every applicable criterion passes with evidence"
      );
    }
    if (parsed.state === "STEP_COMPLETE") {
      const evidenceIds = new Set(
        this.database.stepEvidence(parsed.runId, parsed.stepId).map((evidence) => evidence.id)
      );
      const missingEvidence = Object.values(parsed.criteria)
        .flatMap((criterion) => (criterion.applicable ? criterion.evidenceIds : []))
        .filter((evidenceId) => !evidenceIds.has(evidenceId));
      if (missingEvidence.length) {
        throw new Error(
          `A completion gate requires persisted evidence: ${[...new Set(missingEvidence)].join(", ")}`
        );
      }
      const plan = this.database.stepPlan(parsed.runId);
      if (!plan) throw new Error(`Cannot complete a gate without its frozen plan: ${parsed.runId}`);
      assertStepMayStart(plan, this.gates(parsed.runId), parsed.stepId);
    }
    return { parsed, planStep };
  }

  saveAmendment(amendment: StepAmendment): void {
    this.database.saveStepAmendment(StepAmendmentSchema.parse(amendment));
  }

  saveEvidence(evidence: StepEvidence): void {
    this.database.saveStepEvidence(StepEvidenceSchema.parse(evidence));
  }

  saveTerminalOperation(operation: StepTerminalOperation): void {
    this.database.saveStepTerminalOperation(StepTerminalOperationSchema.parse(operation));
  }

  saveRuntimeError(error: StepRuntimeError): void {
    this.database.saveStepRuntimeError(StepRuntimeErrorSchema.parse(error));
  }
}
