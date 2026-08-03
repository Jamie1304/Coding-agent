import {
  type ApprovedStepPlan,
  type PlanStep,
  type StepCompletionGate,
  type StepState
} from "@agent/shared";
import { assertStepMayStart, type StepPlanService } from "./step-plan.js";

const normalStepSequence: readonly StepState[] = [
  "STEP_READY",
  "STEP_CONTEXT_ANALYSIS",
  "STEP_IMPLEMENTATION",
  "STEP_AUTOMATED_TEST_CREATION",
  "STEP_FOCUSED_VALIDATION",
  "STEP_RUNTIME_START",
  "STEP_RUNTIME_INTERACTION",
  "STEP_RESTART",
  "STEP_POST_RESTART_VALIDATION",
  "STEP_FULL_AFFECTED_VALIDATION",
  "STEP_DIFF_REVIEW",
  "STEP_INDEPENDENT_REVIEW",
  "STEP_DOCUMENTATION_UPDATE",
  "STEP_PROJECT_KNOWLEDGE_UPDATE",
  "STEP_GIT_COMMIT",
  "STEP_GIT_PUSH",
  "STEP_PULL_REQUEST_UPDATE",
  "STEP_COMPLETE"
];

const runtimeErrorOrigins = new Set<StepState>([
  "STEP_RUNTIME_START",
  "STEP_RUNTIME_INTERACTION",
  "STEP_RUNTIME_RETEST",
  "STEP_RESTART",
  "STEP_POST_RESTART_VALIDATION"
]);

export interface StepExecutionSnapshot {
  plan: ApprovedStepPlan;
  gates: StepCompletionGate[];
  activeStep: PlanStep | null;
}

export class InvalidStepTransitionError extends Error {}

export function stepExecutionStates(): readonly StepState[] {
  return normalStepSequence;
}

export function canTransitionStep(from: StepState, to: StepState): boolean {
  if (from === "STEP_COMPLETE" || from === "STEP_BLOCKED" || from === "STEP_LOCKED") {
    return false;
  }
  if (to === "STEP_BLOCKED") return true;
  if (runtimeErrorOrigins.has(from) && to === "STEP_RUNTIME_ERROR_ANALYSIS") return true;
  if (from === "STEP_RUNTIME_ERROR_ANALYSIS" && to === "STEP_RUNTIME_CORRECTION") return true;
  if (from === "STEP_RUNTIME_CORRECTION" && to === "STEP_AUTOMATED_TEST_CREATION") return true;
  if (from === "STEP_FOCUSED_VALIDATION" && to === "STEP_RUNTIME_RETEST") return true;
  if (from === "STEP_RUNTIME_RETEST" && to === "STEP_RUNTIME_INTERACTION") return true;
  const index = normalStepSequence.indexOf(from);
  return index >= 0 && normalStepSequence[index + 1] === to;
}

export class StepGateEngine {
  constructor(private readonly plans: StepPlanService) {}

  snapshot(runId: string): StepExecutionSnapshot {
    const plan = this.requirePlan(runId);
    const gates = this.plans.gates(runId);
    return {
      plan,
      gates,
      activeStep: this.firstIncompleteStep(plan, gates)
    };
  }

  transition(
    runId: string,
    stepId: string,
    expectedState: StepState,
    targetState: StepState,
    updatedAt = new Date().toISOString()
  ): StepExecutionSnapshot {
    const plan = this.requirePlan(runId);
    const gates = this.plans.gates(runId);
    const gate = gates.find((candidate) => candidate.stepId === stepId);
    if (!gate) throw new InvalidStepTransitionError(`Missing completion gate for step: ${stepId}`);
    const activeStep = this.firstIncompleteStep(plan, gates);
    if (!activeStep || activeStep.id !== stepId) {
      throw new InvalidStepTransitionError(
        `Only the first incomplete step is writable: ${activeStep?.id ?? "none"}`
      );
    }
    if (gate.state !== expectedState) {
      throw new InvalidStepTransitionError(
        `Expected ${stepId} to be ${expectedState}, found ${gate.state}`
      );
    }
    assertStepMayStart(plan, gates, stepId);
    if (!canTransitionStep(expectedState, targetState)) {
      throw new InvalidStepTransitionError(
        `Invalid step transition: ${expectedState} -> ${targetState}`
      );
    }
    this.plans.transitionGate({ ...gate, state: targetState, updatedAt }, expectedState);
    if (targetState === "STEP_COMPLETE") this.unlockNextStep(plan, stepId, updatedAt);
    return this.snapshot(runId);
  }

  recover(runId: string, updatedAt = new Date().toISOString()): StepExecutionSnapshot {
    const snapshot = this.snapshot(runId);
    if (!snapshot.activeStep) return snapshot;
    const gate = snapshot.gates.find((candidate) => candidate.stepId === snapshot.activeStep?.id);
    if (!gate) throw new InvalidStepTransitionError("Active step is missing its completion gate");
    if (gate.state === "STEP_LOCKED") {
      this.plans.transitionGate({ ...gate, state: "STEP_READY", updatedAt }, "STEP_LOCKED");
      return this.snapshot(runId);
    }
    return snapshot;
  }

  private unlockNextStep(plan: ApprovedStepPlan, completedStepId: string, updatedAt: string): void {
    const completedStep = plan.steps.find((step) => step.id === completedStepId);
    if (!completedStep) {
      throw new InvalidStepTransitionError(
        `Completed step is not in the frozen plan: ${completedStepId}`
      );
    }
    const nextStep = [...plan.steps]
      .sort((left, right) => left.order - right.order)
      .find((step) => step.order === completedStep.order + 1);
    if (!nextStep) return;
    const nextGate = this.plans.gates(plan.runId).find((gate) => gate.stepId === nextStep.id);
    if (!nextGate) throw new InvalidStepTransitionError(`Next step is missing its completion gate`);
    if (nextGate.state !== "STEP_LOCKED") {
      throw new InvalidStepTransitionError(`Next step is not locked: ${nextStep.id}`);
    }
    this.plans.transitionGate({ ...nextGate, state: "STEP_READY", updatedAt }, "STEP_LOCKED");
  }

  private firstIncompleteStep(
    plan: ApprovedStepPlan,
    gates: StepCompletionGate[]
  ): PlanStep | null {
    const gatesByStep = new Map(gates.map((gate) => [gate.stepId, gate]));
    return (
      [...plan.steps]
        .sort((left, right) => left.order - right.order)
        .find((step) => gatesByStep.get(step.id)?.state !== "STEP_COMPLETE") ?? null
    );
  }

  private requirePlan(runId: string): ApprovedStepPlan {
    const plan = this.plans.plan(runId);
    if (!plan) throw new InvalidStepTransitionError(`No frozen step plan exists for run: ${runId}`);
    return plan;
  }
}
