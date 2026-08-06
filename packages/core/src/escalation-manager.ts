import type { RoutingStrategy, TaskDescriptor } from "@agent/shared";
import type { DiscoveredModel } from "@agent/ai";

export interface EscalationTrigger {
  type:
    | "repeated_error"
    | "timeout"
    | "budget_exceeded"
    | "quality_threshold"
    | "permission_denied"
    | "rate_limit";
  threshold: number;
  consecutiveOccurrences?: number;
}

export interface ReviewConfig {
  requiresReview: boolean;
  reviewers: string[];
  maxReviewTimeMs: number;
  requiresApproval: boolean;
}

export interface EscalationContext {
  taskId: string;
  runId: string;
  model: DiscoveredModel;
  errorType: string;
  errorCount: number;
  cost: number;
  budget: number;
  risk: "low" | "medium" | "high";
}

/**
 * Escalation and independent review system for task failures and sensitive decisions.
 *
 * Workflow:
 * 1. Monitor task execution for escalation triggers
 * 2. Determine if escalation is needed based on error type and count
 * 3. Initiate secondary review if required
 * 4. Apply release gates to sensitive operations
 * 5. Track escalation evidence for audit
 */
export class EscalationManager {
  private escalations: Map<string, EscalationContext> = new Map();
  private reviewQueue: Map<string, ReviewConfig> = new Map();

  shouldEscalate(
    context: EscalationContext,
    strategy: RoutingStrategy
  ): { shouldEscalate: boolean; reason: string } {
    // Check error count threshold
    if (context.errorCount > 3) {
      return { shouldEscalate: true, reason: `Error count (${context.errorCount}) exceeded threshold` };
    }

    // Check budget overflow
    if (context.cost > context.budget) {
      return {
        shouldEscalate: true,
        reason: `Cost $${context.cost.toFixed(2)} exceeds budget $${context.budget.toFixed(2)}`
      };
    }

    // Check risk level
    if (context.risk === "high" && context.errorCount >= 2) {
      return { shouldEscalate: true, reason: "High risk task with repeated errors" };
    }

    // Check permission errors
    if (context.errorType === "permission_denied") {
      return { shouldEscalate: true, reason: "Permission denied - requires review" };
    }

    return { shouldEscalate: false, reason: "" };
  }

  requestReview(
    escalationId: string,
    context: EscalationContext,
    strategy: RoutingStrategy,
    reason: string
  ): ReviewConfig {
    // Determine review requirements from escalation rules
    const reviewers = this.selectReviewers(context, strategy);

    const reviewConfig: ReviewConfig = {
      requiresReview: true,
      reviewers,
      maxReviewTimeMs: 300000, // 5 minutes default
      requiresApproval: context.risk === "high"
    };

    this.reviewQueue.set(escalationId, reviewConfig);
    this.escalations.set(escalationId, context);

    return reviewConfig;
  }

  approveReview(escalationId: string, reviewedBy: string): boolean {
    const review = this.reviewQueue.get(escalationId);
    if (!review) return false;

    // Check if reviewer is authorized
    if (!review.reviewers.includes(reviewedBy)) {
      return false;
    }

    this.reviewQueue.delete(escalationId);
    return true;
  }

  rejectReview(escalationId: string, reviewedBy: string, reason: string): boolean {
    const review = this.reviewQueue.get(escalationId);
    if (!review) return false;

    if (!review.reviewers.includes(reviewedBy)) {
      return false;
    }

    this.reviewQueue.delete(escalationId);
    return true;
  }

  getEscalationStatus(escalationId: string): {
    isEscalated: boolean;
    isPending: boolean;
    context?: EscalationContext;
    review?: ReviewConfig;
  } {
    const context = this.escalations.get(escalationId);
    const review = this.reviewQueue.get(escalationId);

    return {
      isEscalated: context !== undefined,
      isPending: review !== undefined,
      context,
      review
    };
  }

  recordEscalation(
    escalationId: string,
    context: EscalationContext,
    reason: string
  ): void {
    this.escalations.set(escalationId, context);
  }

  getPendingReviews(): Array<{ escalationId: string; config: ReviewConfig; context: EscalationContext }> {
    const pending: Array<{ escalationId: string; config: ReviewConfig; context: EscalationContext }> = [];

    for (const [escalationId, config] of this.reviewQueue) {
      const context = this.escalations.get(escalationId);
      if (context) {
        pending.push({ escalationId, config, context });
      }
    }

    return pending;
  }

  private selectReviewers(
    context: EscalationContext,
    strategy: RoutingStrategy
  ): string[] {
    const reviewers: Set<string> = new Set();

    // Add default reviewers for high-risk tasks
    if (context.risk === "high") {
      reviewers.add("senior_reviewer");
      reviewers.add("security_reviewer");
    }

    // Add reviewers from escalation rules
    for (const rule of strategy.escalationRules) {
      if (this.ruleMatchesContext(rule, context)) {
        const ruleReviewers = (rule as any).reviewers || [];
        ruleReviewers.forEach((r: string) => reviewers.add(r));
      }
    }

    // Ensure at least one reviewer is available
    if (reviewers.size === 0) {
      // Add default reviewer for escalations
      reviewers.add("general_reviewer");
    }

    // Ensure reviewer diversity (no single reviewer can approve if high-risk)
    if (context.risk === "high" && reviewers.size < 2) {
      reviewers.add("independent_reviewer");
    }

    return Array.from(reviewers);
  }

  private ruleMatchesContext(rule: any, context: EscalationContext): boolean {
    // Simple rule matching
    if (rule.triggerType === context.errorType) {
      if (rule.threshold && context.errorCount >= rule.threshold) {
        return true;
      }
    }
    return false;
  }

  clear(): void {
    this.escalations.clear();
    this.reviewQueue.clear();
  }
}

/**
 * Helper to determine if a decision requires release approval
 */
export function requiresReleaseApproval(
  strategy: RoutingStrategy,
  task: TaskDescriptor,
  model: DiscoveredModel
): boolean {
  // Repository writes always require approval
  if (task.repositoryWrite) {
    return true;
  }

  // High-risk tasks require approval
  if (task.risk === "high") {
    return true;
  }

  // Sensitive tasks require approval
  if (task.sensitive) {
    return true;
  }

  return false;
}

/**
 * Helper to get release gate configuration
 */
export function getReleaseGateConfig(strategy: RoutingStrategy): {
  gateEnabled: boolean;
  approverRole: string;
  timeoutMs: number;
} {
  const releasePolicy = strategy.releasePolicy as any;

  return {
    gateEnabled: (releasePolicy?.enabled ?? false) as boolean,
    approverRole: (releasePolicy?.approverRole ?? "release_manager") as string,
    timeoutMs: (releasePolicy?.approvalTimeoutMs ?? 600000) as number // 10 minutes default
  };
}
