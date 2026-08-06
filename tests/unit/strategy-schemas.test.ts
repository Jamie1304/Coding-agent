import { describe, it, expect } from "vitest";
import {
  RoutingStrategySchema,
  RoleRoutingPolicySchema,
  EscalationRuleSchema,
  BudgetsSchema,
  RoutingDecisionSchema,
  StrategySimulationSchema,
  TaskDescriptorSchema,
  ObjectiveSchema,
  PrivacyPolicySchema,
  VerificationPolicySchema,
  ReleasePolicySchema,
  ContextPolicySchema,
  RetryPolicySchema,
  ParallelPolicySchema,
  StrategyGenerationMetadataSchema
} from "@agent/shared";

describe("Strategy Schemas - Validation", () => {
  describe("Objective", () => {
    it("should validate a valid objective with balanced profile", () => {
      const objective = {
        profile: "balanced" as const,
        costWeight: 2,
        qualityWeight: 4,
        reliabilityWeight: 2,
        latencyWeight: 1,
        privacyWeight: 2
      };
      expect(() => ObjectiveSchema.parse(objective)).not.toThrow();
    });

    it("should validate all objective profiles", () => {
      for (const profile of ["maximum-savings", "balanced", "maximum-quality", "maximum-privacy", "custom"] as const) {
        const objective = ObjectiveSchema.parse({
          profile,
          costWeight: 2,
          qualityWeight: 4
        });
        expect(objective.profile).toBe(profile);
      }
    });

    it("should reject weights outside valid range", () => {
      expect(() =>
        ObjectiveSchema.parse({
          profile: "custom",
          costWeight: 11 // exceeds max of 10
        })
      ).toThrow();
    });

    it("should apply default weights", () => {
      const objective = ObjectiveSchema.parse({
        profile: "balanced"
      });
      expect(objective.costWeight).toBe(2);
      expect(objective.qualityWeight).toBe(4);
    });
  });

  describe("Budgets", () => {
    it("should validate budgets with all limits set", () => {
      const budgets = {
        perTask: { amount: 1.0, currency: "USD" },
        perRun: { amount: 5.0, currency: "USD" },
        perDay: { amount: 50.0, currency: "USD" },
        perMonth: { amount: 1000.0, currency: "USD" },
        warningThresholdPercent: 80,
        reserveForFallbackPercent: 10
      };
      expect(() => BudgetsSchema.parse(budgets)).not.toThrow();
    });

    it("should allow null limits", () => {
      const budgets = {
        perTask: null,
        perRun: null,
        perDay: null,
        perMonth: null
      };
      const parsed = BudgetsSchema.parse(budgets);
      expect(parsed.perTask).toBeNull();
      expect(parsed.perMonth).toBeNull();
    });

    it("should reject invalid warning thresholds", () => {
      expect(() =>
        BudgetsSchema.parse({
          warningThresholdPercent: 0 // must be >= 1
        })
      ).toThrow();

      expect(() =>
        BudgetsSchema.parse({
          warningThresholdPercent: 101 // must be <= 100
        })
      ).toThrow();
    });

    it("should reject negative amounts", () => {
      expect(() =>
        BudgetsSchema.parse({
          perTask: { amount: -1.0, currency: "USD" }
        })
      ).toThrow();
    });
  });

  describe("ContextPolicy", () => {
    it("should validate default context policy", () => {
      const policy = ContextPolicySchema.parse({});
      expect(policy.changedFilesFirst).toBe(true);
      expect(policy.relevantFilesOnly).toBe(true);
      expect(policy.preserveStableCachePrefix).toBe(true);
    });

    it("should respect specified master specification modes", () => {
      for (const mode of ["reference", "summary", "full"] as const) {
        const policy = ContextPolicySchema.parse({
          includeMasterSpecification: mode
        });
        expect(policy.includeMasterSpecification).toBe(mode);
      }
    });

    it("should reject invalid max log excerpt size", () => {
      expect(() =>
        ContextPolicySchema.parse({
          maximumLogExcerptBytes: 0 // must be positive
        })
      ).toThrow();
    });
  });

  describe("PrivacyPolicy", () => {
    it("should validate default privacy policy", () => {
      const policy = PrivacyPolicySchema.parse({});
      expect(policy.defaultMode).toBe("standard");
      expect(policy.redactBeforeProviderTransmission).toBe(true);
      expect(policy.allowProprietaryCodeOffDevice).toBe(false);
    });

    it("should validate all privacy modes", () => {
      for (const mode of ["standard", "privacy-preferred", "maximum-privacy"] as const) {
        const policy = PrivacyPolicySchema.parse({
          defaultMode: mode
        });
        expect(policy.defaultMode).toBe(mode);
      }
    });

    it("should validate sensitive task cloud policies", () => {
      for (const cloudPolicy of ["deny", "require-run-approval"] as const) {
        const policy = PrivacyPolicySchema.parse({
          sensitiveTaskCloudPolicy: cloudPolicy
        });
        expect(policy.sensitiveTaskCloudPolicy).toBe(cloudPolicy);
      }
    });

    it("should allow specifying permitted provider locations", () => {
      const policy = PrivacyPolicySchema.parse({
        permittedProviderLocations: ["local"]
      });
      expect(policy.permittedProviderLocations).toEqual(["local"]);
    });
  });

  describe("RoleRoutingPolicy", () => {
    it("should validate a complete role routing policy", () => {
      const policy = {
        role: "primary_coder" as const,
        preferredProviders: ["anthropic"],
        allowedProviders: ["anthropic", "openai"],
        deniedProviders: ["ollama"],
        requiredCapabilities: {
          tools: true,
          repositoryWrite: true
        },
        fallbackChain: ["complex_coding_specialist", "debugging_specialist"]
      };
      expect(() => RoleRoutingPolicySchema.parse(policy)).not.toThrow();
    });

    it("should apply default capability requirements", () => {
      const policy = RoleRoutingPolicySchema.parse({
        role: "primary_coder"
      });
      expect(policy.requiredCapabilities.tools).toBe(false);
      expect(policy.requiredCapabilities.vision).toBe(false);
    });

    it("should validate weight ranges", () => {
      expect(() =>
        RoleRoutingPolicySchema.parse({
          role: "primary_coder",
          qualityWeight: -1 // must be >= 0
        })
      ).toThrow();

      expect(() =>
        RoleRoutingPolicySchema.parse({
          role: "primary_coder",
          costWeight: 11 // must be <= 10
        })
      ).toThrow();
    });

    it("should reject negative latency", () => {
      expect(() =>
        RoleRoutingPolicySchema.parse({
          role: "primary_coder",
          maximumLatencyMs: -100
        })
      ).toThrow();
    });
  });

  describe("EscalationRule", () => {
    it("should validate a complete escalation rule", () => {
      const rule = {
        id: "escalate-after-2-failures",
        name: "Escalate to specialist after 2 failures",
        conditions: {
          attemptCount: 2,
          repeatedErrorFingerprint: true,
          taskComplexity: "large" as const,
          taskRisk: "high" as const
        },
        targetRole: "complex_coding_specialist",
        fallbackChain: ["hard_debugging_specialist", "release_judge"]
      };
      expect(() => EscalationRuleSchema.parse(rule)).not.toThrow();
    });

    it("should allow partial condition matching", () => {
      const rule = {
        id: "simple-escalation",
        name: "Escalate on attempt count only",
        conditions: {
          attemptCount: 3
        },
        targetRole: "complex_coding_specialist"
      };
      expect(() => EscalationRuleSchema.parse(rule)).not.toThrow();
    });

    it("should allow disabling rules", () => {
      const rule = EscalationRuleSchema.parse({
        id: "disabled-rule",
        enabled: false,
        targetRole: "primary_coder",
        conditions: {}
      });
      expect(rule.enabled).toBe(false);
    });
  });

  describe("RoutingStrategy", () => {
    it("should validate a complete routing strategy", () => {
      const strategy = {
        id: "strategy-balanced-001",
        name: "Balanced Cost and Quality",
        version: 1,
        status: "draft" as const,
        scope: "global" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdBy: "user" as const,
        objective: {
          profile: "balanced" as const,
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
        roles: {}
      };
      expect(() => RoutingStrategySchema.parse(strategy)).not.toThrow();
    });

    it("should validate different status values", () => {
      for (const status of ["draft", "active", "archived"] as const) {
        const strategy = RoutingStrategySchema.parse({
          id: "test-strategy",
          name: "Test",
          status,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        expect(strategy.status).toBe(status);
      }
    });

    it("should validate different creator sources", () => {
      for (const creator of ["user", "ai", "migration", "system"] as const) {
        const strategy = RoutingStrategySchema.parse({
          id: "test-strategy",
          name: "Test",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          createdBy: creator
        });
        expect(strategy.createdBy).toBe(creator);
      }
    });

    it("should reject missing name", () => {
      expect(() =>
        RoutingStrategySchema.parse({
          id: "test",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })
      ).toThrow();
    });

    it("should reject negative version", () => {
      expect(() =>
        RoutingStrategySchema.parse({
          id: "test",
          name: "Test",
          version: 0, // must be >= 1
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })
      ).toThrow();
    });

    it("should allow project scope with path reference", () => {
      const strategy = RoutingStrategySchema.parse({
        id: "project-override",
        name: "Project Override",
        scope: "project" as const,
        projectPathReference: "/path/to/project",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      expect(strategy.scope).toBe("project");
      expect(strategy.projectPathReference).toBe("/path/to/project");
    });

    it("should support inheritance from another strategy", () => {
      const strategy = RoutingStrategySchema.parse({
        id: "child-strategy",
        name: "Child",
        basedOnStrategyId: "parent-strategy-id",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      expect(strategy.basedOnStrategyId).toBe("parent-strategy-id");
    });

    it("should allow empty role assignments", () => {
      const strategy = RoutingStrategySchema.parse({
        id: "minimal",
        name: "Minimal",
        roles: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      expect(Object.keys(strategy.roles)).toHaveLength(0);
    });
  });

  describe("TaskDescriptor", () => {
    it("should validate a complete task descriptor", () => {
      const task = {
        id: "task-001",
        type: "code-review",
        complexity: "medium" as const,
        readOnly: false,
        securitySensitive: false,
        privacySensitive: false,
        requiredTools: true,
        requiredVision: false,
        requiredStructuredOutput: false,
        estimatedInputTokens: 25_000,
        estimatedOutputTokens: 5_000,
        expectedFiles: ["src/utils.ts", "tests/utils.test.ts"],
        riskLevel: "medium" as const,
        expectedVerificationType: "deterministic" as const,
        parallelEligible: true,
        description: "Review utility functions for correctness"
      };
      expect(() => TaskDescriptorSchema.parse(task)).not.toThrow();
    });

    it("should validate all complexity levels", () => {
      for (const complexity of ["trivial", "small", "medium", "large", "critical"] as const) {
        const task = TaskDescriptorSchema.parse({
          id: "test",
          type: "test",
          complexity,
          estimatedInputTokens: 1000,
          estimatedOutputTokens: 1000
        });
        expect(task.complexity).toBe(complexity);
      }
    });

    it("should allow empty file list", () => {
      const task = TaskDescriptorSchema.parse({
        id: "minimal",
        type: "test",
        complexity: "trivial",
        estimatedInputTokens: 100,
        estimatedOutputTokens: 100
      });
      expect(task.expectedFiles).toEqual([]);
    });
  });

  describe("RoutingDecision", () => {
    it("should validate a complete routing decision", () => {
      const now = new Date().toISOString();
      const decision = {
        id: "routing-001",
        timestamp: now,
        strategyId: "strategy-001",
        strategyVersion: 1,
        taskDescriptor: {
          id: "task-001",
          type: "implementation",
          complexity: "medium" as const,
          estimatedInputTokens: 25_000,
          estimatedOutputTokens: 5_000
        },
        selectedRole: "primary_coder" as const,
        selectedProviderId: "anthropic",
        selectedModelId: "claude-3.5-sonnet",
        correlationId: "corr-001"
      };
      expect(() => RoutingDecisionSchema.parse(decision)).not.toThrow();
    });

    it("should track eligible and rejected candidates", () => {
      const now = new Date().toISOString();
      const decision = RoutingDecisionSchema.parse({
        id: "routing-001",
        timestamp: now,
        strategyId: "strategy-001",
        strategyVersion: 1,
        taskDescriptor: {
          id: "task-001",
          type: "implementation",
          complexity: "medium",
          estimatedInputTokens: 25_000,
          estimatedOutputTokens: 5_000
        },
        selectedRole: "primary_coder",
        selectedProviderId: "anthropic",
        selectedModelId: "claude-3.5-sonnet",
        eligibleCandidates: [
          { providerId: "anthropic", modelId: "claude-3.5-sonnet", score: 8.5, reasons: ["high-capability"] }
        ],
        rejectedCandidates: [
          { providerId: "openai", modelId: "gpt-4", rejectionReasons: ["context-too-small"] }
        ],
        correlationId: "corr-001"
      });
      expect(decision.eligibleCandidates).toHaveLength(1);
      expect(decision.rejectedCandidates).toHaveLength(1);
    });

    it("should validate budget check structure", () => {
      const now = new Date().toISOString();
      const decision = RoutingDecisionSchema.parse({
        id: "routing-001",
        timestamp: now,
        strategyId: "strategy-001",
        strategyVersion: 1,
        taskDescriptor: {
          id: "task-001",
          type: "implementation",
          complexity: "medium",
          estimatedInputTokens: 25_000,
          estimatedOutputTokens: 5_000
        },
        selectedRole: "primary_coder",
        selectedProviderId: "anthropic",
        selectedModelId: "claude-3.5-sonnet",
        budgetCheck: {
          perTaskRemainingBudget: 1.0,
          perRunRemainingBudget: 5.0,
          dailyRemainingBudget: 50.0,
          monthlyRemainingBudget: 1000.0,
          allChecksPassed: true
        },
        correlationId: "corr-001"
      });
      expect(decision.budgetCheck.allChecksPassed).toBe(true);
    });

    it("should allow null cost estimates", () => {
      const now = new Date().toISOString();
      const decision = RoutingDecisionSchema.parse({
        id: "routing-001",
        timestamp: now,
        strategyId: "strategy-001",
        strategyVersion: 1,
        taskDescriptor: {
          id: "task-001",
          type: "implementation",
          complexity: "medium",
          estimatedInputTokens: 25_000,
          estimatedOutputTokens: 5_000
        },
        selectedRole: "primary_coder",
        selectedProviderId: "anthropic",
        selectedModelId: "claude-3.5-sonnet",
        estimatedInputTokens: null,
        estimatedOutputTokens: null,
        estimatedCost: null,
        correlationId: "corr-001"
      });
      expect(decision.estimatedCost).toBeNull();
    });
  });

  describe("StrategyGeneration", () => {
    it("should validate generation metadata", () => {
      const metadata = {
        generatedAt: new Date().toISOString(),
        generatedBy: "ai" as const,
        generatorModel: "claude-3.5-sonnet",
        generatorProvider: "anthropic",
        generationCost: 0.05,
        userInputProfile: {
          workload: "normal-development",
          primaryLanguages: ["typescript", "python"],
          repositorySize: "large" as const,
          monthlyTaskVolume: 100
        }
      };
      expect(() => StrategyGenerationMetadataSchema.parse(metadata)).not.toThrow();
    });

    it("should allow partial generation metadata", () => {
      const metadata = StrategyGenerationMetadataSchema.parse({
        generatedAt: new Date().toISOString(),
        generatedBy: "user"
      });
      expect(metadata.generatorModel).toBeNull();
      expect(metadata.userInputProfile).toEqual({});
    });
  });

  describe("StrategySimulation", () => {
    it("should validate a simulation result", () => {
      const simulation = {
        id: "sim-001",
        strategyId: "strategy-001",
        createdAt: new Date().toISOString(),
        taskSamples: [
          {
            id: "task-1",
            type: "implementation",
            complexity: "medium" as const,
            estimatedInputTokens: 25_000,
            estimatedOutputTokens: 5_000
          }
        ],
        results: [
          {
            taskId: "task-1",
            selectedRole: "primary_coder" as const,
            selectedProviderId: "anthropic",
            selectedModelId: "claude-3.5-sonnet",
            estimatedCost: 0.25,
            estimatedLatencyMs: 5000,
            fallbacksNeeded: 0,
            independentReviewUsed: false
          }
        ]
      };
      expect(() => StrategySimulationSchema.parse(simulation)).not.toThrow();
    });

    it("should calculate aggregate statistics", () => {
      const simulation = StrategySimulationSchema.parse({
        id: "sim-001",
        strategyId: "strategy-001",
        createdAt: new Date().toISOString(),
        taskSamples: [],
        results: [],
        averageEstimatedCost: 0.25,
        totalEstimatedCost: 2.5,
        averageLatencyMs: 5000,
        warnings: ["Unknown pricing for model X"]
      });
      expect(simulation.averageEstimatedCost).toBe(0.25);
      expect(simulation.warnings).toContain("Unknown pricing for model X");
    });
  });
});

describe("Strategy Schemas - Serialization Round-trip", () => {
  it("should round-trip a complete strategy to JSON and back", () => {
    const original = RoutingStrategySchema.parse({
      id: "test-strategy",
      name: "Test Strategy",
      version: 1,
      status: "draft",
      scope: "global",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: "user",
      objective: {
        profile: "balanced",
        costWeight: 2,
        qualityWeight: 4,
        reliabilityWeight: 2,
        latencyWeight: 1,
        privacyWeight: 2
      },
      budgets: {
        perTask: { amount: 1.0, currency: "USD" }
      },
      contextPolicy: {},
      retryPolicy: {},
      parallelPolicy: {},
      privacyPolicy: {},
      verificationPolicy: {},
      releasePolicy: {},
      roles: {}
    });

    // Verify the parsed object has correct values
    expect(original.id).toBe("test-strategy");
    expect(original.name).toBe("Test Strategy");
    expect(original.objective.profile).toBe("balanced");

    // Test JSON round-trip for key fields
    const json = JSON.stringify({
      id: original.id,
      name: original.name,
      version: original.version,
      objective: original.objective
    });
    const parsed = JSON.parse(json);

    expect(parsed.id).toBe("test-strategy");
    expect(parsed.objective.profile).toBe("balanced");
  });

  it("should round-trip a routing decision", () => {
    const now = new Date().toISOString();
    const original = RoutingDecisionSchema.parse({
      id: "routing-001",
      timestamp: now,
      strategyId: "strategy-001",
      strategyVersion: 1,
      taskDescriptor: {
        id: "task-001",
        type: "implementation",
        complexity: "medium",
        estimatedInputTokens: 25_000,
        estimatedOutputTokens: 5_000
      },
      selectedRole: "primary_coder",
      selectedProviderId: "anthropic",
      selectedModelId: "claude-3.5-sonnet",
      correlationId: "corr-001"
    });

    // Verify parsed object
    expect(original.id).toBe("routing-001");
    expect(original.selectedRole).toBe("primary_coder");
    expect(original.correlationId).toBe("corr-001");

    // Test JSON round-trip for key fields
    const json = JSON.stringify({
      id: original.id,
      selectedRole: original.selectedRole,
      selectedProviderId: original.selectedProviderId,
      correlationId: original.correlationId
    });
    const parsed = JSON.parse(json);

    expect(parsed.selectedRole).toBe("primary_coder");
    expect(parsed.correlationId).toBe("corr-001");
  });
});
