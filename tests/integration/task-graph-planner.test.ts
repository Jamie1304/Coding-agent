import { describe, it, expect, beforeEach } from "vitest";
import { TaskGraphPlanner, type PlanContext } from "@agent/core";
import type { RoutingStrategy, TaskDescriptor } from "@agent/shared";
import type { DiscoveredModel } from "@agent/ai";

describe("Task Graph Planner - Integration with Planning and Scheduling", () => {
  let planner: TaskGraphPlanner;

  beforeEach(() => {
    planner = new TaskGraphPlanner();
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
      releasePolicy: {},
      roles: {
        primary_coder: {
          ownerName: "Alice",
          availableProviderIds: ["anthropic", "openai"],
          requiredCapabilities: ["tools"],
          contextPolicy: { excludePatterns: ["*.log", "*.tmp"] }
        },
        reviewer: {
          ownerName: "Bob",
          availableProviderIds: ["anthropic"],
          requiredCapabilities: [],
          contextPolicy: {}
        }
      },
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
      notes: "Test model",
      ...overrides
    };
  }

  describe("Task graph construction", () => {
    it("should build graph from task descriptors", () => {
      const strategy = createTestStrategy();
      const tasks: TaskDescriptor[] = [
        {
          id: "task-1",
          runId: "run-1",
          title: "Analyze requirements",
          description: "Analyze",
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
        },
        {
          id: "task-2",
          runId: "run-1",
          title: "Implement solution",
          description: "Implement",
          role: "primary_coder",
          expectedInputTokens: 50000,
          expectedOutputTokens: 10000,
          requiredTools: true,
          requiredVision: false,
          repositoryWrite: true,
          sensitive: false,
          likelyFiles: [],
          dependencies: ["task-1"],
          risk: "medium"
        }
      ];

      const context: PlanContext = {
        strategy,
        tasks,
        availableModels: [createTestModel()],
        runId: "run-1"
      };

      const graph = planner.buildGraph(context);

      expect(graph.nodes.size).toBe(2);
      expect(graph.nodes.has("task-1")).toBe(true);
      expect(graph.nodes.has("task-2")).toBe(true);
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0]).toEqual({ from: "task-1", to: "task-2" });
    });

    it("should assign owners based on role policy", () => {
      const strategy = createTestStrategy();
      const tasks: TaskDescriptor[] = [
        {
          id: "task-1",
          runId: "run-1",
          title: "Code",
          description: "Code",
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
        },
        {
          id: "task-2",
          runId: "run-1",
          title: "Review",
          description: "Review",
          role: "reviewer",
          expectedInputTokens: 20000,
          expectedOutputTokens: 1000,
          requiredTools: false,
          requiredVision: false,
          repositoryWrite: false,
          sensitive: false,
          likelyFiles: [],
          dependencies: [],
          risk: "low"
        }
      ];

      const context: PlanContext = {
        strategy,
        tasks,
        availableModels: [createTestModel()],
        runId: "run-1"
      };

      const graph = planner.buildGraph(context);

      expect(graph.nodes.get("task-1")!.owner).toBe("Alice");
      expect(graph.nodes.get("task-2")!.owner).toBe("Bob");
    });

    it("should preserve risk levels", () => {
      const strategy = createTestStrategy();
      const tasks: TaskDescriptor[] = [
        {
          id: "task-low",
          runId: "run-1",
          title: "Low risk",
          description: "Low",
          role: "primary_coder",
          expectedInputTokens: 1000,
          expectedOutputTokens: 100,
          requiredTools: false,
          requiredVision: false,
          repositoryWrite: false,
          sensitive: false,
          likelyFiles: [],
          dependencies: [],
          risk: "low"
        },
        {
          id: "task-high",
          runId: "run-1",
          title: "High risk",
          description: "High",
          role: "primary_coder",
          expectedInputTokens: 50000,
          expectedOutputTokens: 10000,
          requiredTools: true,
          requiredVision: false,
          repositoryWrite: true,
          sensitive: false,
          likelyFiles: [],
          dependencies: [],
          risk: "high"
        }
      ];

      const context: PlanContext = {
        strategy,
        tasks,
        availableModels: [createTestModel()],
        runId: "run-1"
      };

      const graph = planner.buildGraph(context);

      expect(graph.nodes.get("task-low")!.risk).toBe("low");
      expect(graph.nodes.get("task-high")!.risk).toBe("high");
    });
  });

  describe("Model assignment", () => {
    it("should assign models based on role policy", () => {
      const strategy = createTestStrategy();
      const tasks: TaskDescriptor[] = [
        {
          id: "task-1",
          runId: "run-1",
          title: "Code",
          description: "Code",
          role: "primary_coder",
          expectedInputTokens: 10000,
          expectedOutputTokens: 2000,
          requiredTools: true,
          requiredVision: false,
          repositoryWrite: false,
          sensitive: false,
          likelyFiles: [],
          dependencies: [],
          risk: "low"
        }
      ];

      const context: PlanContext = {
        strategy,
        tasks,
        availableModels: [
          createTestModel({ providerId: "anthropic", supportsTools: true }),
          createTestModel({ providerId: "openai", supportsTools: false })
        ],
        runId: "run-1"
      };

      const graph = planner.buildGraph(context);
      const taskMap = new Map(tasks.map((t) => [t.id, t]));

      planner.assignModelsToGraph(graph, strategy, context.availableModels, taskMap);

      const node = graph.nodes.get("task-1");
      expect(node!.assignedModel).toBeDefined();
      expect(node!.assignedModel!.supportsTools).toBe(true);
    });

    it("should filter models by provider availability in role policy", () => {
      const strategy = createTestStrategy();
      strategy.roles.primary_coder.availableProviderIds = ["anthropic"];

      const tasks: TaskDescriptor[] = [
        {
          id: "task-1",
          runId: "run-1",
          title: "Code",
          description: "Code",
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
        }
      ];

      const context: PlanContext = {
        strategy,
        tasks,
        availableModels: [
          createTestModel({ providerId: "anthropic" }),
          createTestModel({ providerId: "openai" })
        ],
        runId: "run-1"
      };

      const graph = planner.buildGraph(context);
      const taskMap = new Map(tasks.map((t) => [t.id, t]));

      planner.assignModelsToGraph(graph, strategy, context.availableModels, taskMap);

      const node = graph.nodes.get("task-1");
      expect(node!.assignedModel!.providerId).toBe("anthropic");
    });

    it("should calculate cost for assigned models", () => {
      const strategy = createTestStrategy();
      const tasks: TaskDescriptor[] = [
        {
          id: "task-1",
          runId: "run-1",
          title: "Test",
          description: "Test",
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
        }
      ];

      const context: PlanContext = {
        strategy,
        tasks,
        availableModels: [
          createTestModel({
            inputPricePerMillion: 3.0,
            outputPricePerMillion: 15.0
          })
        ],
        runId: "run-1"
      };

      const graph = planner.buildGraph(context);
      const taskMap = new Map(tasks.map((t) => [t.id, t]));

      planner.assignModelsToGraph(graph, strategy, context.availableModels, taskMap);

      const node = graph.nodes.get("task-1");
      // Input: 10000 / 1M * 3 = 0.03
      // Output: 2000 / 1M * 15 = 0.03
      // Total: 0.06
      expect(node!.estimatedCost).toBeCloseTo(0.06, 6);
    });
  });

  describe("Cost calculation", () => {
    it("should sum costs across all tasks", () => {
      const strategy = createTestStrategy();
      const tasks: TaskDescriptor[] = [
        {
          id: "task-1",
          runId: "run-1",
          title: "Task 1",
          description: "Task 1",
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
        },
        {
          id: "task-2",
          runId: "run-1",
          title: "Task 2",
          description: "Task 2",
          role: "primary_coder",
          expectedInputTokens: 20000,
          expectedOutputTokens: 4000,
          requiredTools: false,
          requiredVision: false,
          repositoryWrite: false,
          sensitive: false,
          likelyFiles: [],
          dependencies: [],
          risk: "low"
        }
      ];

      const context: PlanContext = {
        strategy,
        tasks,
        availableModels: [
          createTestModel({
            inputPricePerMillion: 3.0,
            outputPricePerMillion: 15.0
          })
        ],
        runId: "run-1"
      };

      const graph = planner.buildGraph(context);
      const taskMap = new Map(tasks.map((t) => [t.id, t]));

      planner.assignModelsToGraph(graph, strategy, context.availableModels, taskMap);

      const totalCost = planner.calculateTotalCost(graph);
      // Task 1: 10000/1M*3 + 2000/1M*15 = 0.03 + 0.03 = 0.06
      // Task 2: 20000/1M*3 + 4000/1M*15 = 0.06 + 0.06 = 0.12
      // Total: 0.18
      expect(totalCost).toBeCloseTo(0.18, 6);
    });
  });

  describe("Critical path analysis", () => {
    it("should identify critical path with linear dependencies", () => {
      const strategy = createTestStrategy();
      const tasks: TaskDescriptor[] = [
        {
          id: "task-1",
          runId: "run-1",
          title: "First",
          description: "First",
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
        },
        {
          id: "task-2",
          runId: "run-1",
          title: "Second",
          description: "Second",
          role: "primary_coder",
          expectedInputTokens: 10000,
          expectedOutputTokens: 2000,
          requiredTools: false,
          requiredVision: false,
          repositoryWrite: false,
          sensitive: false,
          likelyFiles: [],
          dependencies: ["task-1"],
          risk: "low"
        },
        {
          id: "task-3",
          runId: "run-1",
          title: "Third",
          description: "Third",
          role: "primary_coder",
          expectedInputTokens: 10000,
          expectedOutputTokens: 2000,
          requiredTools: false,
          requiredVision: false,
          repositoryWrite: false,
          sensitive: false,
          likelyFiles: [],
          dependencies: ["task-2"],
          risk: "low"
        }
      ];

      const context: PlanContext = {
        strategy,
        tasks,
        availableModels: [createTestModel()],
        runId: "run-1"
      };

      const graph = planner.buildGraph(context);

      expect(graph.criticalPath).toEqual(["task-1", "task-2", "task-3"]);
    });

    it("should identify critical path with branching", () => {
      const strategy = createTestStrategy();
      const tasks: TaskDescriptor[] = [
        {
          id: "task-1",
          runId: "run-1",
          title: "Start",
          description: "Start",
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
        },
        {
          id: "task-2a",
          runId: "run-1",
          title: "Branch A",
          description: "Branch A",
          role: "primary_coder",
          expectedInputTokens: 10000,
          expectedOutputTokens: 2000,
          requiredTools: false,
          requiredVision: false,
          repositoryWrite: false,
          sensitive: false,
          likelyFiles: [],
          dependencies: ["task-1"],
          risk: "low"
        },
        {
          id: "task-2b",
          runId: "run-1",
          title: "Branch B",
          description: "Branch B",
          role: "primary_coder",
          expectedInputTokens: 10000,
          expectedOutputTokens: 2000,
          requiredTools: false,
          requiredVision: false,
          repositoryWrite: false,
          sensitive: false,
          likelyFiles: [],
          dependencies: ["task-1"],
          risk: "low"
        },
        {
          id: "task-3",
          runId: "run-1",
          title: "Merge",
          description: "Merge",
          role: "primary_coder",
          expectedInputTokens: 10000,
          expectedOutputTokens: 2000,
          requiredTools: false,
          requiredVision: false,
          repositoryWrite: false,
          sensitive: false,
          likelyFiles: [],
          dependencies: ["task-2a", "task-2b"],
          risk: "low"
        }
      ];

      const context: PlanContext = {
        strategy,
        tasks,
        availableModels: [createTestModel()],
        runId: "run-1"
      };

      const graph = planner.buildGraph(context);

      expect(graph.criticalPath).toHaveLength(3);
      expect(graph.criticalPath[0]).toBe("task-1");
      expect(graph.criticalPath[2]).toBe("task-3");
      expect(["task-2a", "task-2b"]).toContain(graph.criticalPath[1]);
    });
  });

  describe("Parallelization", () => {
    it("should identify independent tasks", () => {
      const strategy = createTestStrategy();
      const tasks: TaskDescriptor[] = [
        {
          id: "task-1",
          runId: "run-1",
          title: "Task 1",
          description: "Task 1",
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
        },
        {
          id: "task-2",
          runId: "run-1",
          title: "Task 2",
          description: "Task 2",
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
        }
      ];

      const context: PlanContext = {
        strategy,
        tasks,
        availableModels: [createTestModel()],
        runId: "run-1"
      };

      const graph = planner.buildGraph(context);
      const groups = planner.calculateParallelizableGroups(graph);

      expect(groups.length).toBeGreaterThan(0);
      const flattened = groups.flat();
      expect(flattened).toContain("task-1");
      expect(flattened).toContain("task-2");
    });
  });

  describe("Context minimization", () => {
    it("should identify context exclusion patterns by role", () => {
      const strategy = createTestStrategy();
      const tasks: TaskDescriptor[] = [
        {
          id: "task-1",
          runId: "run-1",
          title: "Code",
          description: "Code",
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
        }
      ];

      const context: PlanContext = {
        strategy,
        tasks,
        availableModels: [createTestModel()],
        runId: "run-1"
      };

      const graph = planner.buildGraph(context);
      const contextMap = planner.identifyContextMinimization(graph, strategy);

      expect(contextMap.has("task-1")).toBe(true);
      expect(contextMap.get("task-1")).toEqual(["*.log", "*.tmp"]);
    });

    it("should handle roles without context policy", () => {
      const strategy = createTestStrategy();
      delete strategy.roles.primary_coder.contextPolicy;

      const tasks: TaskDescriptor[] = [
        {
          id: "task-1",
          runId: "run-1",
          title: "Code",
          description: "Code",
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
        }
      ];

      const context: PlanContext = {
        strategy,
        tasks,
        availableModels: [createTestModel()],
        runId: "run-1"
      };

      const graph = planner.buildGraph(context);
      const contextMap = planner.identifyContextMinimization(graph, strategy);

      expect(contextMap.has("task-1")).toBe(false);
    });
  });
});
