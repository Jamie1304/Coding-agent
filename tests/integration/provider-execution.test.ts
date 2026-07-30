import type { AiProvider, DiscoveredModel, ProviderConfiguration } from "@agent/ai";
import { MemorySecretStore } from "@agent/ai";
import { ProviderService, defaultProviderConfiguration } from "@agent/core";
import { AgentDatabase } from "@agent/database";

function model(providerId: string): DiscoveredModel {
  return {
    providerId,
    modelId: `${providerId}-model`,
    displayName: `${providerId} model`,
    available: true,
    enabled: true,
    local: false,
    supportsStreaming: true,
    supportsTools: true,
    supportsStructuredOutput: true,
    supportsVision: false,
    supportsCaching: true,
    supportsTokenCounting: true,
    contextWindow: 100_000,
    maxOutputTokens: 4_000,
    roles: ["planning", "fallback"],
    weaknesses: [],
    inputPricePerMillion: 1,
    outputPricePerMillion: 2,
    cachedInputPricePerMillion: 0.5,
    maximumConcurrency: 1,
    defaultTimeoutMs: 1_000,
    maximumTaskCost: 1,
    metadataSource: "provider_discovery",
    metadata: {},
    lastTestedAt: null,
    averageLatencyMs: providerId === "a" ? 1 : 100,
    historicalSuccessRate: null,
    notes: ""
  };
}

describe("routed provider execution", () => {
  it("falls back after a normalized failure and persists the successful usage", async () => {
    const database = new AgentDatabase();
    const factory = (configuration: ProviderConfiguration): AiProvider => ({
      id: configuration.id,
      type: configuration.type,
      displayName: configuration.displayName,
      getCapabilities: () => ({
        streaming: true,
        tools: true,
        structuredOutput: true,
        vision: false,
        caching: true,
        tokenCounting: true,
        modelDiscovery: true,
        cancellation: true,
        local: false
      }),
      validateConfiguration: async () => ({ valid: true, errors: [], warnings: [] }),
      testConnection: async () => ({ connected: true, latencyMs: 1, message: "ok" }),
      listModels: async () => [model(configuration.id)],
      generate: async function* (request) {
        if (configuration.id === "a") {
          yield { type: "rate-limit" as const, retryAfterMs: 10 };
          return;
        }
        yield { type: "text-delta" as const, text: "verified answer" };
        yield {
          type: "usage" as const,
          usage: {
            providerId: configuration.id,
            modelId: request.model,
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 4,
            reasoningTokens: 0,
            totalTokens: 14,
            estimatedCost: 0.01,
            actualCost: null,
            latencyMs: 20,
            timeToFirstTokenMs: 5
          }
        };
        yield { type: "completed" as const, finishReason: "stop" };
      },
      cancel: async () => undefined,
      healthCheck: async () => ({
        healthy: true,
        message: "ok",
        checkedAt: new Date().toISOString()
      })
    });
    const service = new ProviderService(database, new MemorySecretStore(), factory);
    for (const id of ["a", "b"]) {
      service.save({ ...defaultProviderConfiguration("openai", id), displayName: id });
      database.saveModels(id, [model(id)]);
    }
    const result = await service.executeReadOnly({
      task: {
        id: "task",
        runId: "run",
        title: "Plan",
        description: "Plan a small change",
        role: "planning",
        expectedInputTokens: 100,
        expectedOutputTokens: 100,
        requiredTools: false,
        requiredVision: false,
        repositoryWrite: false,
        sensitive: false,
        likelyFiles: [],
        dependencies: [],
        risk: "low"
      },
      messages: [{ role: "user", content: "Plan it." }],
      cloudApproved: true,
      liveConfirmed: true
    });
    expect(result).toMatchObject({
      providerId: "b",
      text: "verified answer",
      fallbackAttempts: [
        { providerId: "a", outcome: "rate-limit" },
        { providerId: "b", outcome: "completed" }
      ]
    });
    expect(database.routingDecision("task")).not.toBeNull();
    expect(database.usage("run")).toEqual([
      expect.objectContaining({ provider_id: "b", cached_tokens: 2 })
    ]);
    database.close();
  });

  it("refuses unconfirmed live calls and repository writes", async () => {
    const database = new AgentDatabase();
    const service = new ProviderService(database, new MemorySecretStore(), () => {
      throw new Error("not reached");
    });
    const base = {
      task: {
        id: "task",
        runId: "run",
        title: "Write",
        description: "Write",
        role: "coding" as const,
        expectedInputTokens: 10,
        expectedOutputTokens: 10,
        requiredTools: true,
        requiredVision: false,
        repositoryWrite: true,
        sensitive: false,
        likelyFiles: ["src/a.ts"],
        dependencies: [],
        risk: "medium" as const
      },
      messages: [{ role: "user" as const, content: "Write." }],
      cloudApproved: true,
      liveConfirmed: true
    };
    await expect(service.executeReadOnly({ ...base, liveConfirmed: false })).rejects.toThrow(
      "explicit confirmation"
    );
    await expect(service.executeReadOnly(base)).rejects.toThrow("approved Codex worktree");
    database.close();
  });
});
