import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentDatabase } from "@agent/database";
import type { RoutingStrategy, RoutingDecision } from "@agent/shared";

describe("Database Migrations - Strategy Tables", () => {
  let db: AgentDatabase;

  beforeEach(() => {
    db = new AgentDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("should apply all migrations on initialization", () => {
    const migrations = db.raw
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;

    expect(migrations.length).toBeGreaterThanOrEqual(4);
    expect(migrations[0].version).toBe(1);
  });

  it("should create strategies table", () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='strategies'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it("should create strategy_versions table", () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='strategy_versions'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it("should create strategy_activations table", () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='strategy_activations'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it("should create budget_ledger table", () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='budget_ledger'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it("should create cost_reservations table", () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cost_reservations'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it("should enforce foreign key constraints", () => {
    expect(() => {
      db.raw
        .prepare("INSERT INTO strategy_versions VALUES(?,?,?)")
        .run("non-existent-strategy", 1, "{}");
    }).toThrow();
  });

  it("should enforce check constraints on status", () => {
    expect(() => {
      db.raw
        .prepare(
          `INSERT INTO strategies(id,name,version,status,scope,created_at,updated_at,created_by,
            objective_json,budgets_json,context_policy_json,retry_policy_json,parallel_policy_json,
            privacy_policy_json,verification_policy_json,release_policy_json,roles_json,escalation_rules_json)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          "test-strategy",
          "Test",
          1,
          "invalid-status",
          "global",
          new Date().toISOString(),
          new Date().toISOString(),
          "user",
          "{}",
          "{}",
          "{}",
          "{}",
          "{}",
          "{}",
          "{}",
          "{}",
          "{}",
          "[]"
        );
    }).toThrow();
  });
});

describe("Strategy Operations", () => {
  let db: AgentDatabase;

  beforeEach(() => {
    db = new AgentDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function createTestStrategy(overrides: Partial<RoutingStrategy> = {}): RoutingStrategy {
    return {
      id: "test-strategy-" + Date.now(),
      name: "Test Strategy",
      description: "Test description",
      version: 1,
      status: "draft",
      scope: "global",
      projectPathReference: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activatedAt: null,
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

  it("should save and retrieve a strategy", () => {
    const strategy = createTestStrategy();
    db.saveStrategy(strategy);

    const retrieved = db.strategy(strategy.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.name).toBe(strategy.name);
    expect(retrieved?.version).toBe(strategy.version);
    expect(retrieved?.objective.profile).toBe("balanced");
  });

  it("should maintain immutable versions", () => {
    const strategy = createTestStrategy();
    db.saveStrategy(strategy);

    const v1 = db.strategyVersion(strategy.id, 1);
    expect(v1).not.toBeNull();
    expect(v1?.version).toBe(1);

    // Update strategy
    const updated = {
      ...strategy,
      version: 2,
      name: "Updated Strategy",
      updatedAt: new Date().toISOString()
    };
    db.saveStrategy(updated);

    // Original version should be unchanged
    const v1Still = db.strategyVersion(strategy.id, 1);
    expect(v1Still?.name).toBe("Test Strategy");
    expect(v1Still?.version).toBe(1);
  });

  it("should list strategies", () => {
    const s1 = createTestStrategy({ id: "s1", name: "Strategy 1" });
    const s2 = createTestStrategy({ id: "s2", name: "Strategy 2" });
    db.saveStrategy(s1);
    db.saveStrategy(s2);

    const all = db.listStrategies();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.some((s) => s.id === "s1")).toBe(true);
    expect(all.some((s) => s.id === "s2")).toBe(true);
  });

  it("should filter strategies by scope", () => {
    const global = createTestStrategy({ id: "global-1", scope: "global" });
    const project = createTestStrategy({ id: "proj-1", scope: "project" });
    db.saveStrategy(global);
    db.saveStrategy(project);

    const globalOnly = db.listStrategies("global");
    expect(globalOnly.some((s) => s.id === "global-1")).toBe(true);
    expect(globalOnly.some((s) => s.id === "proj-1")).toBe(false);

    const projectOnly = db.listStrategies("project");
    expect(projectOnly.some((s) => s.id === "proj-1")).toBe(true);
  });

  it("should track active strategies per scope", () => {
    const global1 = createTestStrategy({ id: "g1", scope: "global", status: "active" });
    const global2 = createTestStrategy({ id: "g2", scope: "global", status: "draft" });
    db.saveStrategy(global1);
    db.saveStrategy(global2);

    const active = db.activeStrategy("global");
    expect(active?.id).toBe("g1");
  });

  it("should activate a strategy and deactivate previous", () => {
    const s1 = createTestStrategy({ id: "s1", status: "active" });
    const s2 = createTestStrategy({ id: "s2", status: "draft" });

    db.saveStrategy(s1);
    db.saveStrategy(s2);
    db.activateStrategy(s2, s1.id, s1.version);

    const active = db.activeStrategy("global");
    expect(active?.id).toBe("s2");

    // Check activation history
    const history = db.raw
      .prepare("SELECT strategy_id FROM strategy_activations WHERE strategy_id=?")
      .all("s2");
    expect(history).toHaveLength(1);
  });

  it("should archive a strategy", () => {
    const strategy = createTestStrategy();
    db.saveStrategy(strategy);

    db.archiveStrategy(strategy.id);

    const retrieved = db.strategy(strategy.id);
    expect(retrieved?.status).toBe("archived");
    expect(retrieved?.archivedAt).not.toBeNull();
  });

  it("should delete a strategy and versions", () => {
    const strategy = createTestStrategy();
    db.saveStrategy(strategy);

    const deleted = db.deleteStrategy(strategy.id);
    expect(deleted).toBe(true);

    const retrieved = db.strategy(strategy.id);
    expect(retrieved).toBeNull();

    // Version should also be deleted
    const version = db.strategyVersion(strategy.id, 1);
    expect(version).toBeNull();
  });

  it("should save and retrieve simulations", () => {
    const strategy = createTestStrategy();
    db.saveStrategy(strategy);

    const simulation = {
      id: "sim-1",
      strategyId: strategy.id,
      createdAt: new Date().toISOString(),
      taskSamples: [
        {
          id: "task-1",
          type: "implementation",
          complexity: "medium" as const,
          estimatedInputTokens: 25000,
          estimatedOutputTokens: 5000
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
      ],
      averageEstimatedCost: 0.25,
      totalEstimatedCost: 0.25,
      averageLatencyMs: 5000,
      warnings: []
    };

    db.saveSimulation(simulation);

    const retrieved = db.simulation("sim-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.taskSamples).toHaveLength(1);
    expect(retrieved?.results).toHaveLength(1);
  });

  it("should save and retrieve routing decision evidence", () => {
    const strategy = createTestStrategy();
    db.saveStrategy(strategy);

    const run = {
      id: "run-001",
      workspacePath: "/test",
      repositoryIdentity: "repo",
      startingCommit: "abc123",
      state: "IMPLEMENTING" as const,
      finalStatus: null,
      originalPrompt: "test",
      approvedPrompt: "test",
      approvedRevision: 1,
      createdAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
      completedAt: null,
      retryCount: 0
    };
    db.createRun(run);

    const decision: RoutingDecision = {
      id: "route-001",
      timestamp: new Date().toISOString(),
      strategyId: strategy.id,
      strategyVersion: 1,
      taskDescriptor: {
        id: "task-1",
        type: "implementation",
        complexity: "medium",
        estimatedInputTokens: 25000,
        estimatedOutputTokens: 5000
      },
      selectedRole: "primary_coder",
      selectedProviderId: "anthropic",
      selectedModelId: "claude-3.5-sonnet",
      correlationId: "corr-001"
    };

    db.saveRoutingDecisionEvidence(run.id, "task-1", strategy.id, 1, decision);

    const retrieved = db.routingDecisionEvidence(run.id, "task-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.selectedRole).toBe("primary_coder");
  });

  it("should record budget ledger entries", () => {
    const strategy = createTestStrategy();
    db.saveStrategy(strategy);

    db.recordBudgetLedgerEntry({
      strategyId: strategy.id,
      type: "reserve",
      amountUsd: 10.0,
      reason: "Task planning"
    });

    db.recordBudgetLedgerEntry({
      strategyId: strategy.id,
      type: "charge",
      amountUsd: 5.0,
      reason: "Implementation",
      providerId: "anthropic",
      modelId: "claude-3.5-sonnet"
    });

    const ledger = db.budgetLedger(strategy.id);
    expect(ledger.length).toBeGreaterThanOrEqual(2);
    expect(ledger.some((e) => e.type === "reserve")).toBe(true);
    expect(ledger.some((e) => e.type === "charge")).toBe(true);
  });

  it("should manage budget reservations", () => {
    const strategy = createTestStrategy();
    db.saveStrategy(strategy);

    const run = {
      id: "run-001",
      workspacePath: "/test",
      repositoryIdentity: "repo",
      startingCommit: "abc123",
      state: "IMPLEMENTING" as const,
      finalStatus: null,
      originalPrompt: "test",
      approvedPrompt: "test",
      approvedRevision: 1,
      createdAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
      completedAt: null,
      retryCount: 0
    };
    db.createRun(run);

    // Reserve budget
    const reservationId = db.reserveBudget({
      runId: run.id,
      strategyId: strategy.id,
      amountUsd: 5.0,
      reason: "Task execution"
    });

    let active = db.activeBudgetReservations(run.id);
    expect(active).toHaveLength(1);
    expect(active[0].amountUsd).toBe(5.0);

    // Release reservation
    db.releaseBudgetReservation(reservationId);

    active = db.activeBudgetReservations(run.id);
    expect(active).toHaveLength(0);
  });

  it("should handle transactional strategy saves", () => {
    const strategy1 = createTestStrategy({ id: "s1" });
    const strategy2 = createTestStrategy({ id: "s2" });

    // Save both strategies - should be transactional
    db.saveStrategy(strategy1);
    db.saveStrategy(strategy2);

    const retrieved1 = db.strategy("s1");
    const retrieved2 = db.strategy("s2");

    expect(retrieved1).not.toBeNull();
    expect(retrieved2).not.toBeNull();
  });
});
