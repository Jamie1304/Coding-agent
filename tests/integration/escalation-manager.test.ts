import { describe, it, expect, beforeEach } from "vitest";
import {
  EscalationManager,
  requiresReleaseApproval,
  getReleaseGateConfig,
  type EscalationContext
} from "@agent/core";
import type { RoutingStrategy, TaskDescriptor } from "@agent/shared";
import type { DiscoveredModel } from "@agent/ai";

describe("Escalation Manager - Error Handling and Review", () => {
  let manager: EscalationManager;

  beforeEach(() => {
    manager = new EscalationManager();
  });

  function createTestStrategy(): RoutingStrategy {
    return {
      id: "test-strategy",
      name: "Test",
      description: "Test",
      version: 1,
      status: "active",
      scope: "global",
      projectPathReference: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activatedAt: new Date().toISOString(),
      archivedAt: null,
      createdBy: "user",
      basedOnStrategyId: null,
      generationMetadata: null,
      objective: {
        profile: "balanced",
        costWeight: 2,
        qualityWeight: 4,
        reliabilityWeight: 2,
        latencyWeight: 1,
        privacyWeight: 2
      },
      budgets: {},
      contextPolicy: {},
      retryPolicy: {},
      parallelPolicy: {},
      privacyPolicy: {},
      verificationPolicy: {},
      releasePolicy: { enabled: true, approverRole: "release_manager" },
      roles: {},
      escalationRules: []
    };
  }

  function createTestModel(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
    return {
      providerId: "anthropic",
      modelId: "claude-sonnet",
      displayName: "Claude 3.5 Sonnet",
      available: true,
      enabled: true,
      local: false,
      supportsStreaming: true,
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      supportsCaching: true,
      supportsTokenCounting: true,
      supportsRepositoryWrite: false,
      contextWindow: 200000,
      maxOutputTokens: 4096,
      roles: ["primary_coder"],
      weaknesses: [],
      inputPricePerMillion: 3.0,
      outputPricePerMillion: 15.0,
      cachedInputPricePerMillion: 0.3,
      maximumConcurrency: 5,
      defaultTimeoutMs: 120000,
      maximumTaskCost: 10.0,
      metadataSource: "official_preset",
      metadata: {},
      lastTestedAt: new Date().toISOString(),
      averageLatencyMs: 2500,
      historicalSuccessRate: 0.98,
      notes: "Test model",
      ...overrides
    };
  }

  function createEscalationContext(overrides: Partial<EscalationContext> = {}): EscalationContext {
    return {
      taskId: "task-1",
      runId: "run-1",
      model: createTestModel(),
      errorType: "repeated_error",
      errorCount: 1,
      cost: 0.5,
      budget: 10.0,
      risk: "low",
      ...overrides
    };
  }

  describe("Escalation triggers", () => {
    it("should escalate on high error count", () => {
      const strategy = createTestStrategy();
      const context = createEscalationContext({ errorCount: 5 });

      const result = manager.shouldEscalate(context, strategy);

      expect(result.shouldEscalate).toBe(true);
      expect(result.reason).toContain("Error count");
    });

    it("should escalate on budget exceeded", () => {
      const strategy = createTestStrategy();
      const context = createEscalationContext({ cost: 15.0, budget: 10.0 });

      const result = manager.shouldEscalate(context, strategy);

      expect(result.shouldEscalate).toBe(true);
      expect(result.reason).toContain("exceeds budget");
    });

    it("should escalate on high-risk task with repeated errors", () => {
      const strategy = createTestStrategy();
      const context = createEscalationContext({ risk: "high", errorCount: 2 });

      const result = manager.shouldEscalate(context, strategy);

      expect(result.shouldEscalate).toBe(true);
      expect(result.reason).toContain("High risk");
    });

    it("should escalate on permission denied", () => {
      const strategy = createTestStrategy();
      const context = createEscalationContext({ errorType: "permission_denied" });

      const result = manager.shouldEscalate(context, strategy);

      expect(result.shouldEscalate).toBe(true);
      expect(result.reason).toContain("Permission");
    });

    it("should not escalate on single error with sufficient budget", () => {
      const strategy = createTestStrategy();
      const context = createEscalationContext({
        errorCount: 1,
        cost: 0.5,
        budget: 10.0,
        risk: "low"
      });

      const result = manager.shouldEscalate(context, strategy);

      expect(result.shouldEscalate).toBe(false);
    });
  });

  describe("Review request and approval", () => {
    it("should request review with selected reviewers", () => {
      const strategy = createTestStrategy();
      const context = createEscalationContext({ risk: "high" });

      const review = manager.requestReview("esc-1", context, strategy, "High risk escalation");

      expect(review).not.toBeNull();
      expect(review.requiresReview).toBe(true);
      expect(review.reviewers.length).toBeGreaterThan(0);
    });

    it("should track escalation in queue", () => {
      const strategy = createTestStrategy();
      const context = createEscalationContext();

      manager.requestReview("esc-1", context, strategy, "Test escalation");

      const status = manager.getEscalationStatus("esc-1");
      expect(status.isPending).toBe(true);
      expect(status.context).toEqual(context);
    });

    it("should approve review by authorized reviewer", () => {
      const strategy = createTestStrategy();
      const context = createEscalationContext({ risk: "high" });

      const review = manager.requestReview("esc-1", context, strategy, "High risk");

      const approved = manager.approveReview("esc-1", review.reviewers[0]);

      expect(approved).toBe(true);

      const status = manager.getEscalationStatus("esc-1");
      expect(status.isPending).toBe(false);
    });

    it("should reject review by unauthorized reviewer", () => {
      const strategy = createTestStrategy();
      const context = createEscalationContext();

      manager.requestReview("esc-1", context, strategy, "Test");

      const approved = manager.approveReview("esc-1", "unauthorized_reviewer");

      expect(approved).toBe(false);
    });

    it("should handle review rejection", () => {
      const strategy = createTestStrategy();
      const context = createEscalationContext();

      const review = manager.requestReview("esc-1", context, strategy, "Test");

      const rejected = manager.rejectReview("esc-1", review.reviewers[0], "Not approved");

      expect(rejected).toBe(true);

      const status = manager.getEscalationStatus("esc-1");
      expect(status.isPending).toBe(false);
    });
  });

  describe("Review queue management", () => {
    it("should list pending reviews", () => {
      const strategy = createTestStrategy();
      const context1 = createEscalationContext({ taskId: "task-1", risk: "high" });
      const context2 = createEscalationContext({ taskId: "task-2", risk: "low" });

      manager.requestReview("esc-1", context1, strategy, "Review 1");
      manager.requestReview("esc-2", context2, strategy, "Review 2");

      const pending = manager.getPendingReviews();

      expect(pending).toHaveLength(2);
      expect(pending[0].escalationId).toBe("esc-1");
      expect(pending[1].escalationId).toBe("esc-2");
    });

    it("should filter completed reviews from pending list", () => {
      const strategy = createTestStrategy();
      const context1 = createEscalationContext({ risk: "high" });
      const context2 = createEscalationContext({ risk: "low" });

      const review1 = manager.requestReview("esc-1", context1, strategy, "Review 1");
      manager.requestReview("esc-2", context2, strategy, "Review 2");

      manager.approveReview("esc-1", review1.reviewers[0]);

      const pending = manager.getPendingReviews();

      expect(pending).toHaveLength(1);
      expect(pending[0].escalationId).toBe("esc-2");
    });

    it("should record escalation even without review", () => {
      const context = createEscalationContext();

      manager.recordEscalation("esc-1", context, "Manual escalation");

      const status = manager.getEscalationStatus("esc-1");
      expect(status.isEscalated).toBe(true);
      expect(status.context).toEqual(context);
    });
  });

  describe("Escalation status tracking", () => {
    it("should report escalation status correctly", () => {
      const strategy = createTestStrategy();
      const context = createEscalationContext();

      const review = manager.requestReview("esc-1", context, strategy, "Test");

      const status = manager.getEscalationStatus("esc-1");

      expect(status.isEscalated).toBe(true);
      expect(status.isPending).toBe(true);
      expect(status.context).toEqual(context);
      expect(status.review).toEqual(review);
    });

    it("should return empty status for non-existent escalation", () => {
      const status = manager.getEscalationStatus("non-existent");

      expect(status.isEscalated).toBe(false);
      expect(status.isPending).toBe(false);
      expect(status.context).toBeUndefined();
    });
  });

  describe("Release approval", () => {
    it("should require approval for repository writes", () => {
      const strategy = createTestStrategy();
      const task: TaskDescriptor = {
        id: "task-1",
        runId: "run-1",
        title: "Write to repo",
        description: "Write",
        role: "primary_coder",
        expectedInputTokens: 10000,
        expectedOutputTokens: 2000,
        requiredTools: false,
        requiredVision: false,
        repositoryWrite: true,
        sensitive: false,
        likelyFiles: [],
        dependencies: [],
        risk: "low"
      };

      const requires = requiresReleaseApproval(strategy, task, createTestModel());

      expect(requires).toBe(true);
    });

    it("should require approval for high-risk tasks", () => {
      const strategy = createTestStrategy();
      const task: TaskDescriptor = {
        id: "task-1",
        runId: "run-1",
        title: "High risk task",
        description: "Risk",
        role: "primary_coder",
        expectedInputTokens: 10000,
        expectedOutputTokens: 2000,
        requiredTools: false,
        requiredVision: false,
        repositoryWrite: false,
        sensitive: false,
        likelyFiles: [],
        dependencies: [],
        risk: "high"
      };

      const requires = requiresReleaseApproval(strategy, task, createTestModel());

      expect(requires).toBe(true);
    });

    it("should require approval for sensitive tasks", () => {
      const strategy = createTestStrategy();
      const task: TaskDescriptor = {
        id: "task-1",
        runId: "run-1",
        title: "Sensitive task",
        description: "Sensitive",
        role: "primary_coder",
        expectedInputTokens: 10000,
        expectedOutputTokens: 2000,
        requiredTools: false,
        requiredVision: false,
        repositoryWrite: false,
        sensitive: true,
        likelyFiles: [],
        dependencies: [],
        risk: "low"
      };

      const requires = requiresReleaseApproval(strategy, task, createTestModel());

      expect(requires).toBe(true);
    });

    it("should not require approval for low-risk read-only tasks", () => {
      const strategy = createTestStrategy();
      const task: TaskDescriptor = {
        id: "task-1",
        runId: "run-1",
        title: "Safe task",
        description: "Safe",
        role: "primary_coder",
        expectedInputTokens: 10000,
        expectedOutputTokens: 2000,
        requiredTools: false,
        requiredVision: false,
        repositoryWrite: false,
        sensitive: false,
        likelyFiles: [],
        dependencies: [],
        risk: "low"
      };

      const requires = requiresReleaseApproval(strategy, task, createTestModel());

      expect(requires).toBe(false);
    });
  });

  describe("Release gate configuration", () => {
    it("should return release gate config from strategy", () => {
      const strategy = createTestStrategy();

      const config = getReleaseGateConfig(strategy);

      expect(config.gateEnabled).toBe(true);
      expect(config.approverRole).toBe("release_manager");
      expect(config.timeoutMs).toBeGreaterThan(0);
    });

    it("should use defaults when release policy missing", () => {
      const strategy = createTestStrategy();
      strategy.releasePolicy = {};

      const config = getReleaseGateConfig(strategy);

      expect(config.gateEnabled).toBe(false);
      expect(config.approverRole).toBe("release_manager");
      expect(config.timeoutMs).toBe(600000);
    });
  });

  describe("Reviewer diversity", () => {
    it("should ensure multiple reviewers for high-risk escalations", () => {
      const strategy = createTestStrategy();
      const context = createEscalationContext({ risk: "high" });

      const review = manager.requestReview("esc-1", context, strategy, "High risk");

      // High-risk should have at least 2 reviewers for diversity
      expect(review.reviewers.length).toBeGreaterThanOrEqual(2);
    });

    it("should include security reviewer for high-risk", () => {
      const strategy = createTestStrategy();
      const context = createEscalationContext({ risk: "high" });

      const review = manager.requestReview("esc-1", context, strategy, "High risk");

      expect(review.reviewers).toContain("security_reviewer");
    });

    it("should require approval for high-risk decisions", () => {
      const strategy = createTestStrategy();
      const context = createEscalationContext({ risk: "high" });

      const review = manager.requestReview("esc-1", context, strategy, "High risk");

      expect(review.requiresApproval).toBe(true);
    });
  });

  describe("Clear and reset", () => {
    it("should clear all escalations and reviews", () => {
      const strategy = createTestStrategy();
      const context = createEscalationContext();

      manager.requestReview("esc-1", context, strategy, "Test");
      manager.recordEscalation("esc-2", context, "Test");

      manager.clear();

      let pending = manager.getPendingReviews();
      expect(pending).toHaveLength(0);

      const status1 = manager.getEscalationStatus("esc-1");
      const status2 = manager.getEscalationStatus("esc-2");

      expect(status1.isEscalated).toBe(false);
      expect(status2.isEscalated).toBe(false);
    });
  });
});
