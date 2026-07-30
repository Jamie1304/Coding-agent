import type {
  AiProvider,
  DiscoveredModel,
  ModelUsage,
  ProviderCapabilities,
  ProviderConfiguration,
  ProviderType,
  UnifiedModelEvent,
  UnifiedModelRequest
} from "./contracts.js";
import type { SecretStore } from "./secrets.js";
import { checkedFetch, failureEvent, parseNdjson, parseSse } from "./http.js";

interface JsonObject {
  [key: string]: unknown;
}

abstract class HttpProvider implements AiProvider {
  protected controllers = new Map<string, AbortController>();
  protected lastHealth = {
    healthy: false,
    message: "Not checked",
    checkedAt: new Date(0).toISOString()
  };

  abstract readonly type: ProviderType;
  constructor(
    readonly id: string,
    readonly displayName: string,
    protected readonly secrets: SecretStore
  ) {}
  abstract getCapabilities(): ProviderCapabilities;
  abstract listModels(configuration: ProviderConfiguration): Promise<DiscoveredModel[]>;
  abstract generate(
    request: UnifiedModelRequest,
    configuration: ProviderConfiguration
  ): AsyncIterable<UnifiedModelEvent>;

  async validateConfiguration(configuration: ProviderConfiguration) {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (configuration.id !== this.id) errors.push("Configuration ID does not match provider");
    if (configuration.type !== this.type) errors.push("Configuration type does not match provider");
    const url = new URL(configuration.baseUrl);
    if (!configuration.tlsVerification && url.protocol !== "http:") {
      warnings.push("TLS verification override is ignored by the built-in fetch transport");
    }
    if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
      errors.push("Remote provider endpoints must use HTTPS");
    }
    if (this.type !== "ollama" && !configuration.secretReference) {
      warnings.push("No API credential is stored");
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  async testConnection(configuration: ProviderConfiguration) {
    const started = performance.now();
    try {
      const models = await this.listModels(configuration);
      const result = {
        connected: true,
        latencyMs: Math.round(performance.now() - started),
        message: `${models.length} model(s) discovered`
      };
      this.lastHealth = {
        healthy: true,
        message: result.message,
        checkedAt: new Date().toISOString()
      };
      return result;
    } catch (error) {
      const result = {
        connected: false,
        latencyMs: Math.round(performance.now() - started),
        message: error instanceof Error ? error.message : "Connection failed"
      };
      this.lastHealth = {
        healthy: false,
        message: result.message,
        checkedAt: new Date().toISOString()
      };
      return result;
    }
  }

  async cancel(requestId: string): Promise<void> {
    this.controllers.get(requestId)?.abort();
  }

  async healthCheck() {
    return this.lastHealth;
  }

  protected async secret(configuration: ProviderConfiguration): Promise<string | null> {
    return configuration.secretReference
      ? await this.secrets.get(configuration.secretReference)
      : null;
  }

  protected controller(requestId: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    return controller;
  }

  protected complete(requestId: string): void {
    this.controllers.delete(requestId);
  }

  protected model(
    configuration: ProviderConfiguration,
    modelId: string,
    metadata: JsonObject = {},
    capabilities: Partial<ProviderCapabilities> = {}
  ): DiscoveredModel {
    const base = this.getCapabilities();
    return {
      providerId: configuration.id,
      modelId,
      displayName: modelId,
      available: true,
      enabled: false,
      local: base.local,
      supportsStreaming: capabilities.streaming ?? base.streaming,
      supportsTools: capabilities.tools ?? base.tools,
      supportsStructuredOutput: capabilities.structuredOutput ?? base.structuredOutput,
      supportsVision: capabilities.vision ?? base.vision,
      supportsCaching: capabilities.caching ?? base.caching,
      supportsTokenCounting: capabilities.tokenCounting ?? base.tokenCounting,
      contextWindow: numberOrNull(metadata.contextWindow ?? metadata.inputTokenLimit),
      maxOutputTokens: numberOrNull(metadata.maxOutputTokens ?? metadata.outputTokenLimit),
      roles: [],
      weaknesses: [],
      inputPricePerMillion: numberOrNull(metadata.inputPricePerMillion),
      outputPricePerMillion: numberOrNull(metadata.outputPricePerMillion),
      cachedInputPricePerMillion: numberOrNull(metadata.cachedInputPricePerMillion),
      maximumConcurrency: 1,
      defaultTimeoutMs: configuration.timeoutMs,
      maximumTaskCost: null,
      metadataSource: "provider_discovery",
      metadata,
      lastTestedAt: null,
      averageLatencyMs: null,
      historicalSuccessRate: null,
      notes: ""
    };
  }
}

export class OpenAiProvider extends HttpProvider {
  readonly type = "openai" as const;
  getCapabilities(): ProviderCapabilities {
    return capabilities({ vision: true, caching: true, tokenCounting: false });
  }

  async listModels(configuration: ProviderConfiguration): Promise<DiscoveredModel[]> {
    const response = await checkedFetch(
      url(configuration.baseUrl, configuration.modelsPath),
      { headers: await bearerHeaders(this.secret(configuration), configuration) },
      configuration.timeoutMs
    );
    const body = (await response.json()) as { data?: Array<{ id: string; created?: number }> };
    return (body.data ?? []).map((item) =>
      this.model(configuration, item.id, { created: item.created })
    );
  }

  async *generate(
    request: UnifiedModelRequest,
    configuration: ProviderConfiguration
  ): AsyncGenerator<UnifiedModelEvent, void, unknown> {
    const controller = this.controller(request.requestId);
    const started = performance.now();
    let firstToken: number | null = null;
    yield startedEvent(request.requestId);
    try {
      const body: JsonObject = {
        model: request.model,
        input: request.messages.map((message) => ({
          role: message.role,
          content: message.content
        })),
        stream: true,
        max_output_tokens: request.limits.maxOutputTokens,
        reasoning: { effort: mapReasoning(request.preferences.reasoningLevel) }
      };
      if (request.tools?.length) body.tools = openAiTools(request);
      if (request.responseSchema) {
        body.text = {
          format: {
            type: "json_schema",
            name: "response",
            strict: true,
            schema: request.responseSchema
          }
        };
      }
      const response = await checkedFetch(
        url(configuration.baseUrl, "/v1/responses"),
        {
          method: "POST",
          headers: await jsonBearerHeaders(this.secret(configuration), configuration),
          body: JSON.stringify(body)
        },
        request.limits.timeoutMs,
        controller.signal
      );
      for await (const raw of parseSse(response)) {
        const event = raw as JsonObject;
        const type = String(event.type ?? "");
        if (type === "response.output_text.delta") {
          firstToken ??= performance.now();
          yield { type: "text-delta", text: String(event.delta ?? "") };
        } else if (type === "response.function_call_arguments.done") {
          yield {
            type: "tool-call",
            id: String(event.item_id ?? event.call_id ?? ""),
            name: String(event.name ?? ""),
            arguments: parseJson(event.arguments)
          };
        } else if (type === "response.completed") {
          const responseObject = event.response as JsonObject | undefined;
          yield {
            type: "usage",
            usage: normalizedUsage(
              this.id,
              request.model,
              responseObject?.usage as JsonObject | undefined,
              started,
              firstToken,
              "openai"
            )
          };
          yield { type: "completed", finishReason: "completed" };
        } else if (type === "response.refusal.delta") {
          yield { type: "refusal", reason: String(event.delta ?? "Provider refusal") };
        } else if (type === "error") {
          throw new Error(
            String((event.error as JsonObject | undefined)?.message ?? "OpenAI stream error")
          );
        }
      }
    } catch (error) {
      yield failureEvent(error);
    } finally {
      this.complete(request.requestId);
    }
  }
}

export class AnthropicProvider extends HttpProvider {
  readonly type = "anthropic" as const;
  getCapabilities(): ProviderCapabilities {
    return capabilities({ vision: true, caching: true, tokenCounting: true });
  }

  async listModels(configuration: ProviderConfiguration): Promise<DiscoveredModel[]> {
    const response = await checkedFetch(
      url(configuration.baseUrl, configuration.modelsPath || "/v1/models"),
      { headers: await anthropicHeaders(this.secret(configuration)) },
      configuration.timeoutMs
    );
    const body = (await response.json()) as { data?: Array<{ id: string; display_name?: string }> };
    return (body.data ?? []).map((item) => ({
      ...this.model(configuration, item.id),
      displayName: item.display_name ?? item.id
    }));
  }

  async countTokens(request: UnifiedModelRequest, configuration: ProviderConfiguration) {
    const response = await checkedFetch(
      url(configuration.baseUrl, "/v1/messages/count_tokens"),
      {
        method: "POST",
        headers: {
          ...(await anthropicHeaders(this.secret(configuration))),
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages
            .filter((message) => message.role !== "system")
            .map((message) => ({ role: message.role, content: message.content })),
          system: request.messages
            .filter((message) => message.role === "system")
            .map((message) => message.content)
            .join("\n")
        })
      },
      request.limits.timeoutMs
    );
    const body = (await response.json()) as { input_tokens?: number };
    return { inputTokens: body.input_tokens ?? null, source: "provider" as const };
  }

  async *generate(
    request: UnifiedModelRequest,
    configuration: ProviderConfiguration
  ): AsyncGenerator<UnifiedModelEvent, void, unknown> {
    const controller = this.controller(request.requestId);
    const started = performance.now();
    let firstToken: number | null = null;
    let usage: JsonObject | undefined;
    yield startedEvent(request.requestId);
    try {
      const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");
      const body: JsonObject = {
        model: request.model,
        max_tokens: request.limits.maxOutputTokens ?? 4_096,
        stream: true,
        messages: request.messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: message.role === "tool" ? "user" : message.role,
            content: message.content
          }))
      };
      if (system) body.system = system;
      if (request.tools?.length) {
        body.tools = request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
          strict: true
        }));
      }
      const response = await checkedFetch(
        url(configuration.baseUrl, "/v1/messages"),
        {
          method: "POST",
          headers: {
            ...(await anthropicHeaders(this.secret(configuration))),
            "content-type": "application/json"
          },
          body: JSON.stringify(body)
        },
        request.limits.timeoutMs,
        controller.signal
      );
      for await (const raw of parseSse(response)) {
        const event = raw as JsonObject;
        if (event.type === "content_block_delta") {
          const delta = event.delta as JsonObject | undefined;
          if (delta?.type === "text_delta") {
            firstToken ??= performance.now();
            yield { type: "text-delta", text: String(delta.text ?? "") };
          } else if (delta?.type === "input_json_delta") {
            // Partial tool JSON is emitted only when complete by content_block_stop.
          }
        } else if (event.type === "content_block_start") {
          const block = event.content_block as JsonObject | undefined;
          if (block?.type === "tool_use") {
            yield {
              type: "tool-call",
              id: String(block.id ?? ""),
              name: String(block.name ?? ""),
              arguments: block.input ?? {}
            };
          }
        } else if (event.type === "message_start") {
          usage = (event.message as JsonObject | undefined)?.usage as JsonObject | undefined;
        } else if (event.type === "message_delta") {
          usage = { ...usage, ...((event.usage as JsonObject | undefined) ?? {}) };
        } else if (event.type === "message_stop") {
          yield {
            type: "usage",
            usage: normalizedUsage(this.id, request.model, usage, started, firstToken, "anthropic")
          };
          yield { type: "completed", finishReason: "end_turn" };
        } else if (event.type === "error") {
          throw new Error("Anthropic stream error");
        }
      }
    } catch (error) {
      yield failureEvent(error);
    } finally {
      this.complete(request.requestId);
    }
  }
}

export class GoogleProvider extends HttpProvider {
  readonly type = "google" as const;
  getCapabilities(): ProviderCapabilities {
    return capabilities({ vision: true, caching: true, tokenCounting: true });
  }

  async listModels(configuration: ProviderConfiguration): Promise<DiscoveredModel[]> {
    const key = await this.secret(configuration);
    const response = await checkedFetch(
      withKey(url(configuration.baseUrl, configuration.modelsPath || "/v1beta/models"), key),
      {},
      configuration.timeoutMs
    );
    const body = (await response.json()) as {
      models?: Array<{
        name: string;
        displayName?: string;
        inputTokenLimit?: number;
        outputTokenLimit?: number;
        supportedGenerationMethods?: string[];
      }>;
    };
    return (body.models ?? []).map((item) => ({
      ...this.model(configuration, item.name.replace(/^models\//, ""), {
        inputTokenLimit: item.inputTokenLimit,
        outputTokenLimit: item.outputTokenLimit,
        supportedGenerationMethods: item.supportedGenerationMethods
      }),
      displayName: item.displayName ?? item.name
    }));
  }

  async countTokens(request: UnifiedModelRequest, configuration: ProviderConfiguration) {
    const key = await this.secret(configuration);
    const response = await checkedFetch(
      withKey(
        url(
          configuration.baseUrl,
          `/v1beta/models/${encodeURIComponent(request.model)}:countTokens`
        ),
        key
      ),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: request.messages
            .filter((message) => message.role !== "system")
            .map((message) => ({
              role: message.role === "assistant" ? "model" : "user",
              parts: [{ text: message.content }]
            }))
        })
      },
      request.limits.timeoutMs
    );
    const body = (await response.json()) as { totalTokens?: number };
    return { inputTokens: body.totalTokens ?? null, source: "provider" as const };
  }

  async *generate(
    request: UnifiedModelRequest,
    configuration: ProviderConfiguration
  ): AsyncGenerator<UnifiedModelEvent, void, unknown> {
    const controller = this.controller(request.requestId);
    const started = performance.now();
    let firstToken: number | null = null;
    yield startedEvent(request.requestId);
    try {
      const key = await this.secret(configuration);
      const endpoint = withKey(
        url(
          configuration.baseUrl,
          `/v1beta/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`
        ),
        key
      );
      const body: JsonObject = {
        contents: request.messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: message.role === "assistant" ? "model" : "user",
            parts: [{ text: message.content }]
          })),
        systemInstruction: {
          parts: request.messages
            .filter((message) => message.role === "system")
            .map((message) => ({ text: message.content }))
        },
        generationConfig: {
          maxOutputTokens: request.limits.maxOutputTokens,
          responseMimeType: request.responseSchema ? "application/json" : undefined,
          responseSchema: request.responseSchema
        }
      };
      if (request.tools?.length) {
        body.tools = [
          {
            functionDeclarations: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema
            }))
          }
        ];
      }
      const response = await checkedFetch(
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        },
        request.limits.timeoutMs,
        controller.signal
      );
      for await (const raw of parseSse(response)) {
        const chunk = raw as JsonObject;
        const candidates = chunk.candidates as Array<JsonObject> | undefined;
        const parts = ((candidates?.[0]?.content as JsonObject | undefined)?.parts ??
          []) as Array<JsonObject>;
        for (const part of parts) {
          if (typeof part.text === "string") {
            firstToken ??= performance.now();
            yield { type: "text-delta", text: part.text };
          }
          if (part.functionCall) {
            const call = part.functionCall as JsonObject;
            yield {
              type: "tool-call",
              id: request.requestId,
              name: String(call.name ?? ""),
              arguments: call.args ?? {}
            };
          }
        }
        if (chunk.usageMetadata) {
          yield {
            type: "usage",
            usage: normalizedUsage(
              this.id,
              request.model,
              chunk.usageMetadata as JsonObject,
              started,
              firstToken,
              "google"
            )
          };
        }
        if (candidates?.[0]?.finishReason) {
          yield { type: "completed", finishReason: String(candidates[0].finishReason) };
        }
      }
    } catch (error) {
      yield failureEvent(error);
    } finally {
      this.complete(request.requestId);
    }
  }
}

export class OpenAiCompatibleProvider extends HttpProvider {
  readonly type: ProviderType = "openai-compatible";
  getCapabilities(): ProviderCapabilities {
    return capabilities({ vision: false, caching: false, tokenCounting: false });
  }

  async listModels(configuration: ProviderConfiguration): Promise<DiscoveredModel[]> {
    if (configuration.manualModels.length && !configuration.modelsPath) {
      return configuration.manualModels.map((model) => this.model(configuration, model));
    }
    const response = await checkedFetch(
      url(configuration.baseUrl, configuration.modelsPath),
      { headers: await bearerHeaders(this.secret(configuration), configuration) },
      configuration.timeoutMs
    );
    const body = (await response.json()) as { data?: Array<{ id: string }> };
    const ids = [
      ...new Set([...(body.data ?? []).map((item) => item.id), ...configuration.manualModels])
    ];
    return ids.map((model) => this.model(configuration, model));
  }

  async *generate(
    request: UnifiedModelRequest,
    configuration: ProviderConfiguration
  ): AsyncGenerator<UnifiedModelEvent, void, unknown> {
    const controller = this.controller(request.requestId);
    const started = performance.now();
    let firstToken: number | null = null;
    let lastUsage: JsonObject | undefined;
    yield startedEvent(request.requestId);
    try {
      const body: JsonObject = {
        model: request.model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content
        })),
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: request.limits.maxOutputTokens
      };
      if (request.tools?.length) body.tools = openAiTools(request);
      if (request.responseSchema) {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: "response", strict: true, schema: request.responseSchema }
        };
      }
      const response = await checkedFetch(
        url(configuration.baseUrl, "/v1/chat/completions"),
        {
          method: "POST",
          headers: await jsonBearerHeaders(this.secret(configuration), configuration),
          body: JSON.stringify(body)
        },
        request.limits.timeoutMs,
        controller.signal
      );
      for await (const raw of parseSse(response)) {
        const chunk = raw as JsonObject;
        lastUsage = (chunk.usage as JsonObject | undefined) ?? lastUsage;
        const choice = (chunk.choices as Array<JsonObject> | undefined)?.[0];
        const delta = choice?.delta as JsonObject | undefined;
        if (typeof delta?.content === "string") {
          firstToken ??= performance.now();
          yield { type: "text-delta", text: delta.content };
        }
        const calls = delta?.tool_calls as Array<JsonObject> | undefined;
        for (const call of calls ?? []) {
          const fn = call.function as JsonObject | undefined;
          yield {
            type: "tool-call",
            id: String(call.id ?? ""),
            name: String(fn?.name ?? ""),
            arguments: parseJson(fn?.arguments)
          };
        }
        if (choice?.finish_reason) {
          yield {
            type: "usage",
            usage: normalizedUsage(this.id, request.model, lastUsage, started, firstToken, "openai")
          };
          yield { type: "completed", finishReason: String(choice.finish_reason) };
        }
      }
    } catch (error) {
      yield failureEvent(error);
    } finally {
      this.complete(request.requestId);
    }
  }
}

export class XaiProvider extends OpenAiCompatibleProvider {
  override readonly type = "xai" as const;
  override getCapabilities(): ProviderCapabilities {
    return capabilities({ vision: true, caching: true, tokenCounting: false });
  }
}

export class OllamaProvider extends HttpProvider {
  readonly type = "ollama" as const;
  getCapabilities(): ProviderCapabilities {
    return capabilities({ local: true, vision: true, caching: false, tokenCounting: false });
  }

  async detect(
    configuration: ProviderConfiguration
  ): Promise<{ installed: boolean; running: boolean; version: string | null }> {
    try {
      const response = await checkedFetch(url(configuration.baseUrl, "/api/version"), {}, 3_000);
      const body = (await response.json()) as { version?: string };
      return { installed: true, running: true, version: body.version ?? null };
    } catch {
      return { installed: false, running: false, version: null };
    }
  }

  async listModels(configuration: ProviderConfiguration): Promise<DiscoveredModel[]> {
    const response = await checkedFetch(
      url(configuration.baseUrl, "/api/tags"),
      {},
      configuration.timeoutMs
    );
    const body = (await response.json()) as {
      models?: Array<{ name: string; size?: number; details?: unknown }>;
    };
    return (body.models ?? []).map((item) =>
      this.model(configuration, item.name, { size: item.size, details: item.details })
    );
  }

  async *pull(
    configuration: ProviderConfiguration,
    model: string,
    signal?: AbortSignal
  ): AsyncIterable<{ status: string; completed?: number; total?: number }> {
    const response = await checkedFetch(
      url(configuration.baseUrl, "/api/pull"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, stream: true })
      },
      3_600_000,
      signal
    );
    for await (const raw of parseNdjson(response))
      yield raw as { status: string; completed?: number; total?: number };
  }

  async remove(configuration: ProviderConfiguration, model: string): Promise<void> {
    await checkedFetch(
      url(configuration.baseUrl, "/api/delete"),
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model })
      },
      configuration.timeoutMs
    );
  }

  async *generate(
    request: UnifiedModelRequest,
    configuration: ProviderConfiguration
  ): AsyncGenerator<UnifiedModelEvent, void, unknown> {
    const controller = this.controller(request.requestId);
    const started = performance.now();
    let firstToken: number | null = null;
    yield startedEvent(request.requestId);
    try {
      const response = await checkedFetch(
        url(configuration.baseUrl, "/api/chat"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            tools: request.tools?.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema
              }
            })),
            format: request.responseSchema,
            stream: true
          })
        },
        request.limits.timeoutMs,
        controller.signal
      );
      for await (const raw of parseNdjson(response)) {
        const chunk = raw as JsonObject;
        const message = chunk.message as JsonObject | undefined;
        if (typeof message?.content === "string" && message.content) {
          firstToken ??= performance.now();
          yield { type: "text-delta", text: message.content };
        }
        for (const call of (message?.tool_calls as Array<JsonObject> | undefined) ?? []) {
          const fn = call.function as JsonObject;
          yield {
            type: "tool-call",
            id: request.requestId,
            name: String(fn.name ?? ""),
            arguments: fn.arguments ?? {}
          };
        }
        if (chunk.done) {
          yield {
            type: "usage",
            usage: normalizedUsage(this.id, request.model, chunk, started, firstToken, "ollama")
          };
          yield { type: "completed", finishReason: String(chunk.done_reason ?? "stop") };
        }
      }
    } catch (error) {
      yield failureEvent(error);
    } finally {
      this.complete(request.requestId);
    }
  }
}

function capabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    streaming: true,
    tools: true,
    structuredOutput: true,
    vision: false,
    caching: false,
    tokenCounting: false,
    modelDiscovery: true,
    cancellation: true,
    local: false,
    ...overrides
  };
}

function url(base: string, path: string): string {
  return new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`).toString();
}

function withKey(endpoint: string, key: string | null): string {
  const parsed = new URL(endpoint);
  if (key) parsed.searchParams.set("key", key);
  return parsed.toString();
}

async function bearerHeaders(
  secret: Promise<string | null>,
  configuration: ProviderConfiguration
): Promise<Record<string, string>> {
  const value = await secret;
  return {
    ...configuration.nonSecretHeaders,
    ...(value ? { authorization: `Bearer ${value}` } : {})
  };
}

async function jsonBearerHeaders(
  secret: Promise<string | null>,
  configuration: ProviderConfiguration
): Promise<Record<string, string>> {
  return { ...(await bearerHeaders(secret, configuration)), "content-type": "application/json" };
}

async function anthropicHeaders(secret: Promise<string | null>): Promise<Record<string, string>> {
  const value = await secret;
  return { "anthropic-version": "2023-06-01", ...(value ? { "x-api-key": value } : {}) };
}

function isLoopback(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
}

function startedEvent(requestId: string): UnifiedModelEvent {
  return { type: "started", requestId, timestamp: new Date().toISOString() };
}

function openAiTools(request: UnifiedModelRequest): JsonObject[] {
  return (request.tools ?? []).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: true
  }));
}

function mapReasoning(value: UnifiedModelRequest["preferences"]["reasoningLevel"]): string {
  return value === "maximum" ? "max" : value;
}

function normalizedUsage(
  providerId: string,
  modelId: string,
  usage: JsonObject | undefined,
  started: number,
  firstToken: number | null,
  shape: "openai" | "anthropic" | "google" | "ollama"
): ModelUsage {
  const input =
    shape === "google"
      ? usage?.promptTokenCount
      : shape === "ollama"
        ? usage?.prompt_eval_count
        : (usage?.input_tokens ?? usage?.prompt_tokens);
  const output =
    shape === "google"
      ? usage?.candidatesTokenCount
      : shape === "ollama"
        ? usage?.eval_count
        : (usage?.output_tokens ?? usage?.completion_tokens);
  const cached =
    shape === "google"
      ? usage?.cachedContentTokenCount
      : (usage?.cache_read_input_tokens ??
        (usage?.input_tokens_details as JsonObject | undefined)?.cached_tokens ??
        (usage?.prompt_tokens_details as JsonObject | undefined)?.cached_tokens);
  const reasoning =
    shape === "google"
      ? usage?.thoughtsTokenCount
      : ((usage?.output_tokens_details as JsonObject | undefined)?.reasoning_tokens ??
        (usage?.completion_tokens_details as JsonObject | undefined)?.reasoning_tokens);
  return {
    providerId,
    modelId,
    inputTokens: numberOrNull(input),
    cachedInputTokens: numberOrNull(cached),
    outputTokens: numberOrNull(output),
    reasoningTokens: numberOrNull(reasoning),
    totalTokens:
      numberOrNull(usage?.total_tokens ?? usage?.totalTokenCount) ?? sumKnown(input, output),
    estimatedCost: null,
    actualCost: null,
    latencyMs: Math.round(performance.now() - started),
    timeToFirstTokenMs: firstToken === null ? null : Math.round(firstToken - started)
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sumKnown(...values: unknown[]): number | null {
  const numbers = values.filter((value): value is number => typeof value === "number");
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
