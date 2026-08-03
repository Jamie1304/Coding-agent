import type { RunState } from "@agent/shared";

const alignmentTransitions: Partial<Record<RunState, RunState[]>> = {
  IDLE: ["WORKSPACE_DISCOVERY"],
  RUN_CREATED: ["REPOSITORY_DISCOVERY", "BLOCKED", "CANCELLED"],
  WORKSPACE_DISCOVERY: ["REPOSITORY_ANALYSIS", "BLOCKED", "CANCELLED"],
  REPOSITORY_ANALYSIS: ["PROMPT_REVIEW", "BLOCKED", "CANCELLED"],
  PROMPT_REVIEW: ["QUESTIONING", "PROMPT_REVISION", "BLOCKED", "CANCELLED"],
  QUESTIONING: ["PROMPT_REVISION", "CANCELLED"],
  PROMPT_REVISION: ["AWAITING_APPROVAL", "QUESTIONING", "CANCELLED"],
  AWAITING_APPROVAL: ["QUESTIONING", "PREFLIGHT", "CANCELLED"]
};

const stepGatedTopLevelSequence: readonly RunState[] = [
  "RUN_CREATED",
  "REPOSITORY_DISCOVERY",
  "PROMPT_REVIEW",
  "QUESTIONING",
  "PROMPT_REVISION",
  "STEP_PLAN_GENERATION",
  "AWAITING_STEP_PLAN_APPROVAL",
  "GITHUB_PREFLIGHT",
  "ISSUE_CREATION",
  "BRANCH_CREATION",
  "PULL_REQUEST_DRAFT_CREATION",
  "PROJECT_KNOWLEDGE_BASELINE",
  "EXECUTING_STEPS",
  "FINAL_FULL_VALIDATION",
  "FINAL_INDEPENDENT_REVIEW",
  "FINAL_DOCUMENTATION",
  "VERSIONING",
  "STAGING_DEPLOYMENT",
  "STAGING_VALIDATION",
  "MERGE",
  "PRODUCTION_DEPLOYMENT",
  "PRODUCTION_VALIDATION",
  "RELEASE",
  "FINAL_REPORTING",
  "SUCCESS"
];

const executionSequence: RunState[] = [
  "PREFLIGHT",
  "ISSUE_CREATION",
  "ACCEPTANCE_CRITERIA",
  "WORKTREE_CREATION",
  "BRANCH_CREATION",
  "IMPLEMENTATION_PLANNING",
  "IMPLEMENTING",
  "FOCUSED_TESTING",
  "FULL_VALIDATION",
  "DIFF_REVIEW",
  "INDEPENDENT_REVIEW",
  "COMMITTING",
  "PUSHING",
  "PULL_REQUEST_CREATION",
  "CI_VALIDATION",
  "SECURITY_REVIEW",
  "BEHAVIOR_VALIDATION",
  "STAGING_DEPLOYMENT",
  "STAGING_SMOKE_TEST",
  "MERGING",
  "PRODUCTION_DEPLOYMENT",
  "PRODUCTION_SMOKE_TEST",
  "VERSIONING",
  "RELEASE",
  "MONITORING",
  "REPORTING",
  "SUCCESS"
];

const transitions = new Map<RunState, Set<RunState>>();
for (const [from, to] of Object.entries(alignmentTransitions)) {
  transitions.set(from as RunState, new Set(to));
}
for (let index = 0; index < executionSequence.length - 1; index++) {
  const from = executionSequence[index]!;
  const next = executionSequence[index + 1]!;
  const allowed = transitions.get(from) ?? new Set<RunState>();
  allowed.add(next);
  allowed.add("BLOCKED");
  allowed.add("FAILED");
  allowed.add("CANCELLED");
  if (from === "PRODUCTION_SMOKE_TEST") allowed.add("ROLLING_BACK");
  transitions.set(from, allowed);
}
transitions.set("ROLLING_BACK", new Set(["BLOCKED", "FAILED", "REPORTING"]));
transitions.set("BLOCKED", new Set(["PREFLIGHT", "CANCELLED"]));

export class InvalidTransitionError extends Error {}

export class StepGatedWorkflowStateMachine {
  static canTransition(from: RunState, to: RunState): boolean {
    if (from === "QUESTIONING") return to === "PROMPT_REVISION" || to === "CANCELLED";
    if (from === "PROMPT_REVISION") {
      return to === "STEP_PLAN_GENERATION" || to === "QUESTIONING" || to === "CANCELLED";
    }
    if (from === "STEP_PLAN_GENERATION") {
      return to === "AWAITING_STEP_PLAN_APPROVAL" || to === "QUESTIONING" || to === "CANCELLED";
    }
    if (from === "AWAITING_STEP_PLAN_APPROVAL") {
      return to === "GITHUB_PREFLIGHT" || to === "STEP_PLAN_GENERATION" || to === "CANCELLED";
    }
    if (from === "PRODUCTION_VALIDATION" && to === "ROLLING_BACK") return true;
    if (from === "ROLLING_BACK") return ["BLOCKED", "FAILED", "FINAL_REPORTING"].includes(to);
    if (from === "BLOCKED") return ["GITHUB_PREFLIGHT", "CANCELLED"].includes(to);
    if (["SUCCESS", "FAILED", "CANCELLED"].includes(from)) return false;
    const index = stepGatedTopLevelSequence.indexOf(from);
    return (
      index >= 0 &&
      (to === stepGatedTopLevelSequence[index + 1] ||
        ["BLOCKED", "FAILED", "CANCELLED"].includes(to))
    );
  }

  static transition(from: RunState, to: RunState): RunState {
    if (!this.canTransition(from, to)) {
      throw new InvalidTransitionError(`Invalid step-gated workflow transition: ${from} -> ${to}`);
    }
    return to;
  }

  static executionStates(): readonly RunState[] {
    return stepGatedTopLevelSequence;
  }
}

export class WorkflowStateMachine {
  static canTransition(from: RunState, to: RunState): boolean {
    return transitions.get(from)?.has(to) ?? false;
  }

  static transition(from: RunState, to: RunState): RunState {
    if (!this.canTransition(from, to)) {
      throw new InvalidTransitionError(`Invalid workflow transition: ${from} -> ${to}`);
    }
    return to;
  }

  static nextExecutionState(state: RunState): RunState | null {
    const index = executionSequence.indexOf(state);
    return index >= 0 && index < executionSequence.length - 1
      ? executionSequence[index + 1]!
      : null;
  }

  static executionStates(): readonly RunState[] {
    return executionSequence;
  }
}
