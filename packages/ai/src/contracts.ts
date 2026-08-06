import { z } from "zod";

export const ProviderTypeSchema = z.enum([
  "openai",
  "anthropic",
  "google",
  "xai",
  "ollama",
  "openai-compatible"
]);
export type ProviderType = z.infer<typeof ProviderTypeSchema>;

export const ProviderTransportSchema = z.enum([
  "api",
  "openai-compatible-api",
  "app-server",
  "acp",
  "json-cli",
  "jsonl-cli",
  "text-cli",
  "local-backend"
]);
export type ProviderTransport = z.infer<typeof ProviderTransportSchema>;

export const ProviderSupportSchema = z.enum([
  "verified",
  "available",
  "degraded",
  "unsupported",
  "unavailable",
  "not-configured",
  "not-verified"
]);
export type ProviderSupport = z.infer<typeof ProviderSupportSchema>;

export const ModelRoleSchema = z.enum([
  "local_trivial",
  "economy",
  "balanced",
  "frontier",
  "coding",
  "planning",
  "prompt_review",
  "repository_analysis",
  "test_generation",
  "debugging",
  "security_review",
  "code_review",
  "documentation",
  "research",
  "vision",
  "verification",
  "fallback"
]);
export type ModelRole = z.infer<typeof ModelRoleSchema>;

export const TaskTierSchema = z.enum(["trivial", "small", "medium", "large", "critical"]);
export type TaskTier = z.infer<typeof TaskTierSchema>;

export const SecretReferenceSchema = z.object({
  provider: z.enum(["windows-credential-manager", "memory-test-store"]),
  service: z.string().min(1),
  account: z.string().min(1),
  secretId: z.string().min(1)
});
export type SecretReference = z.infer<typeof SecretReferenceSchema>;

export const ProviderConfigurationSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9._-]+$/),
  type: ProviderTypeSchema,
  displayName: z.string().min(1).max(100),
  enabled: z.boolean().default(true),
  baseUrl: z.url(),
  secretReference: SecretReferenceSchema.nullable().default(null),
  organization: z.string().max(200).nullable().default(null),
  project: z.string().max(200).nullable().default(null),
  mode: z.enum(["responses", "chat-completions", "native"]).default("native"),
  modelsPath: z.string().startsWith("/").default("/v1/models"),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).default(120_000),
  tlsVerification: z.boolean().default(true),
  sensitiveHeadersReference: SecretReferenceSchema.nullable().default(null),
  nonSecretHeaders: z.record(z.string(), z.string()).default({}),
  manualModels: z.array(z.string().min(1)).default([]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
});
export type ProviderConfiguration = z.infer<typeof ProviderConfigurationSchema>;

export interface ProviderCapabilities {
  chat: boolean;
  streaming: boolean;
  tools: boolean;
  structuredOutput: boolean;
  vision: boolean;
  caching: boolean;
  tokenCounting: boolean;
  modelDiscovery: boolean;
  cancellation: boolean;
  local: boolean;
  fileRead: boolean;
  fileWrite: boolean;
  shellExecution: boolean;
  permissionRequests: boolean;
  sessionResume: boolean;
  usageReporting: boolean;
  localExecution: boolean;
  worktreeAware: boolean;
  safeRepositoryWriting: boolean;
}

export const DiscoveredModelSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  displayName: z.string(),
  available: z.boolean(),
  enabled: z.boolean().default(false),
  local: z.boolean(),
  supportsStreaming: z.boolean(),
  supportsTools: z.boolean(),
  supportsStructuredOutput: z.boolean(),
  supportsVision: z.boolean(),
  supportsCaching: z.boolean(),
  supportsTokenCounting: z.boolean(),
  supportsRepositoryWrite: z.boolean().default(false),
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  roles: z.array(ModelRoleSchema).default([]),
  weaknesses: z.array(z.string()).default([]),
  inputPricePerMillion: z.number().nonnegative().nullable(),
  outputPricePerMillion: z.number().nonnegative().nullable(),
  cachedInputPricePerMillion: z.number().nonnegative().nullable(),
  maximumConcurrency: z.number().int().positive().default(1),
  defaultTimeoutMs: z.number().int().positive().default(120_000),
  maximumTaskCost: z.number().nonnegative().nullable(),
  metadataSource: z.enum([
    "provider_discovery",
    "official_preset",
    "user_override",
    "runtime_measurement",
    "historical_performance"
  ]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  lastTestedAt: z.iso.datetime().nullable().default(null),
  averageLatencyMs: z.number().nonnegative().nullable().default(null),
  historicalSuccessRate: z.number().min(0).max(1).nullable().default(null),
  notes: z.string().default("")
});
export type DiscoveredModel = z.infer<typeof DiscoveredModelSchema>;

export interface UnifiedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface UnifiedToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface UnifiedModelRequest {
  requestId: string;
  runId: string;
  taskId: string;
  model: string;
  role: ModelRole;
  messages: UnifiedMessage[];
  tools?: UnifiedToolDefinition[];
  responseSchema?: Record<string, unknown>;
  attachments?: Array<{ type: "image" | "file"; mediaType: string; data: string }>;
  limits: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    timeoutMs: number;
    maximumCost?: number;
  };
  preferences: {
    reasoningLevel: "none" | "low" | "medium" | "high" | "maximum";
    latencyPreference: "fastest" | "balanced" | "quality";
    requireStructuredOutput: boolean;
    allowWebGrounding: boolean;
  };
  caching: { enabled: boolean; cacheKey?: string; stablePrefixHash?: string };
  metadata: Record<string, string>;
}

export interface ModelUsage {
  providerId: string;
  modelId: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
  actualCost: number | null;
  latencyMs: number;
  timeToFirstTokenMs: number | null;
}

export type UnifiedModelEvent =
  | { type: "started"; requestId: string; timestamp: string }
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; arguments: unknown }
  | { type: "tool-result"; id: string; result: unknown }
  | { type: "usage"; usage: ModelUsage }
  | { type: "completed"; finishReason: string; metadata?: Record<string, unknown> }
  | { type: "refusal"; reason: string }
  | { type: "rate-limit"; retryAfterMs: number | null }
  | { type: "failed"; failure: ProviderFailure }
  | { type: "cancelled" };

export const ProviderFailureTypeSchema = z.enum([
  "authentication",
  "authorization",
  "rate_limit",
  "quota",
  "timeout",
  "network",
  "provider_outage",
  "model_unavailable",
  "context_limit",
  "invalid_request",
  "structured_output_failure",
  "tool_failure",
  "refusal",
  "cancelled",
  "unknown"
]);
export type ProviderFailureType = z.infer<typeof ProviderFailureTypeSchema>;

export interface ProviderFailure {
  type: ProviderFailureType;
  message: string;
  retryable: boolean;
  retryAfterMs: number | null;
  statusCode: number | null;
}

export interface CapabilityEvidence {
  capability: keyof ProviderCapabilities;
  supported: boolean;
  verifiedAt: string | null;
  method: "live-test" | "official-docs" | "deterministic-fake" | "inferred" | "user-override";
  notes: string;
}

export interface ProviderRecord {
  id: string;
  displayName: string;
  transport: ProviderTransport;
  support: ProviderSupport;
  capabilityEvidence: CapabilityEvidence[];
  models: string[];
  healthy: boolean;
  lastSuccessfulDiagnosticAt: string | null;
  lastVerifiedVersion: string | null;
  lastVerifiedAt: string | null;
  privacyClassification: "local-only" | "remote-no-training" | "remote-may-train" | "unknown";
  costMetadata: { currency: string; notes: string } | null;
  mayPerformRepositoryWrites: boolean;
  unavailableReasonByCapability: Partial<Record<keyof ProviderCapabilities, string>>;
  documentationUrl: string | null;
  redactedConfiguration: Record<string, unknown>;
}

export interface AiProvider {
  readonly id: string;
  readonly type: ProviderType;
  readonly displayName: string;
  getCapabilities(): ProviderCapabilities;
  validateConfiguration(configuration: ProviderConfiguration): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  }>;
  testConnection(configuration: ProviderConfiguration): Promise<{
    connected: boolean;
    latencyMs: number;
    message: string;
  }>;
  listModels(configuration: ProviderConfiguration): Promise<DiscoveredModel[]>;
  countTokens?(
    request: UnifiedModelRequest,
    configuration: ProviderConfiguration
  ): Promise<{ inputTokens: number | null; source: "provider" | "estimate" }>;
  generate(
    request: UnifiedModelRequest,
    configuration: ProviderConfiguration
  ): AsyncIterable<UnifiedModelEvent>;
  cancel(requestId: string): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; message: string; checkedAt: string }>;
}

export const RoutingProfileSchema = z.enum([
  "maximum_savings",
  "balanced",
  "maximum_quality",
  "maximum_privacy",
  "custom"
]);

export const RoutingConfigSchema = z.object({
  profile: RoutingProfileSchema.default("balanced"),
  weights: z
    .object({
      capability: z.number().default(4),
      reliability: z.number().default(2),
      latency: z.number().default(1),
      cost: z.number().default(2),
      cache: z.number().default(1),
      privacy: z.number().default(2)
    })
    .default({
      capability: 4,
      reliability: 2,
      latency: 1,
      cost: 2,
      cache: 1,
      privacy: 2
    }),
  cloudRequiresApproval: z.boolean().default(false),
  localOnly: z.boolean().default(false),
  maximumParallelTasks: z.number().int().min(1).max(16).default(3),
  minimumLearningSamples: z.number().int().min(3).default(10),
  verification: z
    .object({
      criticalRequiresIndependent: z.boolean().default(true),
      largeRequiresIndependent: z.boolean().default(false),
      preferDifferentProvider: z.boolean().default(true)
    })
    .default({
      criticalRequiresIndependent: true,
      largeRequiresIndependent: false,
      preferDifferentProvider: true
    })
});
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

export const BudgetConfigSchema = z.object({
  dailyLimit: z.number().nonnegative().nullable().default(null),
  monthlyLimit: z.number().nonnegative().nullable().default(null),
  perRunLimit: z.number().nonnegative().nullable().default(5),
  perTaskLimit: z.number().nonnegative().nullable().default(1),
  warningPercent: z.number().min(1).max(100).default(80)
});
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

export const TaskDescriptorSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  role: ModelRoleSchema,
  expectedInputTokens: z.number().int().nonnegative(),
  expectedOutputTokens: z.number().int().nonnegative(),
  requiredTools: z.boolean(),
  requiredVision: z.boolean(),
  repositoryWrite: z.boolean(),
  sensitive: z.boolean(),
  likelyFiles: z.array(z.string()),
  dependencies: z.array(z.string()),
  risk: z.enum(["low", "medium", "high", "critical"])
});
export type TaskDescriptor = z.infer<typeof TaskDescriptorSchema>;

export interface RoutingDecision {
  selectedProviderId: string;
  selectedModelId: string;
  taskTier: TaskTier;
  reasonCodes: string[];
  rejectedCandidates: Array<{ providerId: string; modelId: string; reasons: string[] }>;
  estimatedInputTokens: number | null;
  estimatedOutputTokens: number | null;
  estimatedCost: number | null;
  fallbackChain: Array<{ providerId: string; modelId: string }>;
  verificationPolicy: "deterministic" | "self_check" | "independent";
  parallelEligible: boolean;
}
