import { InvalidTransitionError, WorkflowStateMachine } from "@agent/core";

describe("WorkflowStateMachine", () => {
  it("allows the complete required happy path", () => {
    const path = [
      "IDLE",
      "WORKSPACE_DISCOVERY",
      "REPOSITORY_ANALYSIS",
      "PROMPT_REVIEW",
      "PROMPT_REVISION",
      "AWAITING_APPROVAL",
      ...WorkflowStateMachine.executionStates()
    ] as const;
    for (let index = 0; index < path.length - 1; index++) {
      expect(WorkflowStateMachine.transition(path[index]!, path[index + 1]!)).toBe(path[index + 1]);
    }
  });

  it("supports questioning, rejection realignment, cancellation, blocking, and rollback", () => {
    expect(WorkflowStateMachine.canTransition("PROMPT_REVIEW", "QUESTIONING")).toBe(true);
    expect(WorkflowStateMachine.canTransition("AWAITING_APPROVAL", "QUESTIONING")).toBe(true);
    expect(WorkflowStateMachine.canTransition("IMPLEMENTING", "CANCELLED")).toBe(true);
    expect(WorkflowStateMachine.canTransition("CI_VALIDATION", "BLOCKED")).toBe(true);
    expect(WorkflowStateMachine.canTransition("PRODUCTION_SMOKE_TEST", "ROLLING_BACK")).toBe(true);
    expect(WorkflowStateMachine.canTransition("ROLLING_BACK", "BLOCKED")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(() => WorkflowStateMachine.transition("IDLE", "IMPLEMENTING")).toThrow(
      InvalidTransitionError
    );
    expect(() => WorkflowStateMachine.transition("AWAITING_APPROVAL", "IMPLEMENTING")).toThrow();
    expect(WorkflowStateMachine.nextExecutionState("REPORTING")).toBe("SUCCESS");
  });
});
