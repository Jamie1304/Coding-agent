import { createHash } from "node:crypto";
import type {
  BudgetConfig,
  DiscoveredModel,
  RoutingConfig,
  RoutingDecision,
  TaskDescriptor,
  TaskTier
} from "@agent/ai";

export interface RoutingContext {
  models: DiscoveredModel[];
  config: RoutingConfig;
  budget: BudgetConfig;
  spentToday: number;
  spentThisRun: number;
  providerHealth: Record<string, "healthy" | "rate_limited" | "outage" | "authentication">;
  performance: Record<string, { samples: number; successRate: number; averageLatencyMs: number }>;
  cacheKeys: Set<string>;
  cloudApproved: boolean;
}

export class TaskClassifier {
  classify(task: TaskDescriptor): TaskTier {
    let score = 0;
    score +=
      task.likelyFiles.length >= 12
        ? 4
        : task.likelyFiles.length >= 5
          ? 2
          : task.likelyFiles.length >= 2
            ? 1
            : 0;
    score +=
      task.expectedInputTokens > 100_000
        ? 3
        : task.expectedInputTokens > 25_000
          ? 2
          : task.expectedInputTokens > 5_000
            ? 1
            : 0;
    score += task.repositoryWrite ? 1 : 0;
    score += task.dependencies.length > 2 ? 2 : task.dependencies.length ? 1 : 0;
    score +=
      task.risk === "critical" ? 5 : task.risk === "high" ? 3 : task.risk === "medium" ? 1 : 0;
    if (
      /(migration|authentication|authorization|secret|production|architecture|concurrency)/i.test(
        task.description
      )
    )
      score += 3;
    return score >= 9
      ? "critical"
      : score >= 6
        ? "large"
        : score >= 3
          ? "medium"
          : score >= 1
            ? "small"
            : "trivial";
  }
}

export class ModelRouter {
  constructor(private readonly classifier = new TaskClassifier()) {}

  route(task: TaskDescriptor, context: RoutingContext): RoutingDecision {
    const tier = this.classifier.classify(task);
    const rejectedCandidates: RoutingDecision["rejectedCandidates"] = [];
    const candidates: Array<{
      model: DiscoveredModel;
      score: number;
      estimatedCost: number | null;
      reasons: string[];
    }> = [];
    const remainingRun =
      context.budget.perRunLimit === null
        ? Infinity
        : context.budget.perRunLimit - context.spentThisRun;
    const remainingDaily =
      context.budget.dailyLimit === null
        ? Infinity
        : context.budget.dailyLimit - context.spentToday;
    const strategy = context.config.strategy;
    const effectiveLocalOnly =
      context.config.localOnly || (strategy?.localOnly ?? false);
    const strategyMaximumCost = strategy?.maximumCost ?? Infinity;
    const preferredModelForRole = new Map<string, string>([
      [strategy?.plannerRole ?? "planning", strategy?.plannerModel ?? ""],
      [strategy?.primaryWorkerRole ?? "coding", strategy?.primaryWorkerModel ?? ""],
      [strategy?.testWorkerRole ?? "coding", strategy?.testWorkerModel ?? ""],
      [strategy?.runtimeAnalysisRole ?? "verification", strategy?.runtimeAnalysisModel ?? ""],
      [strategy?.independentReviewerRole ?? "code_review", strategy?.independentReviewerModel ?? ""]
    ]);
    const preferredModelId = preferredModelForRole.get(task.role);

    for (const model of context.models) {
      const rejected: string[] = [];
      if (!model.enabled) rejected.push("disabled");
      if (!model.available) rejected.push("unavailable");
      if (!model.roles.includes(task.role) && !model.roles.includes("fallback"))
        rejected.push("role_not_permitted");
      if (task.requiredTools && !model.supportsTools) rejected.push("tools_required");
      if (task.requiredVision && !model.supportsVision) rejected.push("vision_required");
      if (model.contextWindow !== null && model.contextWindow < task.expectedInputTokens)
        rejected.push("context_window");
      if (task.repositoryWrite && task.role !== "coding")
        rejected.push("repository_tooling_required");
      if ((effectiveLocalOnly || (task.sensitive && context.config.profile === "maximum_privacy")) && !model.local)
        rejected.push("privacy_local_only");
      if (!model.local && context.config.cloudRequiresApproval && !context.cloudApproved)
        rejected.push("cloud_approval_required");
      const health = context.providerHealth[model.providerId] ?? "healthy";
      if (health === "outage") rejected.push("provider_circuit_open");
      if (health === "authentication") rejected.push("provider_authentication_required");
      if (health === "rate_limited") rejected.push("provider_rate_limited");
      const estimatedCost = estimateModelCost(
        model,
        task.expectedInputTokens,
        task.expectedOutputTokens
      );
      const ceiling = Math.min(
        remainingRun,
        remainingDaily,
        context.budget.perTaskLimit ?? Infinity,
        model.maximumTaskCost ?? Infinity,
        strategyMaximumCost
      );
      if (estimatedCost !== null && estimatedCost > ceiling) rejected.push("budget_exceeded");
      if (rejected.length) {
        rejectedCandidates.push({
          providerId: model.providerId,
          modelId: model.modelId,
          reasons: rejected
        });
        continue;
      }

      const performance = context.performance[`${model.providerId}:${model.modelId}`];
      const learnedReliability =
        performance && performance.samples >= context.config.minimumLearningSamples
          ? performance.successRate
          : 0.75;
      const latency = performance?.averageLatencyMs ?? model.averageLatencyMs ?? 10_000;
      const capabilityScore =
        0.5 +
        (model.roles.includes(task.role) ? 0.3 : 0) +
        (tier === "critical" && model.roles.includes("frontier") ? 0.2 : 0);
      const costEfficiency = estimatedCost === null ? 0.4 : 1 / (1 + estimatedCost);
      const latencyScore = 1 / (1 + latency / 1_000);
      const cacheKey = stableCacheKey(task, model);
      const cacheBenefit = model.supportsCaching && context.cacheKeys.has(cacheKey) ? 1 : 0;
      const privacy = model.local ? 1 : task.sensitive ? 0 : 0.5;
      const weights = context.config.weights;
      let score =
        capabilityScore * weights.capability +
        learnedReliability * weights.reliability +
        latencyScore * weights.latency +
        costEfficiency * weights.cost +
        cacheBenefit * weights.cache +
        privacy * weights.privacy;
      const reasons = [
        `tier_${tier}`,
        `capability_${capabilityScore.toFixed(2)}`,
        `reliability_${learnedReliability.toFixed(2)}`,
        model.local ? "local_privacy" : "cloud_eligible",
        cacheBenefit ? "cache_hit_available" : "cache_miss"
      ];
      if (preferredModelId && model.modelId === preferredModelId) {
        score += 2;
        reasons.push("strategy_preferred_model");
      }
      if (strategy?.fallbackModels.includes(model.modelId)) {
        score += 0.5;
        reasons.push("strategy_fallback_candidate");
      }
      candidates.push({
        model,
        score,
        estimatedCost,
        reasons
      });
    }

    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        a.model.providerId.localeCompare(b.model.providerId) ||
        a.model.modelId.localeCompare(b.model.modelId)
    );
    const selected = candidates[0];
    if (!selected) {
      throw new Error(
        `No eligible model: ${rejectedCandidates
          .flatMap((candidate) => candidate.reasons)
          .filter((value, index, all) => all.indexOf(value) === index)
          .join(", ")}`
      );
    }
    const independent =
      (tier === "critical" && context.config.verification.criticalRequiresIndependent) ||
      (tier === "large" && context.config.verification.largeRequiresIndependent);
    return {
      selectedProviderId: selected.model.providerId,
      selectedModelId: selected.model.modelId,
      taskTier: tier,
      reasonCodes: selected.reasons,
      rejectedCandidates,
      estimatedInputTokens: task.expectedInputTokens,
      estimatedOutputTokens: task.expectedOutputTokens,
      estimatedCost: selected.estimatedCost,
      fallbackChain: candidates.slice(1, 4).map(({ model }) => ({
        providerId: model.providerId,
        modelId: model.modelId
      })),
      verificationPolicy: independent
        ? "independent"
        : tier === "trivial"
          ? "deterministic"
          : "self_check",
      parallelEligible: !task.repositoryWrite || task.likelyFiles.length > 0,
      strategyId: strategy?.id,
      strategyVersion: strategy?.version,
      strategyName: strategy?.name,
      strategyDescription: strategy?.description,
      strategyFallbackModels: strategy?.fallbackModels,
      strategyEscalationRules: strategy?.escalationRules
    };
  }
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const codeWeight = /[{}()[\];]|=>|function|class|const\s/.test(text) ? 3.2 : 4;
  return Math.ceil(text.length / codeWeight);
}

export function minimizeContext(
  files: Array<{ path: string; content: string; changed: boolean; relevant: boolean }>,
  maximumTokens: number
): { files: Array<{ path: string; content: string }>; estimatedTokens: number; omitted: string[] } {
  const ordered = [...files].sort(
    (a, b) =>
      Number(b.changed) - Number(a.changed) ||
      Number(b.relevant) - Number(a.relevant) ||
      a.path.localeCompare(b.path)
  );
  const selected: Array<{ path: string; content: string }> = [];
  const omitted: string[] = [];
  let estimatedTokens = 0;
  for (const file of ordered) {
    const tokens = estimateTokens(file.content);
    if (estimatedTokens + tokens > maximumTokens) omitted.push(file.path);
    else {
      selected.push({ path: file.path, content: file.content });
      estimatedTokens += tokens;
    }
  }
  return { files: selected, estimatedTokens, omitted };
}

export function stableCacheKey(
  task: TaskDescriptor,
  model: Pick<DiscoveredModel, "providerId" | "modelId">
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        providerId: model.providerId,
        modelId: model.modelId,
        role: task.role,
        description: task.description,
        files: [...task.likelyFiles].sort()
      })
    )
    .digest("hex");
}

function estimateModelCost(
  model: DiscoveredModel,
  inputTokens: number,
  outputTokens: number
): number | null {
  if (model.local) return 0;
  if (model.inputPricePerMillion === null || model.outputPricePerMillion === null) return null;
  return (
    (inputTokens / 1_000_000) * model.inputPricePerMillion +
    (outputTokens / 1_000_000) * model.outputPricePerMillion
  );
}
