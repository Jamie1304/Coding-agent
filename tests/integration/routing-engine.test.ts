import { describe, it, expect, beforeEach } from "vitest";
import { RoutingEngine, type RoutingContext } from "@agent/core";
import type { RoutingStrategy, TaskDescriptor } from "@agent/shared";
import type { DiscoveredModel } from "@agent/ai";

describe("Routing Engine - Deterministic Model Selection", () => {
  let engine: RoutingEngine;

  beforeEach(() => {
    engine = new RoutingEngine();
  });

  function createTestStrategy(overrides: Partial<RoutingStrategy> = {}): RoutingStrategy {
    return {
      id: "test-strategy",
      name: "Test Strategy",
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
      releasePolicy: {},
      roles: {},
      escalationRules: [],
      ...overrides
    };
  }

  function createTestTask(overrides: Partial<TaskDescriptor> = {}): TaskDescriptor {
    return {
      id: "task-1",
      runId: "run-1",
      title: "Test Task",
      description: "Test task description",
      role: "primary_coder",
      expectedInputTokens: 10000,
      expectedOutputTokens: 2000,
      requiredTools: false,
      requiredVision: false,
      repositoryWrite: false,
      sensitive: false,
      likelyFiles: [],
      dependencies: [],
      risk: "low",
      ...overrides
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
      roles: ["primary_coder", "reviewer"],
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
      notes: "High quality model",
      ...overrides
    };
  }

  describe("Hard filters", () => {
    it("should filter out unavailable or disabled models", () => {
      const strategy = createTestStrategy();
      const task = createTestTask();
      const models = [
        createTestModel({ modelId: "model-1", available: true, enabled: true }),
        createTestModel({ modelId: "model-2", available: false, enabled: true }),
        createTestModel({ modelId: "model-3", available: true, enabled: false })
      ];

      const result = engine.route({
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 100
      });

      expect(result.selected.modelId).toBe("model-1");
    });

    it("should filter repository write requirement", () => {
      const strategy = createTestStrategy();
      const task = createTestTask({ repositoryWrite: true });
      const models = [
        createTestModel({
          modelId: "can-write",
          supportsRepositoryWrite: true
        }),
        createTestModel({
          modelId: "cannot-write",
          supportsRepositoryWrite: false
        })
      ];

      const result = engine.route({
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 100
      });

      expect(result.selected.modelId).toBe("can-write");
    });

    it("should filter tools requirement", () => {
      const strategy = createTestStrategy();
      const task = createTestTask({ requiredTools: true });
      const models = [
        createTestModel({ modelId: "has-tools", supportsTools: true }),
        createTestModel({ modelId: "no-tools", supportsTools: false })
      ];

      const result = engine.route({
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 100
      });

      expect(result.selected.modelId).toBe("has-tools");
    });

    it("should filter vision requirement", () => {
      const strategy = createTestStrategy();
      const task = createTestTask({ requiredVision: true });
      const models = [
        createTestModel({ modelId: "has-vision", supportsVision: true }),
        createTestModel({ modelId: "no-vision", supportsVision: false })
      ];

      const result = engine.route({
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 100
      });

      expect(result.selected.modelId).toBe("has-vision");
    });

    it("should filter budget constraint", () => {
      const strategy = createTestStrategy();
      const task = createTestTask({ expectedInputTokens: 100000, expectedOutputTokens: 10000 });
      const models = [
        createTestModel({
          modelId: "cheap",
          inputPricePerMillion: 0.5,
          outputPricePerMillion: 1.0
        }),
        createTestModel({
          modelId: "expensive",
          inputPricePerMillion: 50.0,
          outputPricePerMillion: 100.0
        })
      ];

      // Only $0.20 budget
      const result = engine.route({
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 0.2
      });

      expect(result.selected.modelId).toBe("cheap");
    });

    it("should filter privacy constraint", () => {
      const strategy = createTestStrategy({
        privacyPolicy: { minimumPrivacyLevel: "local-only" }
      });
      const task = createTestTask({ sensitive: true });
      const models = [
        createTestModel({ modelId: "local-model", local: true }),
        createTestModel({ modelId: "cloud-model", local: false })
      ];

      const result = engine.route({
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 100
      });

      expect(result.selected.modelId).toBe("local-model");
    });
  });

  describe("Scoring and ranking", () => {
    it("should score by capability match", () => {
      const strategy = createTestStrategy({
        objective: {
          profile: "balanced",
          costWeight: 1,
          qualityWeight: 10,
          reliabilityWeight: 1,
          latencyWeight: 1,
          privacyWeight: 1
        }
      });
      const task = createTestTask({ role: "primary_coder" });
      const models = [
        createTestModel({
          modelId: "matching",
          roles: ["primary_coder"]
        }),
        createTestModel({
          modelId: "non-matching",
          roles: ["reviewer"]
        })
      ];

      const result = engine.route({
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 100
      });

      expect(result.selected.modelId).toBe("matching");
    });

    it("should score by cost efficiency", () => {
      const strategy = createTestStrategy({
        objective: {
          profile: "balanced",
          costWeight: 10,
          qualityWeight: 1,
          reliabilityWeight: 1,
          latencyWeight: 1,
          privacyWeight: 1
        }
      });
      const task = createTestTask();
      const models = [
        createTestModel({
          modelId: "cheap",
          inputPricePerMillion: 1.0,
          outputPricePerMillion: 5.0
        }),
        createTestModel({
          modelId: "expensive",
          inputPricePerMillion: 50.0,
          outputPricePerMillion: 100.0
        })
      ];

      const result = engine.route({
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 100
      });

      expect(result.selected.modelId).toBe("cheap");
    });

    it("should score by reliability (success rate)", () => {
      const strategy = createTestStrategy({
        objective: {
          profile: "balanced",
          costWeight: 1,
          qualityWeight: 1,
          reliabilityWeight: 10,
          latencyWeight: 1,
          privacyWeight: 1
        }
      });
      const task = createTestTask();
      const models = [
        createTestModel({ modelId: "reliable", historicalSuccessRate: 0.99 }),
        createTestModel({ modelId: "flaky", historicalSuccessRate: 0.70 })
      ];

      const result = engine.route({
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 100
      });

      expect(result.selected.modelId).toBe("reliable");
    });

    it("should score by latency", () => {
      const strategy = createTestStrategy({
        objective: {
          profile: "balanced",
          costWeight: 1,
          qualityWeight: 1,
          reliabilityWeight: 1,
          latencyWeight: 10,
          privacyWeight: 1
        }
      });
      const task = createTestTask();
      const models = [
        createTestModel({ modelId: "fast", averageLatencyMs: 500 }),
        createTestModel({ modelId: "slow", averageLatencyMs: 15000 })
      ];

      const result = engine.route({
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 100
      });

      expect(result.selected.modelId).toBe("fast");
    });
  });

  describe("Deterministic tie-breaking", () => {
    it("should break ties by provider ID then model ID", () => {
      const strategy = createTestStrategy();
      const task = createTestTask();
      // Create identical models with different IDs
      const models = [
        createTestModel({
          providerId: "z-provider",
          modelId: "z-model",
          inputPricePerMillion: 3.0,
          outputPricePerMillion: 15.0,
          historicalSuccessRate: 0.98,
          averageLatencyMs: 2500
        }),
        createTestModel({
          providerId: "a-provider",
          modelId: "a-model",
          inputPricePerMillion: 3.0,
          outputPricePerMillion: 15.0,
          historicalSuccessRate: 0.98,
          averageLatencyMs: 2500
        })
      ];

      const result = engine.route({
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 100
      });

      // Should select a-provider/a-model (earlier alphabetically)
      expect(result.selected.providerId).toBe("a-provider");
      expect(result.selected.modelId).toBe("a-model");
    });

    it("should consistently return same model for identical input", () => {
      const strategy = createTestStrategy();
      const task = createTestTask();
      const models = [
        createTestModel({ providerId: "anthropic", modelId: "model-1" }),
        createTestModel({ providerId: "openai", modelId: "model-2" }),
        createTestModel({ providerId: "google", modelId: "model-3" })
      ];

      const context: RoutingContext = {
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 100
      };

      const result1 = engine.route(context);
      const result2 = engine.route(context);

      expect(result1.selected.providerId).toBe(result2.selected.providerId);
      expect(result1.selected.modelId).toBe(result2.selected.modelId);
    });
  });

  describe("Fallback chain", () => {
    it("should build fallback chain from top 3 candidates", () => {
      const strategy = createTestStrategy();
      const task = createTestTask();
      const models = Array.from({ length: 5 }, (_, i) =>
        createTestModel({
          providerId: `provider-${i}`,
          modelId: `model-${i}`
        })
      );

      const result = engine.route({
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 100
      });

      expect(result.evidence.fallbackChain).toHaveLength(3);
      expect(result.evidence.fallbackChain[0].providerId).toBe(result.selected.providerId);
      expect(result.evidence.fallbackChain[0].modelId).toBe(result.selected.modelId);
    });
  });

  describe("Evidence and audit trail", () => {
    it("should record hard filter evidence", () => {
      const strategy = createTestStrategy();
      const task = createTestTask({ repositoryWrite: true });
      const models = [
        createTestModel({ supportsRepositoryWrite: true }),
        createTestModel({ supportsRepositoryWrite: false })
      ];

      const result = engine.route({
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 100
      });

      expect(result.evidence.hardFiltersApplied).toContain(
        "Repository write required: filtering models with supportsRepositoryWrite=true"
      );
    });

    it("should record scoring details", () => {
      const strategy = createTestStrategy();
      const task = createTestTask();
      const models = [createTestModel()];

      const result = engine.route({
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 100
      });

      expect(result.evidence.scoringDetails).toBeDefined();
      expect(result.evidence.scoringDetails.finalScore).toBeDefined();
      expect(result.evidence.scoringDetails.qualityWeight).toBe(4);
      expect(result.evidence.scoringDetails.costWeight).toBe(2);
    });

    it("should record candidate scores", () => {
      const strategy = createTestStrategy();
      const task = createTestTask();
      const models = [
        createTestModel({ modelId: "model-1" }),
        createTestModel({ modelId: "model-2" })
      ];

      const result = engine.route({
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 100
      });

      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0].score).toBeGreaterThanOrEqual(result.candidates[1].score);
      expect(result.candidates.every((c) => c.evidence.length > 0)).toBe(true);
    });
  });

  describe("Error handling", () => {
    it("should throw when no eligible models after filters", () => {
      const strategy = createTestStrategy();
      const task = createTestTask({ repositoryWrite: true });
      const models = [
        createTestModel({ supportsRepositoryWrite: false }),
        createTestModel({ supportsRepositoryWrite: false })
      ];

      expect(() => {
        engine.route({
          strategy,
          task,
          availableModels: models,
          budgetRemaining: 100
        });
      }).toThrow("No eligible models available for routing decision");
    });

    it("should throw when all models exceed budget", () => {
      const strategy = createTestStrategy();
      const task = createTestTask({ expectedInputTokens: 1000000, expectedOutputTokens: 100000 });
      const models = [
        createTestModel({
          inputPricePerMillion: 100.0,
          outputPricePerMillion: 100.0
        })
      ];

      expect(() => {
        engine.route({
          strategy,
          task,
          availableModels: models,
          budgetRemaining: 0.01 // Only $0.01 budget
        });
      }).toThrow("No eligible models available for routing decision");
    });
  });

  describe("Multi-provider scenarios", () => {
    it("should select best model across multiple providers", () => {
      const strategy = createTestStrategy();
      const task = createTestTask({ role: "primary_coder" });
      const models = [
        createTestModel({
          providerId: "anthropic",
          modelId: "claude-sonnet",
          roles: ["primary_coder"],
          historicalSuccessRate: 0.95
        }),
        createTestModel({
          providerId: "openai",
          modelId: "gpt-4",
          roles: ["reviewer"],
          historicalSuccessRate: 0.99
        }),
        createTestModel({
          providerId: "google",
          modelId: "gemini-pro",
          roles: ["primary_coder"],
          historicalSuccessRate: 0.92
        })
      ];

      const result = engine.route({
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 100
      });

      expect(result.selected.providerId).toBe("anthropic");
    });

    it("should handle provider-specific capabilities", () => {
      const strategy = createTestStrategy();
      const task = createTestTask({ requiredVision: true });
      const models = [
        createTestModel({
          providerId: "anthropic",
          modelId: "claude-opus",
          supportsVision: true
        }),
        createTestModel({
          providerId: "ollama",
          modelId: "local-model",
          supportsVision: false,
          local: true
        })
      ];

      const result = engine.route({
        strategy,
        task,
        availableModels: models,
        budgetRemaining: 100
      });

      expect(result.selected.providerId).toBe("anthropic");
    });
  });
});
