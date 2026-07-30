import type { BudgetConfig, ModelUsage } from "@agent/ai";

export class BudgetLedger {
  private reservations = new Map<string, number>();
  private usages: Array<ModelUsage & { runId: string; taskId: string; timestamp: string }> = [];

  constructor(private config: BudgetConfig) {}

  update(config: BudgetConfig): void {
    this.config = config;
  }

  reserve(
    reservationId: string,
    amount: number,
    current: { today: number; month: number; run: number }
  ): void {
    if (amount < 0) throw new Error("Budget reservation cannot be negative");
    const reserved = [...this.reservations.values()].reduce((sum, value) => sum + value, 0);
    requireWithin("daily", this.config.dailyLimit, current.today + reserved + amount);
    requireWithin("monthly", this.config.monthlyLimit, current.month + reserved + amount);
    requireWithin("run", this.config.perRunLimit, current.run + reserved + amount);
    requireWithin("task", this.config.perTaskLimit, amount);
    this.reservations.set(reservationId, amount);
  }

  reconcile(
    reservationId: string,
    usage: ModelUsage,
    identity: { runId: string; taskId: string; timestamp?: string }
  ): void {
    this.reservations.delete(reservationId);
    this.usages.push({
      ...usage,
      runId: identity.runId,
      taskId: identity.taskId,
      timestamp: identity.timestamp ?? new Date().toISOString()
    });
  }

  release(reservationId: string): void {
    this.reservations.delete(reservationId);
  }

  summary(now = new Date()): {
    today: number;
    month: number;
    byProvider: Record<string, number>;
    byModel: Record<string, number>;
    cachedTokens: number;
    localTasks: number;
    cloudTasks: number;
  } {
    const day = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);
    const todayUsage = this.usages.filter((item) => item.timestamp.startsWith(day));
    const monthUsage = this.usages.filter((item) => item.timestamp.startsWith(month));
    const byProvider: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    for (const item of monthUsage) {
      const cost = item.actualCost ?? item.estimatedCost ?? 0;
      byProvider[item.providerId] = (byProvider[item.providerId] ?? 0) + cost;
      byModel[`${item.providerId}:${item.modelId}`] =
        (byModel[`${item.providerId}:${item.modelId}`] ?? 0) + cost;
    }
    return {
      today: sumCosts(todayUsage),
      month: sumCosts(monthUsage),
      byProvider,
      byModel,
      cachedTokens: monthUsage.reduce((sum, item) => sum + (item.cachedInputTokens ?? 0), 0),
      localTasks: monthUsage.filter((item) => (item.actualCost ?? item.estimatedCost) === 0).length,
      cloudTasks: monthUsage.filter((item) => (item.actualCost ?? item.estimatedCost ?? 0) > 0)
        .length
    };
  }
}

function requireWithin(name: string, limit: number | null, value: number): void {
  if (limit !== null && value > limit) throw new Error(`${name} budget exceeded`);
}

function sumCosts(
  items: Array<{ actualCost: number | null; estimatedCost: number | null }>
): number {
  return items.reduce((sum, item) => sum + (item.actualCost ?? item.estimatedCost ?? 0), 0);
}
