import type { AgentDatabase } from "@agent/database";
import { statfs } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { z } from "zod";
import {
  BudgetConfigSchema,
  DiscoveredModelSchema,
  ModelRoleSchema,
  ProviderConfigurationSchema,
  RoutingConfigSchema,
  type AiProvider,
  type BudgetConfig,
  type DiscoveredModel,
  type ProviderConfiguration,
  type ProviderType,
  type RoutingConfig,
  type SecretStore,
  type TaskDescriptor,
  type UnifiedMessage,
  type UnifiedModelEvent,
  type ModelUsage,
  maskSecret
} from "@agent/ai";
import { OllamaProvider } from "@agent/ai";
import { ModelRouter } from "./routing.js";

export interface ProviderSummary {
  configuration: Omit<ProviderConfiguration, "secretReference"> & {
    hasSecret: boolean;
    secretReferenceProvider: string | null;
  };
  models: { total: number; enabled: number };
  status:
    "not_configured" | "connected" | "authentication_failed" | "provider_unavailable" | "no_models";
}

export class ProviderService {
  private providers = new Map<string, AiProvider>();
  private router = new ModelRouter();

  constructor(
    private readonly database: AgentDatabase,
    private readonly secrets: SecretStore,
    private readonly factory: (
      configuration: ProviderConfiguration,
      secrets: SecretStore
    ) => AiProvider
  ) {}

  list(): ProviderSummary[] {
    return this.database.providers().map((configuration) => this.summary(configuration));
  }

  get(id: string): ProviderSummary {
    return this.summary(this.requireConfiguration(id));
  }

  save(input: unknown): ProviderSummary {
    const configuration = ProviderConfigurationSchema.parse(input);
    this.database.saveProvider(configuration);
    this.providers.delete(configuration.id);
    return this.summary(configuration);
  }

  async storeSecret(providerId: string, secret: string): Promise<{ stored: true; masked: string }> {
    if (!secret.trim()) throw new Error("Secret cannot be empty");
    const configuration = this.requireConfiguration(providerId);
    if (configuration.secretReference) await this.secrets.delete(configuration.secretReference);
    configuration.secretReference = await this.secrets.put(
      "PersonalCodexAgent",
      providerId,
      secret
    );
    configuration.updatedAt = new Date().toISOString();
    this.database.saveProvider(configuration);
    return { stored: true, masked: maskSecret(secret) };
  }

  async deleteSecret(providerId: string): Promise<boolean> {
    const configuration = this.requireConfiguration(providerId);
    if (!configuration.secretReference) return false;
    const deleted = await this.secrets.delete(configuration.secretReference);
    configuration.secretReference = null;
    configuration.updatedAt = new Date().toISOString();
    this.database.saveProvider(configuration);
    return deleted;
  }

  async remove(providerId: string, deleteSecret: boolean): Promise<boolean> {
    const configuration = this.requireConfiguration(providerId);
    if (deleteSecret && configuration.secretReference) {
      await this.secrets.delete(configuration.secretReference);
    }
    this.providers.delete(providerId);
    return this.database.deleteProvider(providerId);
  }

  async test(providerId: string) {
    const configuration = this.requireConfiguration(providerId);
    const validation = await this.provider(configuration).validateConfiguration(configuration);
    if (!validation.valid)
      return { connected: false, latencyMs: 0, message: validation.errors.join("; ") };
    return this.provider(configuration).testConnection(configuration);
  }

  async testWithSecret(providerId: string, secret: string) {
    if (!secret.trim()) throw new Error("Secret cannot be empty");
    const configuration = this.requireConfiguration(providerId);
    const reference = await this.secrets.put("PersonalCodexAgentEphemeral", providerId, secret);
    try {
      const ephemeral = { ...configuration, secretReference: reference };
      const validation = await this.factory(ephemeral, this.secrets).validateConfiguration(
        ephemeral
      );
      if (!validation.valid) {
        return { connected: false, latencyMs: 0, message: validation.errors.join("; ") };
      }
      return await this.factory(ephemeral, this.secrets).testConnection(ephemeral);
    } finally {
      await this.secrets.delete(reference);
    }
  }

  async refreshModels(providerId: string): Promise<DiscoveredModel[]> {
    const configuration = this.requireConfiguration(providerId);
    const models = await this.provider(configuration).listModels(configuration);
    const existing = new Map(
      this.database.models(providerId).map((model) => [model.modelId, model])
    );
    const merged = models.map((model) => {
      const prior = existing.get(model.modelId);
      return prior
        ? {
            ...model,
            enabled: prior.enabled,
            roles: prior.roles,
            inputPricePerMillion: prior.inputPricePerMillion,
            outputPricePerMillion: prior.outputPricePerMillion,
            cachedInputPricePerMillion: prior.cachedInputPricePerMillion,
            maximumConcurrency: prior.maximumConcurrency,
            maximumTaskCost: prior.maximumTaskCost,
            notes: prior.notes
          }
        : model;
    });
    this.database.saveModels(providerId, merged);
    return merged;
  }

  updateModel(providerId: string, modelId: string, patch: unknown): DiscoveredModel {
    const model = this.database
      .models(providerId)
      .find((candidate) => candidate.modelId === modelId);
    if (!model) throw new Error("Model not found");
    const allowed = ModelPatchSchema.parse(patch);
    const definedPatch = Object.fromEntries(
      Object.entries(allowed).filter(([, value]) => value !== undefined)
    ) as Partial<DiscoveredModel>;
    const updated: DiscoveredModel = {
      ...model,
      ...definedPatch,
      metadataSource: "user_override"
    };
    this.database.saveModel(updated);
    return updated;
  }

  routingConfig(): RoutingConfig {
    return this.database.routingConfig() ?? RoutingConfigSchema.parse({});
  }

  saveRoutingConfig(input: unknown): RoutingConfig {
    const config = RoutingConfigSchema.parse(input);
    this.database.saveRoutingConfig(config);
    return config;
  }

  budgetConfig(): BudgetConfig {
    return this.database.budgetConfig() ?? BudgetConfigSchema.parse({});
  }

  saveBudgetConfig(input: unknown): BudgetConfig {
    const config = BudgetConfigSchema.parse(input);
    this.database.saveBudgetConfig(config);
    return config;
  }

  simulate(task: TaskDescriptor) {
    const usage = this.database.usage();
    const spent = usage.reduce(
      (sum, item) => sum + Number(item.actual_cost ?? item.estimated_cost ?? 0),
      0
    );
    return this.router.route(task, {
      models: this.database.models(),
      config: this.routingConfig(),
      budget: this.budgetConfig(),
      spentToday: spent,
      spentThisRun: 0,
      providerHealth: Object.fromEntries(
        this.database.providers().map((item) => [item.id, "healthy"])
      ),
      performance: this.database.performanceSummary(),
      cacheKeys: new Set(),
      cloudApproved: false
    });
  }

  async executeReadOnly(input: {
    task: TaskDescriptor;
    messages: UnifiedMessage[];
    cloudApproved: boolean;
    liveConfirmed: boolean;
    responseSchema?: Record<string, unknown>;
  }): Promise<{
    decision: ReturnType<ModelRouter["route"]>;
    providerId: string;
    modelId: string;
    text: string;
    events: UnifiedModelEvent[];
    fallbackAttempts: Array<{ providerId: string; modelId: string; outcome: string }>;
  }> {
    if (!input.liveConfirmed) throw new Error("A live model call requires explicit confirmation");
    if (input.task.repositoryWrite) {
      throw new Error("Repository-writing tasks must use the approved Codex worktree workflow");
    }
    const usageRows = this.database.usage();
    const spent = usageRows.reduce(
      (sum, item) => sum + Number(item.actual_cost ?? item.estimated_cost ?? 0),
      0
    );
    const decision = this.router.route(input.task, {
      models: this.database.models(),
      config: this.routingConfig(),
      budget: this.budgetConfig(),
      spentToday: spent,
      spentThisRun: usageRows
        .filter((item) => item.run_id === input.task.runId)
        .reduce((sum, item) => sum + Number(item.actual_cost ?? item.estimated_cost ?? 0), 0),
      providerHealth: Object.fromEntries(
        this.database.providers().map((item) => [item.id, "healthy"])
      ),
      performance: this.database.performanceSummary(),
      cacheKeys: new Set(),
      cloudApproved: input.cloudApproved
    });
    this.database.saveRoutingDecision(input.task.runId, input.task.id, decision);
    const routes = [
      { providerId: decision.selectedProviderId, modelId: decision.selectedModelId },
      ...decision.fallbackChain
    ];
    const fallbackAttempts: Array<{ providerId: string; modelId: string; outcome: string }> = [];
    for (const route of routes) {
      const configuration = this.requireConfiguration(route.providerId);
      const events: UnifiedModelEvent[] = [];
      let text = "";
      let usage: ModelUsage | null = null;
      for await (const event of this.provider(configuration).generate(
        {
          requestId: crypto.randomUUID(),
          runId: input.task.runId,
          taskId: input.task.id,
          model: route.modelId,
          role: input.task.role,
          messages: input.messages,
          ...(input.responseSchema === undefined ? {} : { responseSchema: input.responseSchema }),
          limits: {
            maxInputTokens: input.task.expectedInputTokens,
            maxOutputTokens: input.task.expectedOutputTokens,
            timeoutMs:
              this.database.models(route.providerId).find((item) => item.modelId === route.modelId)
                ?.defaultTimeoutMs ?? configuration.timeoutMs,
            ...(decision.estimatedCost === null ? {} : { maximumCost: decision.estimatedCost })
          },
          preferences: {
            reasoningLevel: input.task.risk === "critical" ? "high" : "medium",
            latencyPreference: "balanced",
            requireStructuredOutput: Boolean(input.responseSchema),
            allowWebGrounding: false
          },
          caching: { enabled: true },
          metadata: { routedBy: "deterministic-router" }
        },
        configuration
      )) {
        events.push(event);
        if (event.type === "text-delta") text += event.text;
        if (event.type === "usage") usage = event.usage;
      }
      const failed = events.find((event) =>
        ["failed", "rate-limit", "refusal", "cancelled"].includes(event.type)
      );
      const completed = events.some((event) => event.type === "completed");
      fallbackAttempts.push({
        providerId: route.providerId,
        modelId: route.modelId,
        outcome: completed && !failed ? "completed" : (failed?.type ?? "incomplete")
      });
      const usageEvent = usage;
      this.database.recordModelPerformance({
        providerId: route.providerId,
        modelId: route.modelId,
        taskCategory: input.task.role,
        success: completed && !failed,
        failureType: failed?.type === "failed" ? failed.failure.type : (failed?.type ?? null),
        cost: usageEvent?.actualCost ?? usageEvent?.estimatedCost ?? decision.estimatedCost,
        latencyMs: usageEvent?.latencyMs ?? configuration.timeoutMs,
        retryCount: fallbackAttempts.length - 1
      });
      if (completed && !failed) {
        if (usage) {
          this.database.recordUsage({
            id: crypto.randomUUID(),
            runId: input.task.runId,
            taskId: input.task.id,
            providerId: usage.providerId,
            modelId: usage.modelId,
            inputTokens: usage.inputTokens,
            cachedTokens: usage.cachedInputTokens,
            outputTokens: usage.outputTokens,
            reasoningTokens: usage.reasoningTokens,
            estimatedCost: usage.estimatedCost ?? decision.estimatedCost,
            actualCost: usage.actualCost,
            latencyMs: usage.latencyMs,
            occurredAt: new Date().toISOString()
          });
        }
        return {
          decision,
          providerId: route.providerId,
          modelId: route.modelId,
          text,
          events,
          fallbackAttempts
        };
      }
    }
    throw new Error(
      `All eligible model routes failed: ${fallbackAttempts.map((item) => `${item.providerId}/${item.modelId}:${item.outcome}`).join(", ")}`
    );
  }

  exportConfiguration(): Record<string, unknown> {
    return {
      version: 1,
      providers: this.database
        .providers()
        .map(
          ({
            secretReference: _secret,
            sensitiveHeadersReference: _headers,
            ...configuration
          }) => ({
            ...configuration,
            credentialRequired: Boolean(_secret),
            sensitiveHeadersRequired: Boolean(_headers)
          })
        ),
      models: this.database.models(),
      routing: this.routingConfig(),
      budgets: this.budgetConfig()
    };
  }

  importPreview(input: unknown): {
    valid: boolean;
    providers: number;
    models: number;
    missingCredentials: string[];
  } {
    const parsed = ExportSchema.parse(input);
    return {
      valid: true,
      providers: parsed.providers.length,
      models: parsed.models.length,
      missingCredentials: parsed.providers
        .filter((provider) => provider.credentialRequired)
        .map((provider) => provider.id)
    };
  }

  importConfiguration(
    input: unknown,
    mode: "merge" | "replace"
  ): {
    importedProviders: number;
    importedModels: number;
    missingCredentials: string[];
  } {
    const parsed = ExportSchema.parse(input);
    const current = new Map(this.database.providers().map((item) => [item.id, item]));
    if (mode === "replace") {
      const incoming = new Set(parsed.providers.map((item) => item.id));
      for (const existing of current.values()) {
        if (!incoming.has(existing.id)) this.database.deleteProvider(existing.id);
      }
    }
    for (const exported of parsed.providers) {
      const existing = current.get(exported.id);
      const safe = Object.fromEntries(
        Object.entries(exported).filter(
          ([key]) => key !== "credentialRequired" && key !== "sensitiveHeadersRequired"
        )
      ) as Omit<typeof exported, "credentialRequired" | "sensitiveHeadersRequired">;
      this.database.saveProvider({
        ...safe,
        secretReference: existing?.secretReference ?? null,
        sensitiveHeadersReference: existing?.sensitiveHeadersReference ?? null,
        updatedAt: new Date().toISOString()
      });
    }
    for (const providerId of new Set(parsed.models.map((item) => item.providerId))) {
      this.database.saveModels(
        providerId,
        parsed.models.filter((item) => item.providerId === providerId)
      );
    }
    this.database.saveRoutingConfig(parsed.routing);
    this.database.saveBudgetConfig(parsed.budgets);
    return {
      importedProviders: parsed.providers.length,
      importedModels: parsed.models.length,
      missingCredentials: parsed.providers
        .filter((item) => item.credentialRequired && !current.get(item.id)?.secretReference)
        .map((item) => item.id)
    };
  }

  async detectOllama(providerId = "ollama") {
    const configuration = this.requireConfiguration(providerId);
    const provider = this.provider(configuration);
    if (!(provider instanceof OllamaProvider)) throw new Error("Provider is not Ollama");
    return provider.detect(configuration);
  }

  async planOllamaPull(providerId: string, model: string) {
    const configuration = this.requireConfiguration(providerId);
    const provider = this.provider(configuration);
    if (!(provider instanceof OllamaProvider)) throw new Error("Provider is not Ollama");
    const installed = this.database.models(providerId).find((item) => item.modelId === model);
    const knownSize =
      installed && typeof installed.metadata.size === "number" ? installed.metadata.size : null;
    const disk = await statfs(process.cwd());
    const freeDiskBytes = disk.bavail * disk.bsize;
    const memoryBytes = totalmem();
    return {
      providerId,
      model,
      knownDownloadSizeBytes: knownSize,
      targetDrive: process.cwd().slice(0, 3),
      freeDiskBytes,
      memoryBytes,
      freeMemoryBytes: freemem(),
      gpuAcceleration: "unknown" as const,
      suitability:
        knownSize === null
          ? "Check the model publisher's RAM, VRAM, and disk requirements before confirming."
          : knownSize > memoryBytes
            ? "Model size exceeds system memory; performance may be unsuitable."
            : "Model size fits system memory, but runtime speed depends on CPU/GPU and quantization."
    };
  }

  async *pullOllama(providerId: string, model: string, confirmed: boolean) {
    if (!confirmed) throw new Error("Explicit confirmation is required before downloading a model");
    const configuration = this.requireConfiguration(providerId);
    const provider = this.provider(configuration);
    if (!(provider instanceof OllamaProvider)) throw new Error("Provider is not Ollama");
    yield* provider.pull(configuration, model);
  }

  async removeOllama(providerId: string, model: string, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error("Explicit confirmation is required before removing a model");
    const configuration = this.requireConfiguration(providerId);
    const provider = this.provider(configuration);
    if (!(provider instanceof OllamaProvider)) throw new Error("Provider is not Ollama");
    await provider.remove(configuration, model);
  }

  private summary(configuration: ProviderConfiguration): ProviderSummary {
    const models = this.database.models(configuration.id);
    return {
      configuration: {
        ...withoutSecret(configuration),
        hasSecret: Boolean(configuration.secretReference),
        secretReferenceProvider: configuration.secretReference?.provider ?? null
      },
      models: { total: models.length, enabled: models.filter((model) => model.enabled).length },
      status: !configuration.enabled
        ? "not_configured"
        : models.length === 0
          ? "no_models"
          : "connected"
    };
  }

  private requireConfiguration(id: string): ProviderConfiguration {
    const configuration = this.database.provider(id);
    if (!configuration) throw new Error(`Provider not found: ${id}`);
    return configuration;
  }

  private provider(configuration: ProviderConfiguration): AiProvider {
    let provider = this.providers.get(configuration.id);
    if (!provider) {
      provider = this.factory(configuration, this.secrets);
      this.providers.set(configuration.id, provider);
    }
    return provider;
  }
}

const ModelPatchSchema = z.object({
  enabled: z.boolean().optional(),
  roles: z.array(ModelRoleSchema).optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  inputPricePerMillion: z.number().nonnegative().nullable().optional(),
  outputPricePerMillion: z.number().nonnegative().nullable().optional(),
  cachedInputPricePerMillion: z.number().nonnegative().nullable().optional(),
  maximumConcurrency: z.number().int().positive().optional(),
  maximumTaskCost: z.number().nonnegative().nullable().optional(),
  notes: z.string().max(2_000).optional()
});

const ExportSchema = z.object({
  version: z.literal(1),
  providers: z.array(
    ProviderConfigurationSchema.omit({
      secretReference: true,
      sensitiveHeadersReference: true
    }).extend({
      credentialRequired: z.boolean(),
      sensitiveHeadersRequired: z.boolean()
    })
  ),
  models: z.array(DiscoveredModelSchema),
  routing: RoutingConfigSchema,
  budgets: BudgetConfigSchema
});

function withoutSecret(
  configuration: ProviderConfiguration
): Omit<ProviderConfiguration, "secretReference"> {
  return Object.fromEntries(
    Object.entries(configuration).filter(([key]) => key !== "secretReference")
  ) as Omit<ProviderConfiguration, "secretReference">;
}

export function defaultProviderConfiguration(
  type: ProviderType,
  id: string = type
): ProviderConfiguration {
  const now = new Date().toISOString();
  const baseUrls: Record<ProviderType, string> = {
    openai: "https://api.openai.com",
    anthropic: "https://api.anthropic.com",
    google: "https://generativelanguage.googleapis.com",
    xai: "https://api.x.ai",
    ollama: "http://127.0.0.1:11434",
    "openai-compatible": "http://127.0.0.1:1234"
  };
  return ProviderConfigurationSchema.parse({
    id,
    type,
    displayName: type === "openai-compatible" ? "Custom provider" : type,
    baseUrl: baseUrls[type],
    modelsPath:
      type === "google"
        ? "/v1beta/models"
        : type === "ollama"
          ? "/api/tags"
          : type === "xai"
            ? "/v1/language-models"
            : "/v1/models",
    mode: type === "openai" ? "responses" : type === "ollama" ? "native" : "chat-completions",
    createdAt: now,
    updatedAt: now
  });
}
