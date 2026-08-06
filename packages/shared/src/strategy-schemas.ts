import { z } from "zod";

/**
 * Multi-provider orchestration strategy schemas.
 *
 * These schemas define the contract for AI provider routing strategies, including:
 * - Role assignments and fallback chains
 * - Budget controls and cost accounting
 * - Privacy and context policies
 * - Escalation and verification rules
 * - Serialization and versioning
 *
 * Strategies are versioned and immutable. Editing creates a new draft version;
 * activation is transactional and explicit.
 */

// ============================================================================
// Objective and weighting
// ============================================================================

export const ObjectiveProfileSchema = z.enum([
  "maximum-savings",
  "balanced",
  "maximum-quality",
  "maximum-privacy",
  "custom"
]);
export type ObjectiveProfile = z.infer<typeof ObjectiveProfileSchema>;

export const ObjectiveSchema = z.object({
  profile: ObjectiveProfileSchema,
  costWeight: z.number().min(0).max(10).default(2),
  qualityWeight: z.number().min(0).max(10).default(4),
  reliabilityWeight: z.number().min(0).max(10).default(2),
  latencyWeight: z.number().min(0).max(10).default(1),
  privacyWeight: z.number().min(0).max(10).default(2)
});
export type Objective = z.infer<typeof ObjectiveSchema>;

// ============================================================================
// Budget control
// ============================================================================

export const MoneyLimitSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().length(3).default("USD"),
  minimumRunThreshold: z.number().nonnegative().nullable().default(null),
  stopIfExceeded: z.boolean().default(false)
});
export type MoneyLimit = z.infer<typeof MoneyLimitSchema>;

export const BudgetsSchema = z.object({
  perTask: MoneyLimitSchema.nullable().default(null),
  perRun: MoneyLimitSchema.nullable().default(null),
  perDay: MoneyLimitSchema.nullable().default(null),
  perMonth: MoneyLimitSchema.nullable().default(null),
  warningThresholdPercent: z.number().min(1).max(100).default(80),
  reserveForFallbackPercent: z.number().min(0).max(50).default(10)
});
export type Budgets = z.infer<typeof BudgetsSchema>;

// ============================================================================
// Context and caching policy
// ============================================================================

export const ContextPolicySchema = z.object({
  maximumInputTokens: z.number().int().positive().nullable().default(null),
  includeMasterSpecification: z.enum(["reference", "summary", "full"]).default("summary"),
  changedFilesFirst: z.boolean().default(true),
  relevantFilesOnly: z.boolean().default(true),
  includeSuccessfulLogs: z.boolean().default(false),
  maximumLogExcerptBytes: z.number().int().positive().nullable().default(10_000),
  preserveStableCachePrefix: z.boolean().default(true)
});
export type ContextPolicy = z.infer<typeof ContextPolicySchema>;

// ============================================================================
// Retry and escalation policy
// ============================================================================

export const RetryPolicySchema = z.object({
  maximumAttemptsPerTask: z.number().int().min(1).max(10).default(3),
  maximumAttemptsPerRoute: z.number().int().min(1).max(5).default(2),
  requireImprovementEvidence: z.boolean().default(true),
  stopOnRepeatedErrorFingerprint: z.boolean().default(true)
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const EscalationRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).default("Escalation Rule"),
  description: z.string().default(""),
  enabled: z.boolean().default(true),
  conditions: z.object({
    attemptCount: z.number().int().min(1).nullable().default(null),
    repeatedErrorFingerprint: z.boolean().default(false),
    noTestImprovement: z.boolean().default(false),
    taskComplexity: z.enum(["trivial", "small", "medium", "large", "critical"]).nullable().default(null),
    taskRisk: z.enum(["low", "medium", "high", "critical"]).nullable().default(null),
    securitySensitivity: z.boolean().default(false),
    migrationInvolved: z.boolean().default(false),
    providerUnavailable: z.boolean().default(false),
    budgetRemaining: z.number().nonnegative().nullable().default(null)
  }).default({}),
  targetRole: z.string().min(1),
  fallbackChain: z.array(z.string()).default([])
});
export type EscalationRule = z.infer<typeof EscalationRuleSchema>;

// ============================================================================
// Parallel execution policy
// ============================================================================

export const ParallelPolicySchema = z.object({
  enabled: z.boolean().default(true),
  maximumWorkers: z.number().int().min(1).max(16).default(3),
  maximumWorkersPerProvider: z.record(z.string(), z.number().int().positive()).default({}),
  requireDeclaredFileOwnership: z.boolean().default(true),
  serializeIntegration: z.boolean().default(true),
  serializeDeployment: z.boolean().default(true)
});
export type ParallelPolicy = z.infer<typeof ParallelPolicySchema>;

// ============================================================================
// Privacy policy
// ============================================================================

export const PrivacyModeSchema = z.enum(["standard", "privacy-preferred", "maximum-privacy"]);
export type PrivacyMode = z.infer<typeof PrivacyModeSchema>;

export const PrivacyPolicySchema = z.object({
  defaultMode: PrivacyModeSchema.default("standard"),
  sensitiveTaskCloudPolicy: z.enum(["deny", "require-run-approval"]).default("deny"),
  permittedProviderLocations: z.array(z.enum(["local", "cloud", "enterprise"])).default(["local", "cloud"]),
  redactBeforeProviderTransmission: z.boolean().default(true),
  allowProprietaryCodeOffDevice: z.boolean().default(false)
});
export type PrivacyPolicy = z.infer<typeof PrivacyPolicySchema>;

// ============================================================================
// Verification and release policy
// ============================================================================

export const VerificationPolicySchema = z.object({
  requireDeterministicTests: z.boolean().default(true),
  requireFormattingAndLinting: z.boolean().default(true),
  requireTypeChecking: z.boolean().default(true),
  requireSecurityScan: z.boolean().default(false),
  requireDependencyAudit: z.boolean().default(false),
  requireBuildSuccess: z.boolean().default(true),
  criticalTaskRequiresIndependent: z.boolean().default(true),
  largeTaskRequiresIndependent: z.boolean().default(false),
  independentReviewMustBeDifferentProvider: z.boolean().default(true),
  minimumIndependentReviewSampleSize: z.number().int().min(1).default(10)
});
export type VerificationPolicy = z.infer<typeof VerificationPolicySchema>;

export const ReleasePolicySchema = z.object({
  criticalTaskRequiresReleaseJudge: z.boolean().default(true),
  authenticationChangeRequiresReleaseJudge: z.boolean().default(true),
  databaseMigrationRequiresReleaseJudge: z.boolean().default(true),
  deploymentChangeRequiresReleaseJudge: z.boolean().default(false),
  architectureChangeRequiresReleaseJudge: z.boolean().default(false),
  releaseJudgeMayNotBypassFailedTests: z.boolean().default(true),
  releaseJudgeMayNotBypassSecurityGates: z.boolean().default(true)
});
export type ReleasePolicy = z.infer<typeof ReleasePolicySchema>;

// ============================================================================
// Role and fallback policy
// ============================================================================

export const StrategyRoleSchema = z.enum([
  "task_classifier",
  "master_planner",
  "repository_inventory_analyst",
  "documentation_researcher",
  "context_selector",
  "primary_coder",
  "complex_coding_specialist",
  "hard_debugging_specialist",
  "large_mechanical_change_worker",
  "test_generator",
  "test_log_classifier",
  "independent_reviewer",
  "ui_screenshot_reviewer",
  "security_reviewer",
  "release_judge",
  "local_private_worker"
]);
export type StrategyRole = z.infer<typeof StrategyRoleSchema>;

export const RoleRoutingPolicySchema = z.object({
  enabled: z.boolean().default(true),
  role: StrategyRoleSchema,
  description: z.string().default(""),

  // Candidates and eligibility
  preferredProviders: z.array(z.string()).default([]),
  allowedProviders: z.array(z.string()).default([]),
  deniedProviders: z.array(z.string()).default([]),

  // Capability requirements
  requiredCapabilities: z
    .object({
      tools: z.boolean().default(false),
      vision: z.boolean().default(false),
      structuredOutput: z.boolean().default(false),
      streaming: z.boolean().default(false),
      caching: z.boolean().default(false),
      repositoryWrite: z.boolean().default(false)
    })
    .default({ tools: false, vision: false, structuredOutput: false, streaming: false, caching: false, repositoryWrite: false }),

  // Context constraints
  minimumContextSize: z.number().int().nonnegative().default(0),
  maximumLatencyMs: z.number().int().positive().nullable().default(null),

  // Cost and budgets
  maximumEstimatedCost: z.number().nonnegative().nullable().default(null),
  qualityWeight: z.number().min(0).max(10).default(4),
  costWeight: z.number().min(0).max(10).default(2),
  reliabilityWeight: z.number().min(0).max(10).default(2),
  latencyWeight: z.number().min(0).max(10).default(1),

  // Fallback chain
  fallbackChain: z.array(z.string()).default([]),
  usesSameProviderForReview: z.boolean().default(false),
  minimumReliabilitySampleThreshold: z.number().int().min(1).default(10)
});
export type RoleRoutingPolicy = z.infer<typeof RoleRoutingPolicySchema>;

// ============================================================================
// Generation metadata
// ============================================================================

export const StrategyGenerationMetadataSchema = z.object({
  generatedAt: z.string().datetime(),
  generatedBy: z.enum(["user", "ai", "migration", "system"]),
  generatorModel: z.string().nullable().default(null),
  generatorProvider: z.string().nullable().default(null),
  generationCost: z.number().nonnegative().nullable().default(null),
  userInputProfile: z
    .object({
      workload: z.string().nullable().default(null),
      primaryLanguages: z.array(z.string()).default([]),
      repositorySize: z.enum(["small", "medium", "large", "monorepo"]).nullable().default(null),
      monthlyTaskVolume: z.number().int().positive().nullable().default(null),
      maxPerTaskSpend: z.number().nonnegative().nullable().default(null),
      maxPerRunSpend: z.number().nonnegative().nullable().default(null),
      dailyMaxSpend: z.number().nonnegative().nullable().default(null),
      monthlyMaxSpend: z.number().nonnegative().nullable().default(null),
      requiredPrivacy: PrivacyModeSchema.nullable().default(null),
      allowedCloudProviders: z.array(z.string()).default([])
    })
    .default({}),
  providerSnapshot: z
    .array(
      z.object({
        providerId: z.string(),
        models: z.array(z.string()),
        capabilities: z.record(z.boolean())
      })
    )
    .default([]),
  simulationResults: z
    .array(
      z.object({
        taskType: z.string(),
        selectedRole: z.string(),
        estimatedCost: z.number().nonnegative().nullable(),
        estimatedLatencyMs: z.number().int().nonnegative().nullable()
      })
    )
    .default([])
});
export type StrategyGenerationMetadata = z.infer<typeof StrategyGenerationMetadataSchema>;

// ============================================================================
// Complete strategy
// ============================================================================

export const RoutingStrategySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().default(""),

  // Versioning and status
  version: z.number().int().positive().default(1),
  status: z.enum(["draft", "active", "archived"]).default("draft"),
  scope: z.enum(["global", "project"]).default("global"),
  projectPathReference: z.string().nullable().default(null),

  // Lifecycle
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  activatedAt: z.string().datetime().nullable().default(null),
  archivedAt: z.string().datetime().nullable().default(null),
  createdBy: z.enum(["user", "ai", "migration", "system"]).default("user"),

  // Inheritance and generation
  basedOnStrategyId: z.string().nullable().default(null),
  generationMetadata: StrategyGenerationMetadataSchema.nullable().default(null),

  // Core policies
  objective: ObjectiveSchema.default({ profile: "balanced", costWeight: 2, qualityWeight: 4, reliabilityWeight: 2, latencyWeight: 1, privacyWeight: 2 }),
  budgets: BudgetsSchema.default({}),
  contextPolicy: ContextPolicySchema.default({}),
  retryPolicy: RetryPolicySchema.default({}),
  parallelPolicy: ParallelPolicySchema.default({}),
  privacyPolicy: PrivacyPolicySchema.default({}),
  verificationPolicy: VerificationPolicySchema.default({}),
  releasePolicy: ReleasePolicySchema.default({}),

  // Role assignments (optional - not all roles need to be assigned)
  roles: z.record(z.string(), RoleRoutingPolicySchema).default({}),

  // Escalation
  escalationRules: z.array(EscalationRuleSchema).default([])
});
export type RoutingStrategy = z.infer<typeof RoutingStrategySchema>;

// ============================================================================
// Routing decision evidence
// ============================================================================

export const TaskDescriptorSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  complexity: z.enum(["trivial", "small", "medium", "large", "critical"]),
  readOnly: z.boolean().default(false),
  securitySensitive: z.boolean().default(false),
  privacySensitive: z.boolean().default(false),
  requiredTools: z.boolean().default(false),
  requiredVision: z.boolean().default(false),
  requiredStructuredOutput: z.boolean().default(false),
  estimatedInputTokens: z.number().int().nonnegative(),
  estimatedOutputTokens: z.number().int().nonnegative(),
  expectedFiles: z.array(z.string()).default([]),
  riskLevel: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  expectedVerificationType: z.enum(["deterministic", "manual", "independent"]).default("deterministic"),
  parallelEligible: z.boolean().default(true),
  description: z.string().default("")
});
export type TaskDescriptor = z.infer<typeof TaskDescriptorSchema>;

export const RoutingDecisionSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime(),
  strategyId: z.string().min(1),
  strategyVersion: z.number().int().positive(),
  taskDescriptor: TaskDescriptorSchema,

  // Selection
  selectedRole: StrategyRoleSchema,
  selectedProviderId: z.string().min(1),
  selectedModelId: z.string().min(1),

  // Alternatives
  eligibleCandidates: z
    .array(
      z.object({
        providerId: z.string(),
        modelId: z.string(),
        score: z.number(),
        reasons: z.array(z.string())
      })
    )
    .default([]),
  rejectedCandidates: z
    .array(
      z.object({
        providerId: z.string(),
        modelId: z.string(),
        rejectionReasons: z.array(z.string())
      })
    )
    .default([]),

  // Scoring details
  scoreBreakdown: z
    .object({
      capability: z.number().min(0).max(10),
      reliability: z.number().min(0).max(10),
      latency: z.number().min(0).max(10),
      cost: z.number().min(0).max(10),
      cache: z.number().min(0).max(10),
      privacy: z.number().min(0).max(10),
      total: z.number().nonnegative()
    })
    .nullable()
    .default(null),

  // Cost estimation
  estimatedInputTokens: z.number().int().nonnegative().nullable().default(null),
  estimatedOutputTokens: z.number().int().nonnegative().nullable().default(null),
  estimatedCost: z.number().nonnegative().nullable().default(null),
  estimatedLatencyMs: z.number().int().nonnegative().nullable().default(null),

  // Fallback and escalation
  fallbackChain: z.array(z.string()).default([]),
  escalationRulesApplied: z.array(z.string()).default([]),

  // Policies
  privacyDecision: z.string().default("standard"),
  budgetCheck: z
    .object({
      perTaskRemainingBudget: z.number().nonnegative().nullable().default(null),
      perRunRemainingBudget: z.number().nonnegative().nullable().default(null),
      dailyRemainingBudget: z.number().nonnegative().nullable().default(null),
      monthlyRemainingBudget: z.number().nonnegative().nullable().default(null),
      allChecksPassed: z.boolean().default(true)
    })
    .default({}),

  // Verification
  verificationRequired: z.boolean().default(true),
  independentReviewRequired: z.boolean().default(false),
  releaseJudgeRequired: z.boolean().default(false),
  parallelEligible: z.boolean().default(true),

  // Meta
  requiresExplicitApproval: z.boolean().default(false),
  correlationId: z.string().min(1),
  userRequestedCloudApproval: z.boolean().default(false)
});
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

// ============================================================================
// Strategy comparison and simulation
// ============================================================================

export const StrategySimulationSchema = z.object({
  id: z.string().min(1),
  strategyId: z.string().min(1),
  createdAt: z.string().datetime(),
  taskSamples: z.array(TaskDescriptorSchema),
  results: z.array(
    z.object({
      taskId: z.string(),
      selectedRole: StrategyRoleSchema,
      selectedProviderId: z.string(),
      selectedModelId: z.string(),
      estimatedCost: z.number().nonnegative().nullable(),
      estimatedLatencyMs: z.number().int().nonnegative().nullable(),
      fallbacksNeeded: z.number().int().nonnegative(),
      independentReviewUsed: z.boolean()
    })
  ),
  averageEstimatedCost: z.number().nonnegative().nullable().default(null),
  totalEstimatedCost: z.number().nonnegative().nullable().default(null),
  averageLatencyMs: z.number().int().nonnegative().nullable().default(null),
  warnings: z.array(z.string()).default([])
});
export type StrategySimulation = z.infer<typeof StrategySimulationSchema>;

export const StrategyComparisonSchema = z.object({
  strategyAId: z.string().min(1),
  strategyBId: z.string().min(1),
  similarities: z.array(z.string()).default([]),
  differences: z
    .array(
      z.object({
        aspect: z.string(),
        valueA: z.unknown(),
        valueB: z.unknown(),
        impact: z.enum(["low", "medium", "high"])
      })
    )
    .default([]),
  estimatedCostDifference: z.number().nullable().default(null),
  estimatedLatencyDifference: z.number().int().nullable().default(null)
});
export type StrategyComparison = z.infer<typeof StrategyComparisonSchema>;
