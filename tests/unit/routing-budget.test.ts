import type {
  BudgetConfig,
  DiscoveredModel,
  ModelUsage,
  RoutingConfig,
  TaskDescriptor
} from "@agent/ai";
import {
  BudgetLedger,
  ModelRouter,
  TaskClassifier,
  estimateTokens,
  minimizeContext,
  stableCacheKey,
  type RoutingContext
} from "@agent/core";

const config: RoutingConfig = {
  profile: "balanced",
  weights: { capability: 4, reliability: 2, latency: 1, cost: 2, cache: 1, privacy: 2 },
  cloudRequiresApproval: false,
  localOnly: false,
  maximumParallelTasks: 3,
  minimumLearningSamples: 10,
  verification: {
    criticalRequiresIndependent: true,
    largeRequiresIndependent: false,
    preferDifferentProvider: true
  }
};
const budget: BudgetConfig = {
  dailyLimit: 10,
  monthlyLimit: 100,
  perRunLimit: 5,
  perTaskLimit: 2,
  warningPercent: 80
};

function model(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    providerId: "local",
    modelId: "model",
    displayName: "Model",
    available: true,
    enabled: true,
    local: true,
    supportsStreaming: true,
    supportsTools: true,
    supportsStructuredOutput: true,
    supportsVision: false,
    supportsCaching: true,
    supportsTokenCounting: true,
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    roles: ["planning", "fallback"],
    weaknesses: [],
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    cachedInputPricePerMillion: 0,
    maximumConcurrency: 2,
    defaultTimeoutMs: 120_000,
    maximumTaskCost: null,
    metadataSource: "provider_discovery",
    metadata: {},
    lastTestedAt: null,
    averageLatencyMs: 50,
    historicalSuccessRate: null,
    notes: "",
    ...overrides
  };
}

function task(overrides: Partial<TaskDescriptor> = {}): TaskDescriptor {
  return {
    id: "task",
    runId: "run",
    title: "Plan",
    description: "Summarize a known value",
    role: "planning",
    expectedInputTokens: 100,
    expectedOutputTokens: 50,
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

function context(models: DiscoveredModel[]): RoutingContext {
  return {
    models,
    config,
    budget,
    spentToday: 0,
    spentThisRun: 0,
    providerHealth: {},
    performance: {},
    cacheKeys: new Set<string>(),
    cloudApproved: false
  };
}

describe("deterministic routing and classification", () => {
  it("routes trivial work locally and produces an explanation", () => {
    const decision = new ModelRouter().route(task(), context([model()]));
    expect(decision).toMatchObject({
      selectedProviderId: "local",
      taskTier: "trivial",
      verificationPolicy: "deterministic"
    });
    expect(decision.reasonCodes).toContain("local_privacy");
  });

  it("escalates critical work and requires independent verification", () => {
    const critical = task({
      description: "Change authentication, secrets, production architecture and database migration",
      risk: "critical",
      likelyFiles: Array.from({ length: 12 }, (_, index) => `${index}.ts`)
    });
    expect(new TaskClassifier().classify(critical)).toBe("critical");
    const decision = new ModelRouter().route(
      critical,
      context([model({ providerId: "cloud", local: false, roles: ["planning", "frontier"] })])
    );
    expect(decision.verificationPolicy).toBe("independent");
  });

  it.each([
    ["disabled", model({ enabled: false })],
    ["unavailable", model({ available: false })],
    ["tools_required", model({ supportsTools: false })],
    ["vision_required", model({ supportsVision: false })],
    ["context_window", model({ contextWindow: 10 })]
  ])("rejects %s models", (reason, candidate) => {
    const input =
      reason === "tools_required"
        ? task({ requiredTools: true })
        : reason === "vision_required"
          ? task({ requiredVision: true })
          : reason === "context_window"
            ? task({ expectedInputTokens: 100 })
            : task();
    expect(() => new ModelRouter().route(input, context([candidate]))).toThrow(reason);
  });

  it("rejects unaffordable, private-cloud, unhealthy, and rate-limited candidates", () => {
    const cloud = model({
      providerId: "cloud",
      local: false,
      inputPricePerMillion: 1_000,
      outputPricePerMillion: 1_000
    });
    const privateContext = context([cloud]);
    privateContext.config = { ...config, profile: "maximum_privacy" };
    expect(() => new ModelRouter().route(task({ sensitive: true }), privateContext)).toThrow(
      "privacy_local_only"
    );
    const costlyContext = context([cloud]);
    expect(() =>
      new ModelRouter().route(
        task({ expectedInputTokens: 10_000, expectedOutputTokens: 10_000 }),
        costlyContext
      )
    ).toThrow("budget_exceeded");
    for (const health of ["outage", "rate_limited", "authentication"] as const) {
      const unhealthy = context([model({ providerId: "cloud", local: false })]);
      unhealthy.providerHealth.cloud = health;
      expect(() => new ModelRouter().route(task(), unhealthy)).toThrow(/provider_/);
    }
  });

  it("protects learning with a sample floor, rewards cache, and ties deterministically", () => {
    const first = model({ providerId: "b", modelId: "same", local: false });
    const second = model({ providerId: "a", modelId: "same", local: false });
    const ctx = context([first, second]);
    ctx.performance["b:same"] = { samples: 1, successRate: 1, averageLatencyMs: 50 };
    expect(new ModelRouter().route(task(), ctx).selectedProviderId).toBe("a");
    ctx.cacheKeys.add(stableCacheKey(task(), first));
    expect(new ModelRouter().route(task(), ctx).selectedProviderId).toBe("b");
  });

  it("attaches configured strategy metadata to the routing decision", () => {
    const ctx = context([
      model({ providerId: "cloud", local: false, modelId: "sol" }),
      model({ providerId: "local", local: true, modelId: "local-coder" })
    ]);
    ctx.config = {
      ...ctx.config,
      strategy: {
        id: "maximum_quality",
        version: "2.0",
        name: "Maximum Quality",
        description: "Prefer the highest quality model available.",
        roleAssignments: {
          task_classification: "planning",
          master_planning: "planning",
          normal_coding: "coding",
          test_generation: "coding"
        },
        plannerRole: "planning",
        plannerModel: "sol",
        primaryWorkerRole: "coding",
        primaryWorkerModel: "local-coder",
        testWorkerRole: "coding",
        testWorkerModel: "local-coder",
        runtimeAnalysisRole: "verification",
        runtimeAnalysisModel: "sol",
        independentReviewerRole: "code_review",
        independentReviewerModel: "sol",
        releaseJudgeRole: "verification",
        releaseJudgeModel: "sol",
        fallbackModels: ["local-coder"],
        escalationRules: ["hard_debugging_after_retries"],
        maximumAttempts: 3,
        maximumCost: 10,
        requiresUserApprovalForEscalation: true,
        localOnly: false
      }
    };
    const decision = new ModelRouter().route(task({ role: "planning" }), ctx);
    expect(decision.strategyId).toBe("maximum_quality");
    expect(decision.strategyVersion).toBe("2.0");
    expect(decision.strategyName).toBe("Maximum Quality");
    expect(decision.strategyDescription).toContain("highest quality");
  });
});

describe("tokens and budgets", () => {
  it("estimates, minimizes changed context first, and creates stable cache keys", () => {
    expect(estimateTokens("const value = 1;")).toBeGreaterThan(0);
    const minimized = minimizeContext(
      [
        { path: "unchanged.ts", content: "x".repeat(100), changed: false, relevant: false },
        { path: "changed.ts", content: "const x = 1;", changed: true, relevant: true }
      ],
      10
    );
    expect(minimized.files[0]?.path).toBe("changed.ts");
    expect(minimized.omitted).toContain("unchanged.ts");
    expect(stableCacheKey(task({ likelyFiles: ["b", "a"] }), model())).toBe(
      stableCacheKey(task({ likelyFiles: ["a", "b"] }), model())
    );
  });

  it("enforces task, run, daily, and monthly limits across reservations", () => {
    const ledger = new BudgetLedger(budget);
    ledger.reserve("one", 1, { today: 0, month: 0, run: 0 });
    expect(() => ledger.reserve("two", 2, { today: 0, month: 0, run: 3 })).toThrow("run budget");
    expect(() => ledger.reserve("task", 3, { today: 0, month: 0, run: 0 })).toThrow("task budget");
    expect(() => ledger.reserve("daily", 1, { today: 10, month: 0, run: 0 })).toThrow(
      "daily budget"
    );
  });

  it("reports actual cost and cached usage", () => {
    const ledger = new BudgetLedger(budget);
    ledger.reserve("one", 1, { today: 0, month: 0, run: 0 });
    const usage: ModelUsage = {
      providerId: "openai",
      modelId: "model",
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 10,
      reasoningTokens: 5,
      totalTokens: 115,
      estimatedCost: 0.2,
      actualCost: 0.25,
      latencyMs: 20,
      timeToFirstTokenMs: 5
    };
    ledger.reconcile("one", usage, { runId: "run", taskId: "task" });
    expect(ledger.summary()).toMatchObject({ today: 0.25, month: 0.25, cachedTokens: 40 });
  });
});
