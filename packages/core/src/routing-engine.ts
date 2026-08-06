import type {
  RoutingStrategy,
  TaskDescriptor,
  RoutingDecision,
  StrategyRole,
  RoleRoutingPolicy
} from "@agent/shared";
import type { DiscoveredModel } from "@agent/ai";

export interface RoutingContext {
  strategy: RoutingStrategy;
  task: TaskDescriptor;
  availableModels: DiscoveredModel[];
  budgetRemaining: number;
}

export interface RoutingCandidate {
  model: DiscoveredModel;
  score: number;
  evidence: string[];
  rejected: boolean;
  rejectionReason?: string;
}

export interface RoutingResult {
  selected: DiscoveredModel;
  candidates: RoutingCandidate[];
  evidence: {
    hardFiltersApplied: string[];
    scoringDetails: Record<string, number>;
    fallbackChain: Array<{ providerId: string; modelId: string }>;
  };
}

/**
 * Deterministic routing engine that selects the best model for a task based on strategy.
 *
 * Routing process:
 * 1. Apply hard filters (capability requirements, privacy constraints, cost limits)
 * 2. Score remaining candidates based on objective weights
 * 3. Break ties deterministically (provider ID, then model ID)
 * 4. Build fallback chain for retries
 */
export class RoutingEngine {
  route(context: RoutingContext): RoutingResult {
    const hardFilters = this.applyHardFilters(context);
    const candidates = hardFilters.map((model) => this.scoreCandidate(model, context));
    const ranked = candidates.sort((a, b) => b.score - a.score || this.tieBreaker(a.model, b.model));

    const selected = ranked[0];
    if (!selected || selected.rejected) {
      throw new Error("No eligible models available for routing decision");
    }

    return {
      selected: selected.model,
      candidates: ranked,
      evidence: {
        hardFiltersApplied: this.getHardFilterEvidence(context),
        scoringDetails: this.getScoringDetails(ranked[0], context),
        fallbackChain: this.buildFallbackChain(ranked)
      }
    };
  }

  private applyHardFilters(context: RoutingContext): DiscoveredModel[] {
    const { strategy, task, availableModels, budgetRemaining } = context;

    return availableModels.filter((model) => {
      // Filter 1: Model must be available and enabled
      if (!model.available || !model.enabled) return false;

      // Filter 2: Repository write requirement
      if (task.repositoryWrite && !model.supportsRepositoryWrite) {
        return false;
      }

      // Filter 3: Tool requirement
      if (task.requiredTools && !model.supportsTools) {
        return false;
      }

      // Filter 4: Vision requirement
      if (task.requiredVision && !model.supportsVision) {
        return false;
      }

      // Filter 5: Budget constraint (estimated cost < remaining budget)
      const estimatedCost = this.estimateCost(model, task);
      if (estimatedCost > budgetRemaining) {
        return false;
      }

      // Filter 6: Privacy constraint
      const privacyPolicy = strategy.privacyPolicy;
      if (privacyPolicy && task.sensitive) {
        // Sensitive tasks should only use local or no-training models
        if (
          privacyPolicy.minimumPrivacyLevel === "local-only" &&
          model.local !== true
        ) {
          return false;
        }
      }

      return true;
    });
  }

  private scoreCandidate(model: DiscoveredModel, context: RoutingContext): RoutingCandidate {
    const { strategy, task } = context;
    const objective = strategy.objective;

    const scores: Record<string, number> = {
      capability: this.scoreCapability(model, task),
      reliability: model.historicalSuccessRate ? model.historicalSuccessRate * 100 : 50,
      latency: this.scoreLatency(model),
      cost: this.scoreCost(model, task),
      privacy: this.scorePrivacy(model, task, strategy)
    };

    // Weight by objective profile
    const weights = this.getWeights(objective);
    const totalScore = Object.entries(scores).reduce((sum, [key, value]) => {
      const weight = weights[key as keyof typeof weights] || 1;
      return sum + value * weight;
    }, 0);

    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    const normalizedScore = totalWeight > 0 ? totalScore / totalWeight : 0;

    return {
      model,
      score: normalizedScore,
      evidence: this.buildScoringEvidence(model, scores, weights),
      rejected: false
    };
  }

  private scoreCapability(model: DiscoveredModel, task: TaskDescriptor): number {
    let score = 100;

    // Deduct for missing capabilities
    if (task.requiredTools && !model.supportsTools) score -= 50;
    if (task.requiredVision && !model.supportsVision) score -= 50;
    if (task.repositoryWrite && !model.supportsRepositoryWrite) score -= 50;

    // Add bonus for role match
    if (model.roles && model.roles.includes(task.role)) {
      score += 50;
    }

    // Deduct for known weaknesses
    if (model.weaknesses && model.weaknesses.length > 0) {
      score -= Math.min(30, model.weaknesses.length * 5);
    }

    return Math.max(0, Math.min(200, score));
  }

  private scoreLatency(model: DiscoveredModel): number {
    if (!model.averageLatencyMs) return 100;

    // Ideal is < 1000ms
    if (model.averageLatencyMs < 1000) return 100;
    if (model.averageLatencyMs < 3000) return 80;
    if (model.averageLatencyMs < 10000) return 60;
    return 40;
  }

  private scoreCost(model: DiscoveredModel, task: TaskDescriptor): number {
    if (!model.inputPricePerMillion || !model.outputPricePerMillion) {
      return 100; // Neutral score if cost unknown
    }

    const estimatedInputCost = (task.expectedInputTokens / 1_000_000) * model.inputPricePerMillion;
    const estimatedOutputCost =
      (task.expectedOutputTokens / 1_000_000) * model.outputPricePerMillion;
    const totalCost = estimatedInputCost + estimatedOutputCost;

    // Prefer < $0.10
    if (totalCost < 0.1) return 150;
    if (totalCost < 0.5) return 120;
    if (totalCost < 1.0) return 100;
    if (totalCost < 5.0) return 60;
    return 20;
  }

  private scorePrivacy(
    model: DiscoveredModel,
    task: TaskDescriptor,
    strategy: RoutingStrategy
  ): number {
    if (!task.sensitive) return 100;

    const privacyPolicy = strategy.privacyPolicy;
    if (!privacyPolicy) return 100;

    if (privacyPolicy.minimumPrivacyLevel === "local-only") {
      return model.local ? 150 : 0;
    }

    if (privacyPolicy.minimumPrivacyLevel === "remote-no-training") {
      return model.local ? 150 : 100;
    }

    return 100;
  }

  private getWeights(
    objective: typeof RoutingStrategy.prototype.objective
  ): Record<string, number> {
    return {
      capability: objective.qualityWeight,
      reliability: objective.reliabilityWeight,
      latency: objective.latencyWeight,
      cost: objective.costWeight,
      privacy: objective.privacyWeight
    };
  }

  private estimateCost(model: DiscoveredModel, task: TaskDescriptor): number {
    if (!model.inputPricePerMillion || !model.outputPricePerMillion) {
      return 0; // Conservative: assume free if unknown
    }

    const inputCost = (task.expectedInputTokens / 1_000_000) * model.inputPricePerMillion;
    const outputCost = (task.expectedOutputTokens / 1_000_000) * model.outputPricePerMillion;
    return inputCost + outputCost;
  }

  private tieBreaker(modelA: DiscoveredModel, modelB: DiscoveredModel): number {
    // Sort by provider ID, then model ID
    const providerCmp = modelA.providerId.localeCompare(modelB.providerId);
    if (providerCmp !== 0) return providerCmp;
    return modelA.modelId.localeCompare(modelB.modelId);
  }

  private buildFallbackChain(
    candidates: RoutingCandidate[]
  ): Array<{ providerId: string; modelId: string }> {
    return candidates
      .slice(0, 3) // Top 3 candidates
      .filter((c) => !c.rejected)
      .map((c) => ({
        providerId: c.model.providerId,
        modelId: c.model.modelId
      }));
  }

  private getHardFilterEvidence(context: RoutingContext): string[] {
    const evidence: string[] = [];
    const { task, strategy } = context;

    if (task.repositoryWrite) {
      evidence.push("Repository write required: filtering models with supportsRepositoryWrite=true");
    }
    if (task.requiredTools) {
      evidence.push("Tools required: filtering models with supportsTools=true");
    }
    if (task.requiredVision) {
      evidence.push("Vision required: filtering models with supportsVision=true");
    }
    if (task.sensitive && strategy.privacyPolicy?.minimumPrivacyLevel === "local-only") {
      evidence.push("Sensitive task with local-only privacy: filtering local models only");
    }

    return evidence;
  }

  private buildScoringEvidence(
    model: DiscoveredModel,
    scores: Record<string, number>,
    weights: Record<string, number>
  ): string[] {
    return Object.entries(scores).map(
      ([key, value]) =>
        `${key}: ${value.toFixed(1)} (weight: ${weights[key]?.toFixed(1) || "0"})`
    );
  }

  private getScoringDetails(
    candidate: RoutingCandidate,
    context: RoutingContext
  ): Record<string, number> {
    const details: Record<string, number> = {
      finalScore: candidate.score
    };

    if (context.strategy.objective) {
      const obj = context.strategy.objective;
      details.qualityWeight = obj.qualityWeight;
      details.costWeight = obj.costWeight;
      details.reliabilityWeight = obj.reliabilityWeight;
      details.latencyWeight = obj.latencyWeight;
      details.privacyWeight = obj.privacyWeight;
    }

    return details;
  }
}
