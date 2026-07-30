import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
  commandInvocation,
  resolveCommand,
  runCommandResolution,
  type CommandResolution
} from "@agent/shared";

export interface CodexAvailability {
  available: boolean;
  version: string | null;
  reason: string | null;
}

export interface AuthResult {
  authenticated: boolean;
  method: string | null;
  message: string;
}

export interface CodexThread {
  id: string;
}

export interface CreateThreadInput {
  cwd: string;
  model?: string;
}

export interface SendTurnInput {
  threadId: string;
  prompt: string;
  cwd: string;
  sandbox: "read-only" | "workspace-write";
  approvalPolicy: "on-request" | "never";
}

export type CodexEvent =
  | { type: "turn-started"; turnId: string }
  | { type: "message"; text: string; delta: boolean }
  | { type: "command"; id: string; command: string; status: string; exitCode?: number }
  | { type: "file-change"; id: string; changes: unknown }
  | { type: "approval"; id: string; method: string; params: unknown }
  | { type: "turn-completed"; turnId: string; status: string }
  | { type: "error"; message: string };

export interface CodexProvider {
  checkAvailability(): Promise<CodexAvailability>;
  authenticate(): Promise<AuthResult>;
  createThread(input: CreateThreadInput): Promise<CodexThread>;
  resumeThread(threadId: string): Promise<CodexThread>;
  sendTurn(input: SendTurnInput): AsyncIterable<CodexEvent>;
  cancelTurn(threadId: string, turnId: string): Promise<void>;
  dispose(): Promise<void>;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export class AppServerCodexProvider implements CodexProvider {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: RpcMessage) => void; reject: (error: Error) => void }
  >();
  private readonly events: RpcMessage[] = [];
  private readonly waiters: Array<(event: RpcMessage) => void> = [];
  private resolution: CommandResolution | null = null;

  constructor(
    private readonly executable = process.env.CODEX_EXECUTABLE ?? "codex",
    private readonly requestTimeoutMs = 30_000
  ) {}

  async checkAvailability(): Promise<CodexAvailability> {
    const resolution = await this.resolveExecutable();
    if (!resolution.resolvedPath || !resolution.invocationKind) {
      return { available: false, version: null, reason: "Codex CLI was not found" };
    }
    const result = await runCommandResolution(resolution, ["--version"], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 10_000
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    return {
      available: result.exitCode === 0 && !result.spawnError,
      version: result.exitCode === 0 ? output : null,
      reason:
        result.exitCode === 0
          ? null
          : (result.spawnError ?? `codex --version exited ${String(result.exitCode)}`)
    };
  }

  async authenticate(): Promise<AuthResult> {
    const resolution = await this.resolveExecutable();
    if (!resolution.resolvedPath || !resolution.invocationKind) {
      return { authenticated: false, method: null, message: "Codex CLI was not found" };
    }
    const result = await runCommandResolution(resolution, ["login", "status"], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 15_000
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    return {
      authenticated: result.exitCode === 0 && !result.spawnError,
      method: result.exitCode === 0 ? inferAuthMethod(output) : null,
      message: output || result.spawnError || `codex login status exited ${String(result.exitCode)}`
    };
  }

  async createThread(input: CreateThreadInput): Promise<CodexThread> {
    await this.start();
    const params: Record<string, unknown> = { cwd: input.cwd };
    if (input.model) params.model = input.model;
    const response = await this.request("thread/start", params);
    const thread = response.result?.thread as { id?: unknown } | undefined;
    if (!thread?.id) throw new Error("Codex app-server did not return a thread id");
    return { id: String(thread.id) };
  }

  async resumeThread(threadId: string): Promise<CodexThread> {
    await this.start();
    const response = await this.request("thread/resume", { threadId });
    const thread = response.result?.thread as { id?: unknown } | undefined;
    return { id: String(thread?.id ?? threadId) };
  }

  async *sendTurn(input: SendTurnInput): AsyncIterable<CodexEvent> {
    await this.start();
    const response = await this.request("turn/start", {
      threadId: input.threadId,
      cwd: input.cwd,
      input: [{ type: "text", text: input.prompt }],
      sandboxPolicy: { type: input.sandbox },
      approvalPolicy: input.approvalPolicy
    });
    const turn = response.result?.turn as { id?: unknown } | undefined;
    const turnId = String(turn?.id ?? "");
    if (!turnId) throw new Error("Codex app-server did not return a turn id");
    yield { type: "turn-started", turnId };

    for (;;) {
      const message = await this.nextEvent();
      const event = normalizeEvent(message, turnId);
      if (event) yield event;
      if (event?.type === "turn-completed" && event.turnId === turnId) return;
    }
  }

  async cancelTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async dispose(): Promise<void> {
    this.process?.kill();
    this.process = null;
    for (const waiter of this.pending.values()) waiter.reject(new Error("Provider disposed"));
    this.pending.clear();
  }

  private async start(): Promise<void> {
    if (this.process) return;
    const resolution = await this.resolveExecutable();
    if (!resolution.resolvedPath || !resolution.invocationKind) {
      throw new Error("Codex CLI was not found");
    }
    const invocation = commandInvocation(resolution, ["app-server", "--listen", "stdio://"]);
    const child = spawn(invocation.executable, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false
    });
    this.process = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        return;
      }
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message);
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.events.push(message);
    });
    child.once("exit", (code) => {
      this.process = null;
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`Codex app-server exited with code ${code}`));
      }
      this.pending.clear();
    });
    await this.request("initialize", {
      clientInfo: {
        name: "personal_codex_agent",
        title: "Personal Codex Agent",
        version: "0.2.0"
      }
    });
    this.notify("initialized", {});
  }

  private async resolveExecutable(): Promise<CommandResolution> {
    this.resolution ??= await resolveCommand(this.executable, {
      configurationPath: this.executable,
      versionArgs: null
    });
    return this.resolution;
  }

  private request(method: string, params: Record<string, unknown>): Promise<RpcMessage> {
    if (!this.process) throw new Error("Codex app-server is not running");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.process!.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.process?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private nextEvent(): Promise<RpcMessage> {
    const event = this.events.shift();
    if (event) return Promise.resolve(event);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export class FakeCodexProvider implements CodexProvider {
  readonly turns: SendTurnInput[] = [];
  private cancelled = new Set<string>();

  constructor(
    private readonly scriptedEvents: CodexEvent[] = [
      {
        type: "message",
        text: "Inspected repository and implemented the approved change.",
        delta: false
      },
      { type: "file-change", id: "change-1", changes: [{ path: "src/example.ts" }] },
      { type: "command", id: "cmd-1", command: "npm test", status: "completed", exitCode: 0 }
    ]
  ) {}

  async checkAvailability(): Promise<CodexAvailability> {
    return { available: true, version: "fake-1.0.0", reason: null };
  }

  async authenticate(): Promise<AuthResult> {
    return { authenticated: true, method: "fake", message: "Deterministic fake provider" };
  }

  async createThread(_input: CreateThreadInput): Promise<CodexThread> {
    return { id: `fake-thread-${randomUUID()}` };
  }

  async resumeThread(threadId: string): Promise<CodexThread> {
    return { id: threadId };
  }

  async *sendTurn(input: SendTurnInput): AsyncIterable<CodexEvent> {
    this.turns.push(input);
    const turnId = `fake-turn-${randomUUID()}`;
    yield { type: "turn-started", turnId };
    for (const event of this.scriptedEvents) {
      if (this.cancelled.has(turnId)) {
        yield { type: "turn-completed", turnId, status: "interrupted" };
        return;
      }
      yield event;
    }
    yield { type: "turn-completed", turnId, status: "completed" };
  }

  async cancelTurn(_threadId: string, turnId: string): Promise<void> {
    this.cancelled.add(turnId);
  }

  async dispose(): Promise<void> {}
}

function inferAuthMethod(output: string): string {
  const lower = output.toLowerCase();
  if (lower.includes("api key")) return "api-key";
  if (lower.includes("chatgpt")) return "chatgpt";
  if (lower.includes("access token")) return "access-token";
  return "authenticated";
}

function normalizeEvent(message: RpcMessage, activeTurnId: string): CodexEvent | null {
  const method = message.method ?? "";
  const params = message.params ?? {};
  if (method === "turn/completed") {
    const turn = params.turn as { id?: unknown; status?: unknown } | undefined;
    return {
      type: "turn-completed",
      turnId: String(turn?.id ?? activeTurnId),
      status: String(turn?.status ?? "completed")
    };
  }
  if (method === "item/agentMessage/delta") {
    return { type: "message", text: String(params.delta ?? ""), delta: true };
  }
  if (method === "item/completed" || method === "item/started") {
    const item = params.item as Record<string, unknown> | undefined;
    const itemType = String(item?.type ?? "");
    if (itemType === "agentMessage") {
      return { type: "message", text: String(item?.text ?? ""), delta: false };
    }
    if (itemType === "commandExecution") {
      return {
        type: "command",
        id: String(item?.id ?? ""),
        command: String(item?.command ?? ""),
        status: String(item?.status ?? ""),
        ...(typeof item?.exitCode === "number" ? { exitCode: item.exitCode } : {})
      };
    }
    if (itemType === "fileChange") {
      return { type: "file-change", id: String(item?.id ?? ""), changes: item?.changes };
    }
  }
  if (method.endsWith("Approval")) {
    return { type: "approval", id: String(message.id ?? ""), method, params };
  }
  if (message.error) return { type: "error", message: message.error.message };
  return null;
}
