import type { RoutingStrategy, TaskDescriptor } from "@agent/shared";
import type { DiscoveredModel } from "@agent/ai";

export interface BudgetReservation {
  reservationId: string;
  taskId: string;
  runId: string;
  model: DiscoveredModel;
  estimatedCost: number;
  status: "reserved" | "charged" | "refunded" | "expired";
  createdAt: string;
  chargedAt?: string;
  refundedAt?: string;
  actualCost?: number;
}

export interface BudgetLedgerEntry {
  entryId: string;
  runId: string;
  taskId?: string;
  type: "reservation" | "charge" | "refund" | "adjustment";
  amount: number;
  description: string;
  timestamp: string;
}

export interface BudgetContext {
  strategy: RoutingStrategy;
  runId: string;
  totalBudget: number;
  spent: number;
  reserved: number;
}

/**
 * Budget accounting system for tracking, reserving, and enforcing budget constraints.
 *
 * Workflow:
 * 1. Reserve budget before task execution (pessimistic estimate)
 * 2. Execute task with selected model
 * 3. Charge actual cost upon completion
 * 4. Refund difference if actual cost < reservation
 * 5. Track full audit trail in ledger
 */
export class BudgetAccountant {
  private reservations: Map<string, BudgetReservation> = new Map();
  private ledger: BudgetLedgerEntry[] = [];

  reserve(
    context: BudgetContext,
    task: TaskDescriptor,
    model: DiscoveredModel,
    estimatedCost: number
  ): BudgetReservation | null {
    // Calculate total available budget (context.reserved is pre-existing, plus our current reservations)
    const ourReserved = Array.from(this.reservations.values())
      .filter((r) => r.runId === context.runId && r.status === "reserved")
      .reduce((sum, r) => sum + r.estimatedCost, 0);

    const totalReserved = context.reserved + ourReserved;
    const available = context.totalBudget - context.spent - totalReserved;

    if (estimatedCost > available) {
      return null; // Budget unavailable
    }

    const reservation: BudgetReservation = {
      reservationId: this.generateId(),
      taskId: task.id,
      runId: context.runId,
      model,
      estimatedCost,
      status: "reserved",
      createdAt: new Date().toISOString()
    };

    this.reservations.set(reservation.reservationId, reservation);

    // Log to ledger
    this.recordLedgerEntry(
      context.runId,
      task.id,
      "reservation",
      estimatedCost,
      `Reserved ${estimatedCost.toFixed(4)} for task ${task.id} on ${model.providerId}/${model.modelId}`
    );

    return reservation;
  }

  charge(
    reservationId: string,
    actualCost: number,
    description?: string
  ): { refund: number; updatedReservation: BudgetReservation } | null {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return null;

    if (reservation.status !== "reserved") {
      return null; // Already charged or refunded
    }

    const refund = Math.max(0, reservation.estimatedCost - actualCost);

    reservation.status = "charged";
    reservation.chargedAt = new Date().toISOString();
    reservation.actualCost = actualCost;

    // Log charge to ledger
    this.recordLedgerEntry(
      reservation.runId,
      reservation.taskId,
      "charge",
      actualCost,
      description || `Charged ${actualCost.toFixed(4)} for task ${reservation.taskId}`
    );

    // Log refund separately if applicable (but don't change status to refunded)
    if (refund > 0) {
      this.recordLedgerEntry(
        reservation.runId,
        reservation.taskId,
        "refund",
        refund,
        `Refunded ${refund.toFixed(4)} for task ${reservation.taskId}`
      );
    }

    return { refund, updatedReservation: reservation };
  }

  refund(reservationId: string): { amount: number; updatedReservation: BudgetReservation } | null {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return null;

    const refundAmount = Math.max(0, reservation.estimatedCost - (reservation.actualCost || 0));

    if (refundAmount <= 0) {
      return null; // Nothing to refund
    }

    reservation.status = "refunded";
    reservation.refundedAt = new Date().toISOString();

    // Log refund to ledger
    this.recordLedgerEntry(
      reservation.runId,
      reservation.taskId,
      "refund",
      refundAmount,
      `Refunded ${refundAmount.toFixed(4)} for task ${reservation.taskId}`
    );

    return { amount: refundAmount, updatedReservation: reservation };
  }

  getReservation(reservationId: string): BudgetReservation | null {
    return this.reservations.get(reservationId) || null;
  }

  getReservationsByRun(runId: string): BudgetReservation[] {
    return Array.from(this.reservations.values()).filter((r) => r.runId === runId);
  }

  getReservationsByTask(taskId: string): BudgetReservation[] {
    return Array.from(this.reservations.values()).filter((r) => r.taskId === taskId);
  }

  getRunBudgetStatus(
    context: BudgetContext
  ): {
    totalBudget: number;
    spent: number;
    reserved: number;
    available: number;
    percentUsed: number;
  } {
    const reservations = this.getReservationsByRun(context.runId);
    const currentReserved = reservations
      .filter((r) => r.status === "reserved")
      .reduce((sum, r) => sum + r.estimatedCost, 0);

    return {
      totalBudget: context.totalBudget,
      spent: context.spent,
      reserved: currentReserved,
      available: context.totalBudget - context.spent - currentReserved,
      percentUsed: (context.spent / context.totalBudget) * 100
    };
  }

  getLedger(): BudgetLedgerEntry[] {
    return [...this.ledger];
  }

  getLedgerByRun(runId: string): BudgetLedgerEntry[] {
    return this.ledger.filter((e) => e.runId === runId);
  }

  getLedgerByTask(taskId: string): BudgetLedgerEntry[] {
    return this.ledger.filter((e) => e.taskId === taskId);
  }

  recordAdjustment(
    runId: string,
    taskId: string | undefined,
    amount: number,
    description: string
  ): void {
    this.recordLedgerEntry(runId, taskId, "adjustment", amount, description);
  }

  private recordLedgerEntry(
    runId: string,
    taskId: string | undefined,
    type: "reservation" | "charge" | "refund" | "adjustment",
    amount: number,
    description: string
  ): void {
    const entry: BudgetLedgerEntry = {
      entryId: this.generateId(),
      runId,
      taskId,
      type,
      amount,
      description,
      timestamp: new Date().toISOString()
    };

    this.ledger.push(entry);
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  clear(): void {
    this.reservations.clear();
    this.ledger = [];
  }
}

/**
 * Helper to estimate cost for a task on a model
 */
export function estimateTaskCost(model: DiscoveredModel, task: TaskDescriptor): number {
  if (!model.inputPricePerMillion || !model.outputPricePerMillion) {
    return 0; // Unknown cost
  }

  const inputCost = (task.expectedInputTokens / 1_000_000) * model.inputPricePerMillion;
  const outputCost = (task.expectedOutputTokens / 1_000_000) * model.outputPricePerMillion;

  return inputCost + outputCost;
}

/**
 * Helper to estimate cost with budget policy buffer
 */
export function estimateTaskCostWithBuffer(
  model: DiscoveredModel,
  task: TaskDescriptor,
  bufferPercent: number = 20
): number {
  const baseCost = estimateTaskCost(model, task);
  return baseCost * (1 + bufferPercent / 100);
}
