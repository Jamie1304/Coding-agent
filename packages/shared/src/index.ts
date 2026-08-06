import { z } from "zod";

export * from "./command-resolver.js";
export * from "./strategy-schemas.js";

export const runStates = [
  "IDLE",
  "WORKSPACE_DISCOVERY",
  "REPOSITORY_ANALYSIS",
  "PROMPT_REVIEW",
  "QUESTIONING",
  "CHANGE_REVIEW",
  "PROMPT_REVISION",
  "AWAITING_APPROVAL",
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
  "RELEASE",
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
  superseded: z.boolean().default(false),
  repositoryEvidence: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  rejectedInterpretations: z.array(z.string()).default([]),
  remainingUncertainty: z.string().nullable().default(null),
  answeredAt: z.string().nullable().default(null)
});
export type Question = z.infer<typeof QuestionSchema>;

export const PromptRevisionSchema = z.object({
  revision: z.number().int().positive(),
  revisionId: z.string().default(""),
  promptHash: z.string().default(""),
  content: z.string(),
  changes: z.array(z.string()),
  assumptions: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  tests: z.array(z.string()),
  risks: z.array(z.string()),
  affectedComponents: z.array(z.string()),
  versionChange: z.enum(["patch", "minor", "major"]),
  sequence: z.array(z.string()),
  nonGoals: z.array(z.string()).default([]),
  securityRequirements: z.array(z.string()).default([]),
  approved: z.boolean().default(false),
  frozenAt: z.string().nullable().default(null)
});
export type PromptRevision = z.infer<typeof PromptRevisionSchema>;

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
