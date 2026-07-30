import { z } from "zod";

export * from "./command-resolver.js";

export const runStates = [
  "IDLE",
  "RUN_CREATED",
  "WORKSPACE_DISCOVERY",
  "REPOSITORY_ANALYSIS",
  "PROMPT_REVIEW",
  "QUESTIONING",
  "PROMPT_REVISION",
  "AWAITING_APPROVAL",
  "STEP_PLAN_GENERATION",
  "AWAITING_STEP_PLAN_APPROVAL",
  "GITHUB_PREFLIGHT",
  "PULL_REQUEST_DRAFT_CREATION",
  "PROJECT_KNOWLEDGE_BASELINE",
  "EXECUTING_STEPS",
  "FINAL_FULL_VALIDATION",
  "FINAL_INDEPENDENT_REVIEW",
  "FINAL_DOCUMENTATION",
  "PREFLIGHT",
  "ISSUE_CREATION",
  "ACCEPTANCE_CRITERIA",
  "WORKTREE_CREATION",
  "BRANCH_CREATION",
  "IMPLEMENTATION_PLANNING",
  "IMPLEMENTING",
  "FOCUSED_TESTING",
  "FULL_VALIDATION",
  "DIFF_REVIEW",
  "INDEPENDENT_REVIEW",
  "COMMITTING",
  "PUSHING",
  "PULL_REQUEST_CREATION",
  "CI_VALIDATION",
  "SECURITY_REVIEW",
  "BEHAVIOR_VALIDATION",
  "STAGING_DEPLOYMENT",
  "STAGING_SMOKE_TEST",
  "MERGING",
  "PRODUCTION_DEPLOYMENT",
  "PRODUCTION_SMOKE_TEST",
  "VERSIONING",
  "STAGING_VALIDATION",
  "RELEASE",
  "FINAL_REPORTING",
  "MONITORING",
  "REPORTING",
  "SUCCESS",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
  "ROLLING_BACK"
] as const;

export const RunStateSchema = z.enum(runStates);
export type RunState = z.infer<typeof RunStateSchema>;

export const stageStatuses = [
  "pending",
  "running",
  "passed",
  "failed",
  "retrying",
  "blocked",
  "skipped",
  "rolled_back"
] as const;
export type StageStatus = (typeof stageStatuses)[number];

export const WorkspaceSnapshotSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  trusted: z.boolean().default(true),
  activeFile: z.string().nullable().default(null),
  source: z.enum(["vscode", "manual", "restored"]).default("manual")
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

export const QuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  reason: z.string(),
  affects: z.string(),
  options: z.array(z.string()).default([]),
  answer: z.string().nullable().default(null),
  revision: z.number().int().positive(),
  confirmed: z.boolean().default(false),
  superseded: z.boolean().default(false)
});
export type Question = z.infer<typeof QuestionSchema>;

export const PromptRevisionSchema = z.object({
  revision: z.number().int().positive(),
  content: z.string(),
  changes: z.array(z.string()),
  assumptions: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  tests: z.array(z.string()),
  risks: z.array(z.string()),
  affectedComponents: z.array(z.string()),
  versionChange: z.enum(["patch", "minor", "major"]),
  sequence: z.array(z.string()),
  approved: z.boolean().default(false),
  frozenAt: z.string().nullable().default(null)
});
export type PromptRevision = z.infer<typeof PromptRevisionSchema>;

export const StepStateSchema = z.enum([
  "STEP_LOCKED",
  "STEP_READY",
  "STEP_CONTEXT_ANALYSIS",
  "STEP_IMPLEMENTATION",
  "STEP_AUTOMATED_TEST_CREATION",
  "STEP_FOCUSED_VALIDATION",
  "STEP_RUNTIME_START",
  "STEP_RUNTIME_INTERACTION",
  "STEP_RUNTIME_ERROR_ANALYSIS",
  "STEP_RUNTIME_CORRECTION",
  "STEP_RUNTIME_RETEST",
  "STEP_RESTART",
  "STEP_POST_RESTART_VALIDATION",
  "STEP_FULL_AFFECTED_VALIDATION",
  "STEP_DIFF_REVIEW",
  "STEP_INDEPENDENT_REVIEW",
  "STEP_DOCUMENTATION_UPDATE",
  "STEP_PROJECT_KNOWLEDGE_UPDATE",
  "STEP_GIT_COMMIT",
  "STEP_GIT_PUSH",
  "STEP_PULL_REQUEST_UPDATE",
  "STEP_COMPLETE",
  "STEP_BLOCKED"
]);
export type StepState = z.infer<typeof StepStateSchema>;

export const StepAcceptanceCriterionSchema = z.object({
  id: z.string().min(1).max(160),
  description: z.string().min(1).max(10_000)
});
export type StepAcceptanceCriterion = z.infer<typeof StepAcceptanceCriterionSchema>;

export const PlanStepSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  order: z.number().int().positive(),
  title: z.string().min(1).max(300),
  objective: z.string().min(1).max(20_000),
  reason: z.string().min(1).max(20_000),
  prerequisites: z.array(z.string().min(1)).default([]),
  dependencies: z.array(z.string().min(1)).default([]),
  acceptanceCriteria: z.array(StepAcceptanceCriterionSchema).min(1),
  expectedChanges: z
    .object({
      filesToCreate: z.array(z.string()).default([]),
      filesToModify: z.array(z.string()).default([]),
      components: z.array(z.string()).default([]),
      routes: z.array(z.string()).default([]),
      APIs: z.array(z.string()).default([]),
      databaseChanges: z.array(z.string()).default([])
    })
    .default({
      filesToCreate: [],
      filesToModify: [],
      components: [],
      routes: [],
      APIs: [],
      databaseChanges: []
    }),
  requiredTests: z
    .object({
      unit: z.array(z.string()).default([]),
      integration: z.array(z.string()).default([]),
      api: z.array(z.string()).default([]),
      ui: z.array(z.string()).default([]),
      endToEnd: z.array(z.string()).default([]),
      security: z.array(z.string()).default([]),
      runtime: z.array(z.string()).default([]),
      restart: z.array(z.string()).default([])
    })
    .default({
      unit: [],
      integration: [],
      api: [],
      ui: [],
      endToEnd: [],
      security: [],
      runtime: [],
      restart: []
    }),
  runtimeValidation: z
    .object({
      startCommands: z.array(z.string()).default([]),
      expectedProcesses: z.array(z.string()).default([]),
      expectedPorts: z.array(z.string()).default([]),
      routesToVisit: z.array(z.string()).default([]),
      apiRequests: z.array(z.string()).default([]),
      uiActions: z.array(z.string()).default([]),
      expectedLogs: z.array(z.string()).default([]),
      forbiddenErrors: z.array(z.string()).default([]),
      restartCount: z.number().int().nonnegative().default(0)
    })
    .default({
      startCommands: [],
      expectedProcesses: [],
      expectedPorts: [],
      routesToVisit: [],
      apiRequests: [],
      uiActions: [],
      expectedLogs: [],
      forbiddenErrors: [],
      restartCount: 0
    }),
  documentationUpdates: z.array(z.string()).default([]),
  projectKnowledgeUpdates: z.array(z.string()).default([]),
  completionEvidence: z.array(z.string().min(1)).default([]),
  gitCheckpoint: z
    .object({
      commitType: z.string().min(1),
      commitScope: z.string().min(1),
      expectedCommitMessage: z.string().min(1),
      pushRequired: z.boolean().default(true),
      pullRequestUpdateRequired: z.boolean().default(true)
    })
    .default({
      commitType: "chore",
      commitScope: "steps",
      expectedCommitMessage: "chore(steps): checkpoint",
      pushRequired: true,
      pullRequestUpdateRequired: true
    })
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const ApprovedStepPlanSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1).max(160),
    runId: z.string().min(1),
    approvedRevision: z.number().int().positive(),
    frozenAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    steps: z.array(PlanStepSchema).min(1)
  })
  .superRefine((plan, context) => {
    const ids = new Set<string>();
    const orders = new Set<number>();
    for (const [index, step] of plan.steps.entries()) {
      if (ids.has(step.id)) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "id"],
          message: `Duplicate step id: ${step.id}`
        });
      }
      ids.add(step.id);
      if (orders.has(step.order)) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "order"],
          message: `Duplicate step order: ${step.order}`
        });
      }
      orders.add(step.order);
    }
    for (let expectedOrder = 1; expectedOrder <= plan.steps.length; expectedOrder += 1) {
      if (!orders.has(expectedOrder)) {
        context.addIssue({
          code: "custom",
          path: ["steps"],
          message: "Step orders must be contiguous and start at 1"
        });
        break;
      }
    }
    const stepsById = new Map(plan.steps.map((step) => [step.id, step]));
    for (const [index, step] of plan.steps.entries()) {
      for (const dependency of step.dependencies) {
        if (!stepsById.has(dependency)) {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "dependencies"],
            message: `Unknown dependency: ${dependency}`
          });
        }
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (stepId: string): void => {
      if (visiting.has(stepId)) {
        context.addIssue({
          code: "custom",
          path: ["steps"],
          message: `Cyclic step dependency detected at ${stepId}`
        });
        return;
      }
      if (visited.has(stepId)) return;
      visiting.add(stepId);
      for (const dependency of stepsById.get(stepId)?.dependencies ?? []) {
        if (stepsById.has(dependency)) visit(dependency);
      }
      visiting.delete(stepId);
      visited.add(stepId);
    };
    for (const step of plan.steps) visit(step.id);
  });
export type ApprovedStepPlan = z.infer<typeof ApprovedStepPlanSchema>;

export const GateCheckSchema = z.discriminatedUnion("applicable", [
  z.object({
    applicable: z.literal(true),
    passed: z.boolean(),
    evidenceIds: z.array(z.string().min(1)).default([])
  }),
  z.object({
    applicable: z.literal(false),
    justification: z.string().min(1).max(10_000)
  })
]);
export type GateCheck = z.infer<typeof GateCheckSchema>;

export const StepCompletionGateSchema = z.object({
  runId: z.string().min(1),
  stepId: z.string().min(1),
  state: StepStateSchema,
  criteria: z.object({
    scopeAnalysis: GateCheckSchema,
    implementation: GateCheckSchema,
    acceptance: GateCheckSchema,
    requiredTests: GateCheckSchema,
    focusedTests: GateCheckSchema,
    runtimeStart: GateCheckSchema,
    runtimeInteraction: GateCheckSchema,
    runtimeErrorsResolved: GateCheckSchema,
    restart: GateCheckSchema,
    postRestartValidation: GateCheckSchema,
    fullAffectedValidation: GateCheckSchema,
    diffReview: GateCheckSchema,
    independentReview: GateCheckSchema,
    documentation: GateCheckSchema,
    projectKnowledge: GateCheckSchema,
    commit: GateCheckSchema,
    push: GateCheckSchema,
    pullRequest: GateCheckSchema,
    evidenceStored: GateCheckSchema
  }),
  blockingRequirements: z.array(z.string().min(1)).default([]),
  updatedAt: z.iso.datetime()
});
export type StepCompletionGate = z.infer<typeof StepCompletionGateSchema>;

export const StepAmendmentSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  stepId: z.string().min(1),
  reason: z.string().min(1).max(20_000),
  impact: z.string().min(1).max(20_000),
  status: z.enum(["proposed", "approved", "rejected"]),
  proposedAt: z.iso.datetime(),
  approvedAt: z.iso.datetime().nullable(),
  priorPlanHash: z.string().min(1),
  amendedPlanHash: z.string().nullable()
});
export type StepAmendment = z.infer<typeof StepAmendmentSchema>;

const SecretFreePayloadSchema = z
  .record(z.string(), z.unknown())
  .superRefine((payload, context) => {
    if (!isSecretFreeSerializedValue(payload)) {
      context.addIssue({
        code: "custom",
        message: "Evidence payload must be serializable and secret-free"
      });
    }
  });

export const StepEvidenceSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  stepId: z.string().min(1),
  kind: z.enum([
    "scope-analysis",
    "terminal-operation",
    "runtime-test",
    "restart-test",
    "api-test",
    "ui-test",
    "error",
    "correction",
    "review",
    "documentation",
    "knowledge",
    "git",
    "completion-gate"
  ]),
  locator: z.string().min(1).max(10_000),
  contentHash: z.string().min(1).nullable(),
  summary: z.string().min(1).max(20_000),
  payload: SecretFreePayloadSchema,
  createdAt: z.iso.datetime()
});
export type StepEvidence = z.infer<typeof StepEvidenceSchema>;

const RuntimeErrorCategorySchema = z.enum([
  "startup",
  "process_crash",
  "console",
  "network",
  "api",
  "database",
  "ui",
  "integration",
  "authentication",
  "configuration",
  "port",
  "security",
  "unknown"
]);

export const StepRuntimeErrorSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  stepId: z.string().min(1),
  signature: z.string().min(1).max(1_000),
  category: RuntimeErrorCategorySchema,
  severity: z.enum(["warning", "error", "fatal"]),
  message: z.string().min(1).max(20_000),
  source: z.string().min(1).max(10_000),
  evidencePath: z.string().min(1).max(10_000),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  occurrences: z.number().int().positive(),
  status: z.enum(["open", "resolved", "external"]),
  resolution: z.string().min(1).max(20_000)
});
export type StepRuntimeError = z.infer<typeof StepRuntimeErrorSchema>;

export const StepRuntimeWarningSchema = z.object({
  signature: z.string().min(1).max(1_000),
  category: RuntimeErrorCategorySchema,
  message: z.string().min(1).max(20_000),
  source: z.string().min(1).max(10_000),
  evidencePath: z.string().min(1).max(10_000),
  firstSeenAt: z.iso.datetime(),
  occurrences: z.number().int().positive()
});
export type StepRuntimeWarning = z.infer<typeof StepRuntimeWarningSchema>;

export const StepTerminalOperationSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  stepId: z.string().min(1),
  command: z.string().min(1),
  executable: z.string().min(1),
  safeArguments: z.array(z.string()),
  workingDirectory: z.string().min(1),
  startedAt: z.iso.datetime(),
  readyAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  processId: z.number().int().nonnegative().nullable(),
  childProcessIds: z.array(z.number().int().nonnegative()),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  status: z.enum(["running", "passed", "failed", "timed_out", "cancelled"]),
  stdoutLocator: z.string().nullable(),
  stderrLocator: z.string().nullable(),
  combinedLogLocator: z.string().nullable(),
  errorsDetected: z.array(StepRuntimeErrorSchema),
  warningsDetected: z.array(StepRuntimeWarningSchema),
  secretRedactionApplied: z.literal(true)
});
export type StepTerminalOperation = z.infer<typeof StepTerminalOperationSchema>;

export function isSecretFreeSerializedValue(value: unknown): boolean {
  if (!isJsonSerializable(value)) return false;
  try {
    const serialized = JSON.stringify(value);
    return !/(?:gh[opsu]_[a-z0-9_-]{8,}|sk-(?:proj-)?[a-z0-9_-]{8,}|bearer\s+[a-z0-9._-]{8,}|api[_-]?key\s*[=:]\s*\S+|password\s*[=:]\s*\S+)/i.test(
      serialized
    );
  } catch {
    return false;
  }
}

function isJsonSerializable(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonSerializable);
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(isJsonSerializable);
}

export const RunSchema = z.object({
  id: z.string(),
  workspacePath: z.string(),
  repositoryIdentity: z.string().nullable(),
  startingCommit: z.string().nullable(),
  state: RunStateSchema,
  finalStatus: z.enum(["success", "blocked", "failed", "cancelled", "rolled_back"]).nullable(),
  originalPrompt: z.string().min(1),
  approvedPrompt: z.string().nullable(),
  approvedRevision: z.number().int().nullable(),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  retryCount: z.number().int().nonnegative().default(0)
});
export type AgentRun = z.infer<typeof RunSchema>;

export const CreateRunRequestSchema = z.object({
  workspacePath: z.string().min(1),
  prompt: z.string().min(10).max(100_000),
  relevantPaths: z.array(z.string()).max(100).default([])
});

export const AnswersRequestSchema = z.object({
  answers: z.array(z.object({ questionId: z.string(), answer: z.string().min(1) })).min(1)
});

export const RejectRequestSchema = z.object({
  reason: z.string().min(3).max(10_000)
});

export interface WorkspaceAnalysis {
  snapshot: WorkspaceSnapshot;
  git: {
    isRepository: boolean;
    branch: string | null;
    defaultBranch: string | null;
    remote: string | null;
    commit: string | null;
    dirty: boolean;
  };
  technologies: string[];
  packageManager: string | null;
  testCommands: string[];
  configStatus: "configured" | "not_configured" | "invalid";
  files: string[];
}

export interface TimelineEvent {
  runId: string;
  operationId: string;
  timestamp: string;
  state: RunState;
  status: StageStatus;
  message: string;
  evidence?: Record<string, unknown>;
}

export interface FinalReport {
  runId: string;
  finalStatus: "success" | "blocked" | "failed" | "cancelled" | "rolled_back";
  workspace: string;
  startingCommit: string;
  finalCommit: string;
  approvedRevision: number;
  implementationSummary: string[];
  changedFiles: string[];
  tests: { total: number; passed: number; failed: number; skipped: number };
  qualityGates: Array<{ name: string; status: string; evidence: string }>;
  securityFindings: string[];
  dependencyChanges: string[];
  github: {
    issue: number | null;
    branch: string | null;
    pullRequest: number | null;
    mergeCommit: string | null;
  };
  deployments: {
    staging: string;
    production: string;
    rollback: string;
  };
  version: { previous: string; new: string; tag: string };
  knownLimitations: string[];
  blockers: string[];
}

export const ProjectConfigSchema = z.object({
  version: z.literal(1),
  quality: z.object({
    install: z.array(z.string()).default([]),
    focused: z.array(z.string()).default([]),
    full: z.array(z.string()).default([]),
    security: z.array(z.string()).default([])
  }),
  github: z.object({
    enabled: z.boolean().default(true),
    mergeMethod: z.enum(["merge", "squash", "rebase"]).default("squash"),
    autoMerge: z.boolean().default(false)
  }),
  deployment: z
    .object({
      adapter: z.enum(["disabled", "custom"]).default("disabled"),
      build: z.array(z.string()).default([]),
      staging: z.array(z.string()).default([]),
      stagingSmoke: z.array(z.string()).default([]),
      production: z.array(z.string()).default([]),
      productionSmoke: z.array(z.string()).default([]),
      rollback: z.array(z.string()).default([])
    })
    .default({
      adapter: "disabled",
      build: [],
      staging: [],
      stagingSmoke: [],
      production: [],
      productionSmoke: [],
      rollback: []
    })
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
