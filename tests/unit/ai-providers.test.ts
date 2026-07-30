import {
  AnthropicProvider,
  GoogleProvider,
  MemorySecretStore,
  OllamaProvider,
  OpenAiCompatibleProvider,
  OpenAiProvider,
  XaiProvider,
  type AiProvider,
  type ProviderConfiguration,
  type ProviderType,
  type UnifiedModelRequest
} from "@agent/ai";

const now = new Date().toISOString();

function configuration(type: ProviderType): ProviderConfiguration {
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

function request(model: string): UnifiedModelRequest {
  return {
    requestId: crypto.randomUUID(),
    runId: "run",
    taskId: "task",
    model,
    role: "planning",
    messages: [{ role: "user", content: "Return hello." }],
    tools: [{ name: "inspect", description: "Inspect", inputSchema: { type: "object" } }],
    responseSchema: { type: "object", properties: { answer: { type: "string" } } },
    limits: { maxOutputTokens: 100, timeoutMs: 2_000, maximumCost: 1 },
    preferences: {
      reasoningLevel: "low",
      latencyPreference: "balanced",
      requireStructuredOutput: true,
      allowWebGrounding: false
    },
    caching: { enabled: true, cacheKey: "test" },
    metadata: {}
  };
}

async function collect(provider: AiProvider, config: ProviderConfiguration) {
  const events = [];
  for await (const event of provider.generate(request("model-a"), config)) events.push(event);
  return events;
}

describe("provider adapter contract", () => {
  const secrets = new MemorySecretStore();
  const cases: Array<{
    type: ProviderType;
    create(): AiProvider;
    discovery: unknown;
    stream: string;
    contentType: string;
  }> = [
    {
      type: "openai",
      create: () => new OpenAiProvider("openai", "OpenAI", secrets),
      discovery: { data: [{ id: "model-a" }] },
      stream:
        'data: {"type":"response.output_text.delta","delta":"hello"}\n\n' +
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
      contentType: "text/event-stream"
    },
    {
      type: "anthropic",
      create: () => new AnthropicProvider("anthropic", "Anthropic", secrets),
      discovery: { data: [{ id: "model-a", display_name: "Model A" }] },
      stream:
        'data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n' +
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n' +
        'data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n' +
        'data: {"type":"message_stop"}\n\n',
      contentType: "text/event-stream"
    },
    {
      type: "google",
      create: () => new GoogleProvider("google", "Google", secrets),
      discovery: { models: [{ name: "models/model-a", displayName: "Model A" }] },
      stream:
        'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}\n\n',
      contentType: "text/event-stream"
    },
    {
      type: "xai",
      create: () => new XaiProvider("xai", "xAI", secrets),
      discovery: { data: [{ id: "model-a" }] },
      stream:
        'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
      contentType: "text/event-stream"
    },
    {
      type: "openai-compatible",
      create: () => new OpenAiCompatibleProvider("openai-compatible", "Compatible", secrets),
      discovery: { data: [{ id: "model-a" }] },
      stream:
        'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
      contentType: "text/event-stream"
    },
    {
      type: "ollama",
      create: () => new OllamaProvider("ollama", "Ollama", secrets),
      discovery: { models: [{ name: "model-a", size: 42 }] },
      stream:
        '{"message":{"content":"hello"},"done":false}\n' +
        '{"message":{"content":""},"done":true,"prompt_eval_count":4,"eval_count":2}\n',
      contentType: "application/x-ndjson"
    }
  ];

  it.each(cases)("$type validates, discovers, streams, and normalizes usage", async (item) => {
    const config = configuration(item.type);
    const provider = item.create();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const target = String(input);
        const generation =
          target.includes("/responses") ||
          target.includes("/messages") ||
          target.includes("streamGenerateContent") ||
          target.includes("/chat/completions") ||
          target.includes("/api/chat");
        return generation
          ? new Response(item.stream, {
              status: 200,
              headers: { "content-type": item.contentType }
            })
          : Response.json(item.discovery);
      })
    );

    expect((await provider.validateConfiguration(config)).valid).toBe(true);
    expect(await provider.listModels(config)).toEqual([
      expect.objectContaining({ modelId: "model-a", providerId: item.type, enabled: false })
    ]);
    expect(await provider.testConnection(config)).toEqual(
      expect.objectContaining({ connected: true })
    );
    const events = await collect(provider, config);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "started" }),
        expect.objectContaining({ type: "text-delta", text: "hello" }),
        expect.objectContaining({ type: "usage" }),
        expect.objectContaining({ type: "completed" })
      ])
    );
  });

  it("normalizes rate limits without exposing provider response bodies", async () => {
    const provider = new OpenAiProvider("openai", "OpenAI", secrets);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("secret-token rate limit details", {
            status: 429,
            headers: { "retry-after": "2" }
          })
      )
    );
    const events = await collect(provider, configuration("openai"));
    expect(events).toContainEqual({ type: "rate-limit", retryAfterMs: 2_000 });
    expect(JSON.stringify(events)).not.toContain("secret-token");
  });

  it.each([
    {
      provider: new AnthropicProvider("anthropic", "Anthropic", secrets),
      config: configuration("anthropic"),
      response: { input_tokens: 17 },
      expected: 17
    },
    {
      provider: new GoogleProvider("google", "Google", secrets),
      config: configuration("google"),
      response: { totalTokens: 19 },
      expected: 19
    }
  ])("uses provider token counting", async ({ provider, config, response, expected }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(response))
    );
    await expect(provider.countTokens(request("model-a"), config)).resolves.toEqual({
      inputTokens: expected,
      source: "provider"
    });
  });

  afterEach(() => vi.unstubAllGlobals());
});
