import { describe, it, expect, beforeEach } from "vitest";
import {
  BudgetAccountant,
  estimateTaskCost,
  estimateTaskCostWithBuffer,
  type BudgetContext
} from "@agent/core";
import type { RoutingStrategy, TaskDescriptor } from "@agent/shared";
import type { DiscoveredModel } from "@agent/ai";

describe("Budget Accounting - Reservations and Cost Tracking", () => {
  let accountant: BudgetAccountant;

  beforeEach(() => {
    accountant = new BudgetAccountant();
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
      roles: {},
      escalationRules: []
    };
  }

  function createTestTask(overrides: Partial<TaskDescriptor> = {}): TaskDescriptor {
    return {
      id: "task-1",
      runId: "run-1",
      title: "Test Task",
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

  function createBudgetContext(overrides: Partial<BudgetContext> = {}): BudgetContext {
    return {
      strategy: createTestStrategy(),
      runId: "run-1",
      totalBudget: 100.0,
      spent: 0,
      reserved: 0,
      ...overrides
    };
  }

  describe("Budget reservation", () => {
    it("should reserve budget when available", () => {
      const context = createBudgetContext();
      const task = createTestTask();
      const model = createTestModel();

      const reservation = accountant.reserve(context, task, model, 5.0);

      expect(reservation).not.toBeNull();
      expect(reservation?.reservationId).toBeDefined();
      expect(reservation?.status).toBe("reserved");
      expect(reservation?.estimatedCost).toBe(5.0);
      expect(reservation?.taskId).toBe(task.id);
    });

    it("should deny reservation when budget exceeded", () => {
      const context = createBudgetContext({ totalBudget: 10.0 });
      const task = createTestTask();
      const model = createTestModel();

      const reservation = accountant.reserve(context, task, model, 15.0);

      expect(reservation).toBeNull();
    });

    it("should track reserved amount against available budget", () => {
      const context = createBudgetContext({ totalBudget: 100.0, spent: 30.0, reserved: 40.0 });
      const task = createTestTask();
      const model = createTestModel();

      // Available: 100 - 30 (spent) - 40 (reserved) = 30
      const reservation = accountant.reserve(context, task, model, 30.0);
      expect(reservation).not.toBeNull();

      // Next reservation should fail
      const reservation2 = accountant.reserve(context, task, model, 1.0);
      expect(reservation2).toBeNull();
    });

    it("should record reservation in ledger", () => {
      const context = createBudgetContext();
      const task = createTestTask();
      const model = createTestModel();

      accountant.reserve(context, task, model, 5.0);

      const ledger = accountant.getLedgerByRun(context.runId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0].type).toBe("reservation");
      expect(ledger[0].amount).toBe(5.0);
    });
  });

  describe("Budget charging", () => {
    it("should charge reserved budget upon completion", () => {
      const context = createBudgetContext();
      const task = createTestTask();
      const model = createTestModel();

      const reservation = accountant.reserve(context, task, model, 5.0);
      expect(reservation).not.toBeNull();

      const result = accountant.charge(reservation!.reservationId, 4.0);

      expect(result).not.toBeNull();
      expect(result?.updatedReservation.status).toBe("charged");
      expect(result?.updatedReservation.actualCost).toBe(4.0);
      expect(result?.refund).toBe(1.0); // 5.0 - 4.0
    });

    it("should record charge in ledger", () => {
      const context = createBudgetContext();
      const task = createTestTask();
      const model = createTestModel();

      const reservation = accountant.reserve(context, task, model, 5.0);
      accountant.charge(reservation!.reservationId, 4.0, "Task completed");

      const ledger = accountant.getLedgerByRun(context.runId);
      expect(ledger.length).toBeGreaterThanOrEqual(2);
      expect(ledger.some((e) => e.type === "charge")).toBe(true);
    });

    it("should handle charge equal to reservation", () => {
      const context = createBudgetContext();
      const task = createTestTask();
      const model = createTestModel();

      const reservation = accountant.reserve(context, task, model, 5.0);
      const result = accountant.charge(reservation!.reservationId, 5.0);

      expect(result?.refund).toBe(0);
      expect(result?.updatedReservation.status).toBe("charged");
    });

    it("should handle charge exceeding reservation (allowed)", () => {
      const context = createBudgetContext();
      const task = createTestTask();
      const model = createTestModel();

      const reservation = accountant.reserve(context, task, model, 5.0);
      const result = accountant.charge(reservation!.reservationId, 6.0);

      expect(result).not.toBeNull();
      expect(result?.refund).toBe(0); // No refund when charge > reservation
      expect(result?.updatedReservation.actualCost).toBe(6.0);
    });

    it("should deny charge if already charged", () => {
      const context = createBudgetContext();
      const task = createTestTask();
      const model = createTestModel();

      const reservation = accountant.reserve(context, task, model, 5.0);
      accountant.charge(reservation!.reservationId, 4.0);

      const result = accountant.charge(reservation!.reservationId, 2.0);
      expect(result).toBeNull();
    });
  });

  describe("Budget refunds", () => {
    it("should refund difference when charge < reservation", () => {
      const context = createBudgetContext();
      const task = createTestTask();
      const model = createTestModel();

      const reservation = accountant.reserve(context, task, model, 5.0);
      accountant.charge(reservation!.reservationId, 3.0);

      const result = accountant.refund(reservation!.reservationId);
      expect(result?.amount).toBe(2.0);
      expect(result?.updatedReservation.status).toBe("refunded");
    });

    it("should record refund in ledger", () => {
      const context = createBudgetContext();
      const task = createTestTask();
      const model = createTestModel();

      const reservation = accountant.reserve(context, task, model, 5.0);
      accountant.charge(reservation!.reservationId, 3.0);
      accountant.refund(reservation!.reservationId);

      const ledger = accountant.getLedgerByRun(context.runId);
      expect(ledger.some((e) => e.type === "refund")).toBe(true);
    });

    it("should handle no refund when charge equals reservation", () => {
      const context = createBudgetContext();
      const task = createTestTask();
      const model = createTestModel();

      const reservation = accountant.reserve(context, task, model, 5.0);
      accountant.charge(reservation!.reservationId, 5.0);

      const result = accountant.refund(reservation!.reservationId);
      expect(result).toBeNull(); // No refund
    });
  });

  describe("Budget status tracking", () => {
    it("should calculate remaining budget", () => {
      const context = createBudgetContext({ totalBudget: 100.0, spent: 30.0, reserved: 0 });
      const task = createTestTask();
      const model = createTestModel();

      accountant.reserve(context, task, model, 40.0);

      const status = accountant.getRunBudgetStatus(context);
      expect(status.totalBudget).toBe(100.0);
      expect(status.spent).toBe(30.0);
      expect(status.reserved).toBe(40.0);
      expect(status.available).toBe(30.0); // 100 - 30 - 40
    });

    it("should calculate percent used", () => {
      const context = createBudgetContext({ totalBudget: 100.0, spent: 50.0 });

      const status = accountant.getRunBudgetStatus(context);
      expect(status.percentUsed).toBe(50);
    });

    it("should track multiple reservations", () => {
      const context = createBudgetContext({ totalBudget: 100.0 });
      const task1 = createTestTask({ id: "task-1" });
      const task2 = createTestTask({ id: "task-2" });
      const model = createTestModel();

      accountant.reserve(context, task1, model, 30.0);
      accountant.reserve(context, task2, model, 40.0);

      const status = accountant.getRunBudgetStatus(context);
      expect(status.reserved).toBe(70.0);
      expect(status.available).toBe(30.0);
    });
  });

  describe("Ledger tracking", () => {
    it("should record all transactions in order", () => {
      const context = createBudgetContext();
      const task = createTestTask();
      const model = createTestModel();

      const reservation = accountant.reserve(context, task, model, 5.0);
      accountant.charge(reservation!.reservationId, 4.0);
      accountant.recordAdjustment(context.runId, task.id, -1.0, "Manual adjustment");

      const ledger = accountant.getLedger();
      // Should have: 1 reservation + 1 charge + 1 refund (automatic) + 1 adjustment = 4 entries
      expect(ledger).toHaveLength(4);
      expect(ledger[0].type).toBe("reservation");
      expect(ledger[1].type).toBe("charge");
      expect(ledger[2].type).toBe("refund");
      expect(ledger[3].type).toBe("adjustment");
    });

    it("should filter ledger by run ID", () => {
      const context1 = createBudgetContext({ runId: "run-1" });
      const context2 = createBudgetContext({ runId: "run-2" });
      const task = createTestTask();
      const model = createTestModel();

      accountant.reserve(context1, task, model, 5.0);
      accountant.reserve(context2, task, model, 3.0);

      const ledger1 = accountant.getLedgerByRun("run-1");
      const ledger2 = accountant.getLedgerByRun("run-2");

      expect(ledger1).toHaveLength(1);
      expect(ledger2).toHaveLength(1);
    });

    it("should filter ledger by task ID", () => {
      const context = createBudgetContext();
      const task1 = createTestTask({ id: "task-1" });
      const task2 = createTestTask({ id: "task-2" });
      const model = createTestModel();

      accountant.reserve(context, task1, model, 5.0);
      accountant.reserve(context, task2, model, 3.0);

      const ledger1 = accountant.getLedgerByTask("task-1");
      const ledger2 = accountant.getLedgerByTask("task-2");

      expect(ledger1).toHaveLength(1);
      expect(ledger2).toHaveLength(1);
    });
  });

  describe("Reservation tracking", () => {
    it("should retrieve reservation by ID", () => {
      const context = createBudgetContext();
      const task = createTestTask();
      const model = createTestModel();

      const reservation = accountant.reserve(context, task, model, 5.0);
      const retrieved = accountant.getReservation(reservation!.reservationId);

      expect(retrieved?.reservationId).toBe(reservation?.reservationId);
      expect(retrieved?.estimatedCost).toBe(5.0);
    });

    it("should get reservations by run", () => {
      const context = createBudgetContext({ runId: "run-1" });
      const task1 = createTestTask({ id: "task-1" });
      const task2 = createTestTask({ id: "task-2" });
      const model = createTestModel();

      accountant.reserve(context, task1, model, 5.0);
      accountant.reserve(context, task2, model, 3.0);

      const reservations = accountant.getReservationsByRun("run-1");
      expect(reservations).toHaveLength(2);
    });

    it("should get reservations by task", () => {
      const context = createBudgetContext();
      const task = createTestTask({ id: "task-1" });
      const model1 = createTestModel({ modelId: "model-1" });
      const model2 = createTestModel({ modelId: "model-2" });

      accountant.reserve(context, task, model1, 5.0);
      accountant.reserve(context, task, model2, 3.0);

      const reservations = accountant.getReservationsByTask("task-1");
      expect(reservations).toHaveLength(2);
    });
  });

  describe("Cost estimation", () => {
    it("should estimate task cost", () => {
      const model = createTestModel({
        inputPricePerMillion: 3.0,
        outputPricePerMillion: 15.0
      });
      const task = createTestTask({
        expectedInputTokens: 10000,
        expectedOutputTokens: 2000
      });

      const cost = estimateTaskCost(model, task);

      const expectedInputCost = (10000 / 1_000_000) * 3.0;
      const expectedOutputCost = (2000 / 1_000_000) * 15.0;
      const expectedTotal = expectedInputCost + expectedOutputCost;

      expect(cost).toBeCloseTo(expectedTotal, 6);
    });

    it("should estimate cost with buffer", () => {
      const model = createTestModel({
        inputPricePerMillion: 3.0,
        outputPricePerMillion: 15.0
      });
      const task = createTestTask({
        expectedInputTokens: 10000,
        expectedOutputTokens: 2000
      });

      const baseCost = estimateTaskCost(model, task);
      const bufferedCost = estimateTaskCostWithBuffer(model, task, 20);

      expect(bufferedCost).toBeCloseTo(baseCost * 1.2, 6);
    });

    it("should handle missing pricing information", () => {
      const model = createTestModel({
        inputPricePerMillion: null,
        outputPricePerMillion: null
      });
      const task = createTestTask();

      const cost = estimateTaskCost(model, task);
      expect(cost).toBe(0); // Unknown cost
    });
  });

  describe("Clear and reset", () => {
    it("should clear all reservations and ledger", () => {
      const context = createBudgetContext();
      const task = createTestTask();
      const model = createTestModel();

      accountant.reserve(context, task, model, 5.0);
      accountant.recordAdjustment(context.runId, task.id, 1.0, "Test");

      accountant.clear();

      expect(accountant.getLedger()).toHaveLength(0);
      expect(accountant.getReservationsByRun(context.runId)).toHaveLength(0);
    });
  });
});
