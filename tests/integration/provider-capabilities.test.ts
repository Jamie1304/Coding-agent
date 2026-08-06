import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentDatabase } from "@agent/database";
import type { DiscoveredModel } from "@agent/ai";

describe("Provider Capability Normalization", () => {
  let db: AgentDatabase;

  beforeEach(() => {
    db = new AgentDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function createTestModel(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
    return {
      providerId: "anthropic",
      modelId: "claude-3.5-sonnet",
      displayName: "Claude 3.5 Sonnet",
      available: true,
      enabled: true,
      local: false,
      supportsStreaming: true,
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      supportsCaching: true,
      supportsTokenCounting: true,
      supportsRepositoryWrite: false,
      contextWindow: 200000,
      maxOutputTokens: 4096,
      roles: ["primary_coder", "reviewer"],
      weaknesses: [],
      inputPricePerMillion: 3.0,
      outputPricePerMillion: 15.0,
      cachedInputPricePerMillion: 0.3,
      maximumConcurrency: 5,
      defaultTimeoutMs: 120000,
      maximumTaskCost: 10.0,
      metadataSource: "official_preset",
      metadata: {},
      lastTestedAt: new Date().toISOString(),
      averageLatencyMs: 2500,
      historicalSuccessRate: 0.98,
      notes: "Frontier model with strong reasoning",
      ...overrides
    };
  }

  function createTestProvider(providerId: string, displayName: string = providerId) {
    try {
      db.raw
        .prepare(
          "INSERT OR IGNORE INTO providers VALUES(?,?,?,?,?,?,?,?,?,?,?)"
        )
        .run(
          providerId,
          providerId,
          displayName,
          1,
          "https://api.example.com",
          "{}",
          null,
          "not_configured",
          null,
          new Date().toISOString(),
          new Date().toISOString()
        );
    } catch {
      // Provider might already exist
    }
  }

  describe("DiscoveredModel schema", () => {
    it("should validate DiscoveredModel with supportsRepositoryWrite", () => {
      const model = createTestModel({ supportsRepositoryWrite: true });
      expect(model.supportsRepositoryWrite).toBe(true);
    });

    it("should default supportsRepositoryWrite to false", () => {
      const model = createTestModel();
      expect(model.supportsRepositoryWrite).toBe(false);
    });

    it("should include repository write in model metadata", () => {
      const model = createTestModel({ supportsRepositoryWrite: true });
      const modelWithWrite = createTestModel({ supportsRepositoryWrite: true });

      expect(modelWithWrite.supportsRepositoryWrite).toBe(true);
    });
  });

  describe("Database capability tracking", () => {
    it("should store models with repository write support", () => {
      const model = createTestModel({
        providerId: "anthropic",
        modelId: "claude-opus",
        supportsRepositoryWrite: true
      });

      createTestProvider("anthropic", "Anthropic");
      db.saveModel(model);

      const retrieved = db.models("anthropic").find((m) => m.modelId === "claude-opus");
      expect(retrieved).not.toBeUndefined();
      expect(retrieved?.supportsRepositoryWrite).toBe(true);
    });

    it("should track repository write capability separately", () => {
      const model = createTestModel({
        providerId: "anthropic",
        modelId: "claude-opus",
        supportsRepositoryWrite: true
      });

      createTestProvider("anthropic", "Anthropic");
      db.saveModel(model);

      const supportsWrite = db.modelSupportsRepositoryWrite("anthropic", "claude-opus");
      expect(supportsWrite).toBe(true);
    });

    it("should return false for models without repository write support", () => {
      const model = createTestModel({
        providerId: "anthropic",
        modelId: "claude-haiku",
        supportsRepositoryWrite: false
      });

      createTestProvider("anthropic", "Anthropic");
      db.saveModel(model);

      const supportsWrite = db.modelSupportsRepositoryWrite("anthropic", "claude-haiku");
      expect(supportsWrite).toBe(false);
    });

    it("should list all models with repository write support", () => {
      const models = [
        createTestModel({
          providerId: "anthropic",
          modelId: "claude-opus",
          supportsRepositoryWrite: true
        }),
        createTestModel({
          providerId: "anthropic",
          modelId: "claude-sonnet",
          supportsRepositoryWrite: true
        }),
        createTestModel({
          providerId: "anthropic",
          modelId: "claude-haiku",
          supportsRepositoryWrite: false
        }),
        createTestModel({
          providerId: "openai",
          modelId: "gpt-4",
          supportsRepositoryWrite: true
        })
      ];

      createTestProvider("anthropic", "Anthropic");
      createTestProvider("openai", "OpenAI");

      models.forEach((m) => db.saveModel(m));

      const repoWriteModels = db.modelsWithRepositoryWriteSupport();
      expect(repoWriteModels).toHaveLength(3);
      expect(repoWriteModels.some((m) => m.modelId === "claude-opus")).toBe(true);
      expect(repoWriteModels.some((m) => m.modelId === "claude-haiku")).toBe(false);
      expect(repoWriteModels.some((m) => m.modelId === "gpt-4")).toBe(true);
    });

    it("should filter repository write models by provider", () => {
      const models = [
        createTestModel({
          providerId: "anthropic",
          modelId: "claude-opus",
          supportsRepositoryWrite: true
        }),
        createTestModel({
          providerId: "anthropic",
          modelId: "claude-haiku",
          supportsRepositoryWrite: false
        }),
        createTestModel({
          providerId: "openai",
          modelId: "gpt-4",
          supportsRepositoryWrite: true
        })
      ];

      createTestProvider("anthropic", "Anthropic");
      createTestProvider("openai", "OpenAI");

      models.forEach((m) => db.saveModel(m));

      const anthropicModels = db.modelsWithRepositoryWriteSupport("anthropic");
      expect(anthropicModels).toHaveLength(1);
      expect(anthropicModels[0].modelId).toBe("claude-opus");

      const openaiModels = db.modelsWithRepositoryWriteSupport("openai");
      expect(openaiModels).toHaveLength(1);
      expect(openaiModels[0].modelId).toBe("gpt-4");
    });

    it("should return empty list when no models support repository write", () => {
      const model = createTestModel({
        providerId: "anthropic",
        modelId: "claude-haiku",
        supportsRepositoryWrite: false
      });

      createTestProvider("anthropic", "Anthropic");
      db.saveModel(model);

      const repoWriteModels = db.modelsWithRepositoryWriteSupport();
      expect(repoWriteModels).toHaveLength(0);
    });
  });

  describe("Capability normalization workflow", () => {
    it("should normalize multi-provider models with different capabilities", () => {
      const providers = [
        {
          id: "anthropic",
          models: [
            createTestModel({
              providerId: "anthropic",
              modelId: "claude-opus",
              supportsRepositoryWrite: true,
              inputPricePerMillion: 15.0,
              outputPricePerMillion: 75.0
            }),
            createTestModel({
              providerId: "anthropic",
              modelId: "claude-sonnet",
              supportsRepositoryWrite: false,
              inputPricePerMillion: 3.0,
              outputPricePerMillion: 15.0
            })
          ]
        },
        {
          id: "openai",
          models: [
            createTestModel({
              providerId: "openai",
              modelId: "gpt-4-turbo",
              supportsRepositoryWrite: true,
              inputPricePerMillion: 10.0,
              outputPricePerMillion: 30.0
            }),
            createTestModel({
              providerId: "openai",
              modelId: "gpt-4-mini",
              supportsRepositoryWrite: false,
              inputPricePerMillion: 0.15,
              outputPricePerMillion: 0.6
            })
          ]
        }
      ];

      // Create providers first
      providers.forEach((provider) => {
        createTestProvider(provider.id, provider.id);
      });

      // Persist all models
      providers.forEach((provider) => {
        provider.models.forEach((model) => {
          db.saveModel(model);
        });
      });

      // Verify capabilities are stored correctly
      expect(db.modelSupportsRepositoryWrite("anthropic", "claude-opus")).toBe(true);
      expect(db.modelSupportsRepositoryWrite("anthropic", "claude-sonnet")).toBe(false);
      expect(db.modelSupportsRepositoryWrite("openai", "gpt-4-turbo")).toBe(true);
      expect(db.modelSupportsRepositoryWrite("openai", "gpt-4-mini")).toBe(false);

      // Query all repository write models
      const repoWriteModels = db.modelsWithRepositoryWriteSupport();
      expect(repoWriteModels).toHaveLength(2);

      // Verify we can use capabilities for routing decisions
      const eligibleForRepositoryWrite = repoWriteModels.every((m) =>
        db.modelSupportsRepositoryWrite(m.providerId, m.modelId)
      );
      expect(eligibleForRepositoryWrite).toBe(true);
    });

    it("should support capability verification workflow", () => {
      createTestProvider("anthropic", "Anthropic");

      // Initially unknown capability
      const model1 = createTestModel({
        providerId: "anthropic",
        modelId: "claude-new",
        supportsRepositoryWrite: false, // Unknown
        notes: "Capability not yet verified"
      });

      db.saveModel(model1);
      expect(db.modelSupportsRepositoryWrite("anthropic", "claude-new")).toBe(false);

      // After verification, update with confirmed capability
      const model1Updated = createTestModel({
        providerId: "anthropic",
        modelId: "claude-new",
        supportsRepositoryWrite: true, // Verified
        notes: "Verified support for repository writes"
      });

      db.saveModel(model1Updated);
      expect(db.modelSupportsRepositoryWrite("anthropic", "claude-new")).toBe(true);
    });
  });

  describe("Migration compatibility", () => {
    it("should apply provider capability migration", () => {
      // Verify migration adds the repository write column to provider_models
      const migrations = db.raw
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>;

      expect(migrations.some((m) => m.version === 6)).toBe(true);
    });

    it("should handle provider_models with repository write column", () => {
      createTestProvider("anthropic", "Anthropic");

      const model = createTestModel({
        providerId: "anthropic",
        modelId: "claude-test",
        supportsRepositoryWrite: true
      });

      db.saveModel(model);

      // Verify column exists and can be queried
      const result = db.raw
        .prepare("SELECT supports_repository_write FROM provider_models WHERE provider_id=? AND model_id=?")
        .get("anthropic", "claude-test") as { supports_repository_write: number } | undefined;

      expect(result).not.toBeUndefined();
      expect(result?.supports_repository_write).toBe(1);
    });
  });

  describe("Edge cases and error handling", () => {
    it("should handle non-existent provider/model combination gracefully", () => {
      // When no provider exists, the model won't be found
      const supportsWrite = db.modelSupportsRepositoryWrite("nonexistent", "model");
      expect(supportsWrite).toBe(false);
    });

    it("should maintain backward compatibility with models missing capability", () => {
      // Create provider first
      db.raw
        .prepare(
          "INSERT INTO providers VALUES(?,?,?,?,?,?,?,?,?,?,?)"
        )
        .run(
          "anthropic",
          "anthropic",
          "Anthropic",
          1,
          "https://api.anthropic.com",
          "{}",
          null,
          "not_configured",
          null,
          new Date().toISOString(),
          new Date().toISOString()
        );

      // Create a model without explicit repository write support
      const model = createTestModel({
        providerId: "anthropic",
        modelId: "legacy-model"
      });

      db.saveModel(model);

      // Should default to false
      expect(db.modelSupportsRepositoryWrite("anthropic", "legacy-model")).toBe(false);
    });

    it("should allow updating capability status", () => {
      // Create provider first
      db.raw
        .prepare(
          "INSERT INTO providers VALUES(?,?,?,?,?,?,?,?,?,?,?)"
        )
        .run(
          "anthropic",
          "anthropic",
          "Anthropic",
          1,
          "https://api.anthropic.com",
          "{}",
          null,
          "not_configured",
          null,
          new Date().toISOString(),
          new Date().toISOString()
        );

      const model1 = createTestModel({
        providerId: "anthropic",
        modelId: "model-v1",
        supportsRepositoryWrite: false
      });

      db.saveModel(model1);
      expect(db.modelSupportsRepositoryWrite("anthropic", "model-v1")).toBe(false);

      // Update with new capability
      const model2 = createTestModel({
        providerId: "anthropic",
        modelId: "model-v1",
        supportsRepositoryWrite: true
      });

      db.saveModel(model2);
      expect(db.modelSupportsRepositoryWrite("anthropic", "model-v1")).toBe(true);
    });
  });
});
