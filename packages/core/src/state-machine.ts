import type { RunState } from "@agent/shared";

const alignmentTransitions: Partial<Record<RunState, RunState[]>> = {
  IDLE: ["WORKSPACE_DISCOVERY"],
  WORKSPACE_DISCOVERY: ["REPOSITORY_ANALYSIS", "BLOCKED", "CANCELLED"],
  REPOSITORY_ANALYSIS: ["PROMPT_REVIEW", "BLOCKED", "CANCELLED"],
  PROMPT_REVIEW: ["QUESTIONING", "CHANGE_REVIEW", "PROMPT_REVISION", "BLOCKED", "CANCELLED"],
  QUESTIONING: ["CHANGE_REVIEW", "PROMPT_REVISION", "CANCELLED"],
  CHANGE_REVIEW: ["QUESTIONING", "PROMPT_REVISION", "BLOCKED", "CANCELLED"],
  PROMPT_REVISION: ["AWAITING_APPROVAL", "QUESTIONING", "CHANGE_REVIEW", "CANCELLED"],
  AWAITING_APPROVAL: ["QUESTIONING", "PREFLIGHT", "CANCELLED"]
};

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
