import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { AgentDatabase } from "@agent/database";
import {
  AnthropicProvider,
  GoogleProvider,
  MemorySecretStore,
  OllamaProvider,
  OpenAiCompatibleProvider,
  OpenAiProvider,
  ProviderConfigurationSchema,
  TaskDescriptorSchema,
  WindowsCredentialStore,
  XaiProvider,
  type AiProvider,
  type ProviderConfiguration,
  type SecretStore
} from "@agent/ai";
import {
  AnswersRequestSchema,
  CreateRunRequestSchema,
  RejectRequestSchema,
  WorkspaceSnapshotSchema
} from "@agent/shared";
import {
  ChangeAnalyzer,
  ExecutionOrchestrator,
  GhCliAdapter,
  ProviderService,
  RunService,
  WorkspaceInspector,
  redactSecrets
} from "@agent/core";
import type { CodexProvider } from "@agent/codex-provider";
import { runDoctor } from "../../../scripts/doctor-lib.js";

export interface DaemonOptions {
  host?: "127.0.0.1";
  port?: number;
  token?: string;
  dataDirectory?: string;
  database?: AgentDatabase;
  runService?: RunService;
  codexProvider?: CodexProvider;
  secretStore?: SecretStore;
  providerService?: ProviderService;
}

export interface DaemonHandle {
  app: FastifyInstance;
  token: string;
  url: string;
  close(): Promise<void>;
}

export async function createDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const token = options.token ?? randomBytes(32).toString("base64url");
  const dataDirectory =
    options.dataDirectory ??
    process.env.AGENT_DATA_DIR ??
    join(process.env.LOCALAPPDATA ?? process.cwd(), "PersonalCodexAgent");
  await mkdir(dataDirectory, { recursive: true });
  const database = options.database ?? new AgentDatabase(join(dataDirectory, "agent.sqlite"));
  const runService = options.runService ?? new RunService(database);
  const secretStore =
    options.secretStore ??
    (process.env.NODE_ENV === "test" ? new MemorySecretStore() : new WindowsCredentialStore());
  const providerService =
    options.providerService ?? new ProviderService(database, secretStore, createAiProvider);
  const inspector = new WorkspaceInspector();
  const orchestrator = options.codexProvider
    ? new ExecutionOrchestrator(runService, options.codexProvider, undefined, new GhCliAdapter())
    : null;
  let currentWorkspace: ReturnType<typeof WorkspaceSnapshotSchema.parse> | null = null;
  let currentWorkspaceHash: string | null = null;
  const app = Fastify({
    logger: {
      level: process.env.AGENT_LOG_LEVEL ?? "info",
      redact: {
        paths: ["req.headers.authorization", "req.headers.x-agent-token"],
        censor: "[REDACTED]"
      }
    },
    bodyLimit: 1_000_000
  });
  await app.register(websocket);

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    const allowedOrigin =
      origin === "null" ||
      (typeof origin === "string" && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
    if (allowedOrigin) {
      void reply.header("access-control-allow-origin", origin);
      void reply.header("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      if (!allowedOrigin) {
        await reply.code(403).send({ error: "origin_not_allowed" });
        return;
      }
      void reply.header("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
      void reply.header("access-control-allow-headers", "content-type,x-agent-token,authorization");
      await reply.code(204).send();
      return;
    }
    if (request.url === "/health") return;
    const provided =
      request.headers["x-agent-token"] ?? request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (provided !== token) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.setErrorHandler(async (error, request, reply) => {
    const handled = error as Error & { validation?: unknown };
    request.log.error({ error: redactSecrets(handled.message) }, "request failed");
    await reply.code(handled.validation ? 400 : 422).send({
      error: redactSecrets(handled.message),
      requestId: request.id
    });
  });

  app.get("/health", async () => ({ status: "ok", bind: host, version: "0.2.0" }));
  app.get("/api/setup/status", async () => {
    const provider = options.codexProvider;
    const [codex, auth] = provider
      ? await Promise.all([provider.checkAvailability(), provider.authenticate()])
      : [
          { available: false, version: null, reason: "Provider not initialized" },
          { authenticated: false, method: null, message: "Provider not initialized" }
        ];
    return {
      daemon: true,
      database: true,
      reportDirectory: dataDirectory,
      codex,
      codexAuth: auth,
      workspace: currentWorkspace
    };
  });
  app.get("/api/setup/diagnostics", async () => runDoctor(process.cwd()));

  app.get("/api/workspace/current", async () => {
    if (!currentWorkspace) {
      return { workspace: null, analysis: null, changed: false, snapshotHash: null };
    }
    return {
      workspace: currentWorkspace,
      analysis: await inspector.inspect(currentWorkspace.path),
      changed: false,
      snapshotHash: currentWorkspaceHash
    };
  });

  app.post("/api/workspace/current", async (request) => {
    const parsed = z
      .union([
        WorkspaceSnapshotSchema.transform((snapshot) => ({
          snapshot,
          metadata: {
            source: snapshot.source === "vscode" ? ("vscode" as const) : ("desktop" as const),
            timestamp: new Date().toISOString(),
            clientInstanceId: "legacy-client"
          }
        })),
        z.object({
          snapshot: WorkspaceSnapshotSchema,
          metadata: z.object({
            source: z.enum(["desktop", "vscode"]),
            timestamp: z.iso.datetime(),
            clientInstanceId: z.string().min(1).max(200)
          })
        })
      ])
      .parse(request.body);
    const snapshotHash = createHash("sha256").update(JSON.stringify(parsed.snapshot)).digest("hex");
    const changed = snapshotHash !== currentWorkspaceHash;
    currentWorkspace = parsed.snapshot;
    currentWorkspaceHash = snapshotHash;
    return {
      workspace: currentWorkspace,
      analysis: await inspector.inspect(currentWorkspace.path),
      changed,
      snapshotHash,
      metadata: parsed.metadata
    };
  });

  app.get("/api/runs", async () => ({ runs: runService.list() }));
  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request) =>
    runService.get(request.params.id)
  );
  app.post("/api/runs", async (request, reply) => {
    const input = CreateRunRequestSchema.parse(request.body);
    const run = await runService.create(input.workspacePath, input.prompt);
    return reply.code(201).send(run);
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/answers", async (request) => {
    const input = AnswersRequestSchema.parse(request.body);
    return runService.answer(request.params.id, input.answers);
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/approve", async (request) => {
    const body = request.body as { editedPrompt?: string } | undefined;
    const approved = await runService.approve(request.params.id, body?.editedPrompt);
    if (orchestrator) void orchestrator.execute(request.params.id);
    return approved;
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/reject", async (request) => {
    const input = RejectRequestSchema.parse(request.body);
    return runService.reject(request.params.id, input.reason);
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/analyze-change", async (request) => {
    const input = z.object({ suggestion: z.string().min(1).max(10_000) }).parse(request.body);
    let runView: ReturnType<typeof runService.get>;
    try {
      runView = runService.get(request.params.id);
    } catch {
      throw new Error("Run not found");
    }
    const revision = database.revisions(runView.run.id).at(-1);
    const analyzer = new ChangeAnalyzer();
    return analyzer.analyze(input.suggestion, revision?.content ?? "");
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (request) => {
    orchestrator?.cancel(request.params.id);
    return runService.cancel(request.params.id);
  });

  app.get("/api/providers", async () => ({ providers: providerService.list() }));
  app.get("/api/providers/registry", async () => ({
    providers: providerService.listProviderRecords()
  }));
  app.post("/api/providers", async (request, reply) => {
    const configuration = ProviderConfigurationSchema.parse(request.body);
    return reply.code(201).send(providerService.save(configuration));
  });
  app.get<{ Params: { id: string } }>("/api/providers/:id", async (request) =>
    providerService.get(request.params.id)
  );
  app.get<{ Params: { id: string } }>("/api/providers/:id/record", async (request) =>
    providerService.providerRecord(request.params.id)
  );
  app.patch<{ Params: { id: string } }>("/api/providers/:id", async (request) => {
    const current = database.provider(request.params.id);
    if (!current) throw new Error("Provider not found");
    return providerService.save({ ...current, ...(request.body as object), id: request.params.id });
  });
  app.delete<{ Params: { id: string }; Querystring: { deleteSecret?: string } }>(
    "/api/providers/:id",
    async (request) => ({
      deleted: await providerService.remove(
        request.params.id,
        request.query.deleteSecret === "true"
      )
    })
  );
  app.post<{ Params: { id: string } }>("/api/providers/:id/secret", async (request) => {
    const input = z.object({ secret: z.string().min(1).max(20_000) }).parse(request.body);
    return providerService.storeSecret(request.params.id, input.secret);
  });
  app.delete<{ Params: { id: string } }>("/api/providers/:id/secret", async (request) => ({
    deleted: await providerService.deleteSecret(request.params.id)
  }));
  app.post<{ Params: { id: string } }>("/api/providers/:id/test", async (request) =>
    providerService.test(request.params.id)
  );
  app.post<{ Params: { id: string } }>("/api/providers/:id/test-secret", async (request) => {
    const input = z.object({ secret: z.string().min(1).max(20_000) }).parse(request.body);
    return providerService.testWithSecret(request.params.id, input.secret);
  });
  app.post<{ Params: { id: string } }>("/api/providers/:id/refresh-models", async (request) => ({
    models: await providerService.refreshModels(request.params.id)
  }));
  app.get<{ Params: { id: string } }>("/api/providers/:id/models", async (request) => ({
    models: database.models(request.params.id)
  }));
  app.patch<{ Params: { providerId: string; modelId: string } }>(
    "/api/models/:providerId/:modelId",
    async (request) =>
      providerService.updateModel(
        request.params.providerId,
        decodeURIComponent(request.params.modelId),
        request.body
      )
  );
  app.post<{ Params: { providerId: string; modelId: string } }>(
    "/api/models/:providerId/:modelId/test",
    async (request) => {
      const result = await providerService.test(request.params.providerId);
      return { modelId: decodeURIComponent(request.params.modelId), ...result };
    }
  );
  app.get("/api/routing/config", async () => providerService.routingConfig());
  app.patch("/api/routing/config", async (request) =>
    providerService.saveRoutingConfig(request.body)
  );
  app.post("/api/routing/simulate", async (request) =>
    providerService.simulate(TaskDescriptorSchema.parse(request.body))
  );
  app.get("/api/budgets", async () => providerService.budgetConfig());
  app.patch("/api/budgets", async (request) => providerService.saveBudgetConfig(request.body));
  app.get("/api/usage", async () => ({ usage: database.usage() }));
  app.get<{ Params: { runId: string } }>("/api/usage/runs/:runId", async (request) => ({
    usage: database.usage(request.params.runId)
  }));
  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/routing-decision",
    async (request) => ({ decision: database.routingDecision(request.params.taskId) })
  );
  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/evidence", async (request) => ({
    evidence: database.evidence(request.params.taskId)
  }));
  app.post("/api/ai/tasks/execute", async (request) => {
    const input = z
      .object({
        task: TaskDescriptorSchema,
        messages: z
          .array(
            z.object({
              role: z.enum(["system", "user", "assistant", "tool"]),
              content: z.string().max(1_000_000),
              name: z.string().optional(),
              toolCallId: z.string().optional()
            })
          )
          .min(1),
        cloudApproved: z.boolean().default(false),
        liveConfirmed: z.literal(true),
        responseSchema: z.record(z.string(), z.unknown()).optional()
      })
      .parse(request.body);
    return providerService.executeReadOnly({
      task: input.task,
      messages: input.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.name === undefined ? {} : { name: message.name }),
        ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId })
      })),
      cloudApproved: input.cloudApproved,
      liveConfirmed: input.liveConfirmed,
      ...(input.responseSchema === undefined ? {} : { responseSchema: input.responseSchema })
    });
  });
  app.post("/api/config/export", async () => providerService.exportConfiguration());
  app.post("/api/config/import-preview", async (request) =>
    providerService.importPreview(request.body)
  );
  app.post("/api/config/import", async (request) => {
    const input = z
      .object({ mode: z.enum(["merge", "replace"]), configuration: z.unknown() })
      .parse(request.body);
    const backupPath = join(
      dataDirectory,
      `configuration-backup-${new Date().toISOString().replaceAll(":", "-")}.json`
    );
    await writeFile(backupPath, JSON.stringify(providerService.exportConfiguration(), null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
    return {
      ...providerService.importConfiguration(input.configuration, input.mode),
      backupPath
    };
  });
  app.post("/api/ollama/detect", async () => providerService.detectOllama());
  app.post("/api/ollama/models/pull-plan", async (request) => {
    const input = z
      .object({ providerId: z.string().default("ollama"), model: z.string().min(1) })
      .parse(request.body);
    return providerService.planOllamaPull(input.providerId, input.model);
  });
  app.post("/api/ollama/models/pull", async (request) => {
    const input = z
      .object({
        providerId: z.string().default("ollama"),
        model: z.string().min(1),
        confirmed: z.literal(true)
      })
      .parse(request.body);
    const progress = [];
    for await (const event of providerService.pullOllama(
      input.providerId,
      input.model,
      input.confirmed
    )) {
      progress.push(event);
    }
    return { progress };
  });
  app.delete<{ Params: { model: string } }>("/api/ollama/models/:model", async (request) => {
    const input = z
      .object({ providerId: z.string().default("ollama"), confirmed: z.literal(true) })
      .parse(request.body);
    await providerService.removeOllama(
      input.providerId,
      decodeURIComponent(request.params.model),
      input.confirmed
    );
    return { removed: true };
  });

  app.get<{ Params: { id: string } }>(
    "/api/runs/:id/events",
    { websocket: true },
    (socket, request) => {
      const send = (): void => {
        try {
          socket.send(JSON.stringify(runService.get(request.params.id).events));
        } catch (error) {
          socket.send(JSON.stringify({ error: redactSecrets((error as Error).message) }));
        }
      };
      send();
      const timer = setInterval(send, 750);
      socket.on("close", () => clearInterval(timer));
    }
  );

  await app.listen({ host, port });
  const address = app.server.address();
  if (!address || typeof address === "string")
    throw new Error("Daemon did not open a TCP listener");
  return {
    app,
    token,
    url: `http://${host}:${address.port}`,
    async close() {
      await options.codexProvider?.dispose();
      await app.close();
      if (!options.database) database.close();
    }
  };
}

function createAiProvider(configuration: ProviderConfiguration, secrets: SecretStore): AiProvider {
  switch (configuration.type) {
    case "openai":
      return new OpenAiProvider(configuration.id, configuration.displayName, secrets);
    case "anthropic":
      return new AnthropicProvider(configuration.id, configuration.displayName, secrets);
    case "google":
      return new GoogleProvider(configuration.id, configuration.displayName, secrets);
    case "xai":
      return new XaiProvider(configuration.id, configuration.displayName, secrets);
    case "ollama":
      return new OllamaProvider(configuration.id, configuration.displayName, secrets);
    case "openai-compatible":
      return new OpenAiCompatibleProvider(configuration.id, configuration.displayName, secrets);
  }
}
