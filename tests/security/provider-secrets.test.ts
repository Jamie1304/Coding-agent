import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentDatabase } from "@agent/database";
import { MemorySecretStore, maskSecret, type ProviderConfiguration } from "@agent/ai";
import { ProviderService, defaultProviderConfiguration, redactSecrets } from "@agent/core";
import { temporaryProject } from "../helpers.js";

describe("provider secret isolation", () => {
  it("stores, replaces, masks, deletes, and excludes credentials from SQLite/export", async () => {
    const directory = await temporaryProject();
    const databasePath = join(directory, "agent.sqlite");
    const database = new AgentDatabase(databasePath);
    const store = new MemorySecretStore();
    const service = new ProviderService(database, store, (configuration) => ({
      id: configuration.id,
      type: configuration.type,
      displayName: configuration.displayName,
      getCapabilities: () => ({
        streaming: true,
        tools: true,
        structuredOutput: true,
        vision: false,
        caching: false,
        tokenCounting: false,
        modelDiscovery: true,
        cancellation: true,
        local: false
      }),
      validateConfiguration: async () => ({ valid: true, errors: [], warnings: [] }),
      testConnection: async () => ({ connected: true, latencyMs: 1, message: "ok" }),
      listModels: async () => [],
      generate: async function* () {
        yield { type: "completed" as const, finishReason: "stop" };
      },
      cancel: async () => undefined,
      healthCheck: async () => ({
        healthy: true,
        message: "ok",
        checkedAt: new Date().toISOString()
      })
    }));
    const provider: ProviderConfiguration = defaultProviderConfiguration("openai");
    service.save(provider);
    const fakeKey = "sk-test-super-secret-value";
    const first = await service.storeSecret(provider.id, fakeKey);
    expect(first.masked).toBe(maskSecret(fakeKey));
    const second = await service.storeSecret(provider.id, "sk-test-replacement");
    expect(second.masked).toBe("••••ment");
    expect(service.get(provider.id).configuration).not.toHaveProperty("secretReference");
    expect(JSON.stringify(service.exportConfiguration())).not.toContain("sk-test");
    database.close();

    const databaseBytes = await readFile(databasePath);
    expect(databaseBytes.toString("utf8")).not.toContain(fakeKey);
    expect(redactSecrets(`failure ${fakeKey}`)).not.toContain(fakeKey);

    const reopened = new AgentDatabase(databasePath);
    const serviceAfterRestart = new ProviderService(reopened, store, () => {
      throw new Error("unused");
    });
    expect(await serviceAfterRestart.deleteSecret(provider.id)).toBe(true);
    reopened.close();
  });
});
