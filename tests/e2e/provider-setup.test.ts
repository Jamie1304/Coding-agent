import { createDaemon } from "../../apps/daemon/src/server.js";
import { MemorySecretStore, type ProviderConfiguration, type ProviderType } from "@agent/ai";

const token = "provider-test-token";
const auth = { "x-agent-token": token, "content-type": "application/json" };

function configuration(type: ProviderType): ProviderConfiguration {
  const now = new Date().toISOString();
  return {
    id: type,
    type,
    displayName: type,
    enabled: true,
    baseUrl: "http://127.0.0.1:9876",
    secretReference: null,
    organization: null,
    project: null,
    mode: type === "openai" ? "responses" : "chat-completions",
    modelsPath:
      type === "google" ? "/v1beta/models" : type === "ollama" ? "/api/tags" : "/v1/models",
    timeoutMs: 2_000,
    tlsVerification: true,
    sensitiveHeadersReference: null,
    nonSecretHeaders: {},
    manualModels: [],
    createdAt: now,
    updatedAt: now
  };
}

describe("in-app provider setup API", () => {
  it("stores credentials privately, discovers models, assigns roles, and simulates routing", async () => {
    const realFetch = globalThis.fetch;
    let daemonUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (daemonUrl && url.startsWith(daemonUrl)) return realFetch(input, init);
        if (url.includes("/v1beta/models")) {
          return Response.json({ models: [{ name: "models/gemini-test" }] });
        }
        if (url.includes("/api/tags")) {
          return Response.json({ models: [{ name: "ollama-test" }] });
        }
        return Response.json({ data: [{ id: "model-test" }] });
      })
    );
    const daemon = await createDaemon({ token, secretStore: new MemorySecretStore() });
    daemonUrl = daemon.url;
    try {
      for (const type of [
        "openai",
        "anthropic",
        "google",
        "xai",
        "ollama",
        "openai-compatible"
      ] as ProviderType[]) {
        const created = await fetch(`${daemon.url}/api/providers`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify(configuration(type))
        });
        expect(created.status).toBe(201);
        if (type !== "ollama") {
          if (type === "openai") {
            const ephemeral = await fetch(`${daemon.url}/api/providers/${type}/test-secret`, {
              method: "POST",
              headers: auth,
              body: JSON.stringify({ secret: "fake-ephemeral-credential" })
            });
            expect(ephemeral.status).toBe(200);
            expect(await ephemeral.text()).not.toContain("fake-ephemeral-credential");
          }
          const stored = await fetch(`${daemon.url}/api/providers/${type}/secret`, {
            method: "POST",
            headers: auth,
            body: JSON.stringify({ secret: `fake-${type}-credential` })
          });
          expect(JSON.stringify(await stored.json())).not.toContain(`fake-${type}-credential`);
        }
        const refreshed = await fetch(`${daemon.url}/api/providers/${type}/refresh-models`, {
          method: "POST",
          headers: auth,
          body: "{}"
        });
        expect(refreshed.status).toBe(200);
      }

      const enabled = await fetch(
        `${daemon.url}/api/models/openai/${encodeURIComponent("model-test")}`,
        {
          method: "PATCH",
          headers: auth,
          body: JSON.stringify({ enabled: true, roles: ["planning", "balanced", "fallback"] })
        }
      );
      expect(enabled.status).toBe(200);
      const simulated = await fetch(`${daemon.url}/api/routing/simulate`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          id: "sim",
          runId: "sim",
          title: "Plan",
          description: "Plan a contained API change",
          role: "planning",
          expectedInputTokens: 1_000,
          expectedOutputTokens: 500,
          requiredTools: false,
          requiredVision: false,
          repositoryWrite: false,
          sensitive: false,
          likelyFiles: [],
          dependencies: [],
          risk: "medium"
        })
      });
      expect(await simulated.json()).toMatchObject({
        selectedProviderId: "openai",
        selectedModelId: "model-test"
      });
      const pullPlan = await fetch(`${daemon.url}/api/ollama/models/pull-plan`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ providerId: "ollama", model: "ollama-test" })
      });
      expect(await pullPlan.json()).toEqual(
        expect.objectContaining({
          model: "ollama-test",
          freeDiskBytes: expect.any(Number),
          suitability: expect.any(String)
        })
      );
      const exported = await fetch(`${daemon.url}/api/config/export`, {
        method: "POST",
        headers: auth,
        body: "{}"
      });
      const exportText = await exported.text();
      expect(exportText).not.toContain("fake-openai-credential");
      expect(exportText).not.toContain("secretReference");
      const imported = await fetch(`${daemon.url}/api/config/import`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ mode: "merge", configuration: JSON.parse(exportText) })
      });
      expect(await imported.json()).toEqual(
        expect.objectContaining({
          importedProviders: 6,
          importedModels: expect.any(Number),
          missingCredentials: []
        })
      );
    } finally {
      await daemon.close();
      vi.unstubAllGlobals();
    }
  });
});
