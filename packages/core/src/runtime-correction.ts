import { randomUUID } from "node:crypto";
import type {
  RuntimeCorrectionAttempt,
  StepRuntimeError,
  StepTerminalOperation
} from "@agent/shared";
import { StepGateEngine } from "./step-gate.js";
import type { StepPlanService } from "./step-plan.js";
import { redactSecrets } from "./security.js";

export interface RuntimeCorrectionOptions {
  maximumAttempts?: number;
  now?: () => Date;
}

export type CorrectionDecision = "retry" | "independent_diagnosis" | "validation";

export class RuntimeCorrectionController {
  private readonly maximumAttempts: number;
  private readonly now: () => Date;

  constructor(
    private readonly plans: StepPlanService,
    private readonly gates = new StepGateEngine(plans),
    options: RuntimeCorrectionOptions = {}
  ) {
    this.maximumAttempts = options.maximumAttempts ?? 3;
    this.now = options.now ?? (() => new Date());
  }

  recordTerminalOperation(operation: StepTerminalOperation): StepRuntimeError[] {
    const errors = operation.errorsDetected.map(normalizeRuntimeError);
    for (const error of errors) this.plans.saveRuntimeError(error);
    if (errors.length > 0) this.pauseForRuntimeError(operation.runId, operation.stepId);
    return errors;
  }

  beginCorrection(runId: string, stepId: string): void {
    const gate = this.activeGate(runId, stepId);
    this.gates.transition(
      runId,
      stepId,
      gate.state,
      "STEP_RUNTIME_CORRECTION",
      this.now().toISOString()
    );
  }

  recordAttempt(input: {
    runId: string;
    stepId: string;
    errorSignature: string;
    hypothesis: string;
    outcome: RuntimeCorrectionAttempt["outcome"];
    notes: string;
    regressionEvidenceId?: string;
  }): CorrectionDecision {
    const errors = this.plans.runtimeErrors(input.runId, input.stepId);
    const error = errors.find((candidate) => candidate.signature === input.errorSignature);
    if (!error) throw new Error(`Runtime error not found: ${input.errorSignature}`);
    const previous = this.plans
      .runtimeCorrections(input.runId, input.stepId)
      .filter((attempt) => attempt.errorSignature === input.errorSignature);
    if (input.outcome === "resolved") this.requireRegressionEvidence(input);
    const attempt: RuntimeCorrectionAttempt = {
      id: randomUUID(),
      runId: input.runId,
      stepId: input.stepId,
      errorSignature: input.errorSignature,
      attempt: previous.length + 1,
      hypothesis: redactSecrets(input.hypothesis),
      outcome: input.outcome,
      notes: redactSecrets(input.notes),
      regressionEvidenceId: input.regressionEvidenceId ?? null,
      startedAt: this.now().toISOString(),
      completedAt: this.now().toISOString()
    };
    this.plans.saveRuntimeCorrection(attempt);
    if (input.outcome === "resolved") return this.resolve(error, attempt);
    if (attempt.attempt >= this.maximumAttempts) {
      this.plans.saveRuntimeError({
        ...error,
        status: "external",
        lastSeenAt: this.now().toISOString(),
        resolution: "Correction retry limit reached; independent diagnosis required."
      });
      const gate = this.activeGate(input.runId, input.stepId);
      this.gates.transition(
        input.runId,
        input.stepId,
        gate.state,
        "STEP_BLOCKED",
        this.now().toISOString()
      );
      return "independent_diagnosis";
    }
    return "retry";
  }

  private resolve(error: StepRuntimeError, attempt: RuntimeCorrectionAttempt): CorrectionDecision {
    const evidence = this.requireRegressionEvidence({
      runId: error.runId,
      stepId: error.stepId,
      ...(attempt.regressionEvidenceId
        ? { regressionEvidenceId: attempt.regressionEvidenceId }
        : {})
    });
    this.plans.saveRuntimeError({
      ...error,
      status: "resolved",
      lastSeenAt: this.now().toISOString(),
      resolution: `Resolved by correction attempt ${attempt.id}; regression evidence ${evidence.id}.`
    });
    const gate = this.activeGate(error.runId, error.stepId);
    this.gates.transition(
      error.runId,
      error.stepId,
      gate.state,
      "STEP_AUTOMATED_TEST_CREATION",
      this.now().toISOString()
    );
    return "validation";
  }

  private pauseForRuntimeError(runId: string, stepId: string): void {
    const gate = this.activeGate(runId, stepId);
    if (
      ![
        "STEP_RUNTIME_START",
        "STEP_RUNTIME_INTERACTION",
        "STEP_RUNTIME_RETEST",
        "STEP_RESTART",
        "STEP_POST_RESTART_VALIDATION"
      ].includes(gate.state)
    ) {
      throw new Error(`Runtime errors cannot pause step state ${gate.state}`);
    }
    this.gates.transition(
      runId,
      stepId,
      gate.state,
      "STEP_RUNTIME_ERROR_ANALYSIS",
      this.now().toISOString()
    );
  }

  private requireRegressionEvidence(input: {
    runId: string;
    stepId: string;
    regressionEvidenceId?: string;
  }) {
    if (!input.regressionEvidenceId) {
      throw new Error("Resolved runtime errors require focused regression evidence");
    }
    const evidence = this.plans
      .evidence(input.runId, input.stepId)
      .find((item) => item.id === input.regressionEvidenceId);
    if (!evidence) throw new Error("Focused regression evidence was not persisted");
    return evidence;
  }

  private activeGate(runId: string, stepId: string) {
    const snapshot = this.gates.snapshot(runId);
    if (snapshot.activeStep?.id !== stepId) {
      throw new Error(`Only the active step can record runtime correction: ${stepId}`);
    }
    const gate = snapshot.gates.find((candidate) => candidate.stepId === stepId);
    if (!gate) throw new Error(`Missing completion gate for step: ${stepId}`);
    return gate;
  }
}

function normalizeRuntimeError(error: StepRuntimeError): StepRuntimeError {
  return {
    ...error,
    signature: redactSecrets(error.signature),
    message: redactSecrets(error.message),
    source: redactSecrets(error.source),
    evidencePath: redactSecrets(error.evidencePath),
    resolution: redactSecrets(error.resolution)
  };
}
