import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { commandInvocation, resolveCommand } from "@agent/shared";
import type {
  AuthResult,
  CodexAvailability,
  CodexEvent,
  CodexProvider,
  CodexThread,
  CreateThreadInput,
  SendTurnInput
} from "./index.js";

type PuterRole = "system" | "user" | "assistant" | "tool";

interface PuterFunctionCall {
  name: string;
  arguments: string;
}

interface PuterToolCall {
  id: string;
  type?: "function";
  function: PuterFunctionCall;
}

interface PuterMessage {
  role: PuterRole;
  content: string;
  tool_calls?: PuterToolCall[];
  tool_call_id?: string;
}

interface PuterChatResponse {
  message?: {
    role?: string;
    content?: unknown;
    tool_calls?: unknown;
  };
}

interface PuterClient {
  ai: {
    chat(messages: PuterMessage[], options: Record<string, unknown>): Promise<PuterChatResponse>;
  };
  auth?: {
    getUser(): Promise<unknown>;
  };
}

export interface PuterSdk {
  init(token: string): PuterClient;
  getAuthToken?: () => Promise<string>;
}

export interface PuterTokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
}

export interface PuterCodexProviderOptions {
  model?: string;
  authToken?: string;
  maxAgentSteps?: number;
  maxFileBytes?: number;
  maxToolOutputBytes?: number;
  commandTimeoutMs?: number;
  allowedCommands?: string[];
  sdkLoader?: () => Promise<PuterSdk>;
  tokenStore?: PuterTokenStore;
}

interface ThreadState {
  cwd: string;
  model: string;
  messages: PuterMessage[];
}

interface ActiveTurn {
  threadId: string;
  controller: AbortController;
  children: Set<ChildProcessWithoutNullStreams>;
}

interface ToolExecution {
  content: string;
  events: CodexEvent[];
  completed: boolean;
  summary?: string;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".agent-runs",
  "node_modules",
  "dist",
  "artifacts",
  "coverage"
]);

const SENSITIVE_FILE_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials.json",
  "id_rsa",
  "id_ed25519"
]);

const SYSTEM_PROMPT = `You are the repository-writing implementation agent inside Personal Codex Agent.

Work only inside the provided isolated workspace. Inspect the repository before editing. Use the supplied tools for every filesystem read, search, write, deletion, and command. Never claim a change or test result unless the corresponding tool succeeded. Keep changes narrowly scoped to the approved request, preserve existing style, and run the most relevant available tests or checks before finishing.

Do not read or expose secrets, credentials, .env files, key stores, or files outside the workspace. Do not use network commands, package installation, Git history rewriting, Git cleanup, commits, pushes, or deployment commands. Tool failures are recoverable: inspect the error and choose a safer alternative. Call complete_task only after the implementation and verification work is finished.`;

export class PuterCodexProvider implements CodexProvider {
  private readonly model: string;
  private readonly configuredToken: string | undefined;
  private readonly maxAgentSteps: number;
  private readonly maxFileBytes: number;
  private readonly maxToolOutputBytes: number;
  private readonly commandTimeoutMs: number;
  private readonly allowedCommands: Set<string>;
  private readonly sdkLoader: () => Promise<PuterSdk>;
  private readonly tokenStore: PuterTokenStore;
  private sdk: PuterSdk | null = null;
  private client: PuterClient | null = null;
  private authenticatedMethod: string | null = null;
  private readonly threads = new Map<string, ThreadState>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly activeThreads = new Set<string>();

  constructor(options: PuterCodexProviderOptions = {}) {
    this.model = options.model ?? process.env.PUTER_MODEL ?? "openai/gpt-5.3-codex";
    this.configuredToken = options.authToken ?? process.env.PUTER_AUTH_TOKEN;
    this.maxAgentSteps = positiveInteger(
      options.maxAgentSteps ?? numberFromEnvironment("PUTER_MAX_AGENT_STEPS"),
      40
    );
    this.maxFileBytes = positiveInteger(options.maxFileBytes, 1_000_000);
    this.maxToolOutputBytes = positiveInteger(options.maxToolOutputBytes, 100_000);
    this.commandTimeoutMs = positiveInteger(
      options.commandTimeoutMs ?? numberFromEnvironment("PUTER_COMMAND_TIMEOUT_MS"),
      120_000
    );
    this.allowedCommands = new Set(
      (options.allowedCommands ?? commandsFromEnvironment()).map(normalizeCommandName)
    );
    this.sdkLoader = options.sdkLoader ?? loadPuterSdk;
    this.tokenStore = options.tokenStore ?? new KeyringPuterTokenStore();
  }

  async checkAvailability(): Promise<CodexAvailability> {
    try {
      await this.loadSdk();
      return {
        available: true,
        version: `Puter.js (${this.model})`,
        reason: null
      };
    } catch (error) {
      return {
        available: false,
        version: null,
        reason: errorMessage(error)
      };
    }
  }

  async authenticate(): Promise<AuthResult> {
    if (this.client) {
      return {
        authenticated: true,
        method: this.authenticatedMethod ?? "puter",
        message: `Authenticated with Puter for model ${this.model}`
      };
    }

    try {
      const sdk = await this.loadSdk();
      let token = this.configuredToken;
      let method = "environment-token";

      if (!token) {
        token = (await this.tokenStore.get()) ?? undefined;
        method = "credential-store";
      }

      if (!token) {
        if (!sdk.getAuthToken) {
          return {
            authenticated: false,
            method: null,
            message:
              "No Puter token is configured and this Puter.js build does not expose browser authentication"
          };
        }
        token = await sdk.getAuthToken();
        method = "browser-login";
        await this.tokenStore.set(token).catch(() => undefined);
      }

      const client = sdk.init(token);
      if (client.auth?.getUser) await client.auth.getUser();
      this.client = client;
      this.authenticatedMethod = method;
      return {
        authenticated: true,
        method,
        message: `Authenticated with Puter for model ${this.model}`
      };
    } catch (error) {
      return {
        authenticated: false,
        method: null,
        message: errorMessage(error)
      };
    }
  }

  async createThread(input: CreateThreadInput): Promise<CodexThread> {
    const cwd = await canonicalWorkspace(input.cwd);
    const id = `puter-thread-${randomUUID()}`;
    this.threads.set(id, {
      cwd,
      model: input.model ?? this.model,
      messages: [{ role: "system", content: SYSTEM_PROMPT }]
    });
    return { id };
  }

  async resumeThread(threadId: string): Promise<CodexThread> {
    if (!this.threads.has(threadId)) {
      throw new Error(
        "Puter thread state is kept in memory and cannot be resumed after the daemon restarts"
      );
    }
    return { id: threadId };
  }

  async *sendTurn(input: SendTurnInput): AsyncIterable<CodexEvent> {
    const thread = this.threads.get(input.threadId);
    if (!thread) throw new Error(`Unknown Puter thread: ${input.threadId}`);
    const cwd = await canonicalWorkspace(input.cwd);
    if (cwd !== thread.cwd) throw new Error("The turn workspace does not match its Puter thread");
    if (this.activeThreads.has(input.threadId)) {
      throw new Error("A Puter turn is already active for this thread");
    }

    const turnId = `puter-turn-${randomUUID()}`;
    const active: ActiveTurn = {
      threadId: input.threadId,
      controller: new AbortController(),
      children: new Set()
    };
    this.activeTurns.set(turnId, active);
    this.activeThreads.add(input.threadId);
    yield { type: "turn-started", turnId };

    try {
      const auth = await this.authenticate();
      if (!auth.authenticated || !this.client) throw new Error(auth.message);
      thread.messages.push({ role: "user", content: input.prompt });
      const tools = buildTools(input.sandbox);

      for (let step = 0; step < this.maxAgentSteps; step += 1) {
        throwIfAborted(active.controller.signal);
        const response = await this.client.ai.chat(thread.messages, {
          model: thread.model,
          stream: false,
          tools,
          reasoning_effort: "high",
          verbosity: "medium"
        });
        const assistant = normalizeAssistantMessage(response);
        thread.messages.push(assistant);

        if (assistant.content.trim()) {
          yield { type: "message", text: assistant.content, delta: false };
        }

        const calls = assistant.tool_calls ?? [];
        if (calls.length === 0) {
          yield { type: "turn-completed", turnId, status: "completed" };
          return;
        }

        for (const call of calls) {
          throwIfAborted(active.controller.signal);
          const execution = await this.executeTool(call, thread.cwd, input.sandbox, turnId, active);
          for (const event of execution.events) yield event;
          thread.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: execution.content
          });
          if (execution.completed) {
            if (execution.summary?.trim()) {
              yield { type: "message", text: execution.summary, delta: false };
            }
            yield { type: "turn-completed", turnId, status: "completed" };
            return;
          }
        }
      }

      yield {
        type: "error",
        message: `Puter agent exceeded the ${String(this.maxAgentSteps)}-step safety limit`
      };
      yield { type: "turn-completed", turnId, status: "failed" };
    } catch (error) {
      if (active.controller.signal.aborted) {
        yield { type: "turn-completed", turnId, status: "interrupted" };
      } else {
        yield { type: "error", message: errorMessage(error) };
        yield { type: "turn-completed", turnId, status: "failed" };
      }
    } finally {
      for (const child of active.children) child.kill();
      this.activeTurns.delete(turnId);
      this.activeThreads.delete(input.threadId);
    }
  }

  async cancelTurn(threadId: string, turnId: string): Promise<void> {
    const active = this.activeTurns.get(turnId);
    if (!active || active.threadId !== threadId) return;
    active.controller.abort();
    for (const child of active.children) child.kill();
  }

  async dispose(): Promise<void> {
    for (const active of this.activeTurns.values()) {
      active.controller.abort();
      for (const child of active.children) child.kill();
    }
    this.activeTurns.clear();
    this.activeThreads.clear();
    this.threads.clear();
    this.client = null;
  }

  private async loadSdk(): Promise<PuterSdk> {
    this.sdk ??= await this.sdkLoader();
    return this.sdk;
  }

  private async executeTool(
    call: PuterToolCall,
    workspace: string,
    sandbox: SendTurnInput["sandbox"],
    turnId: string,
    active: ActiveTurn
  ): Promise<ToolExecution> {
    let args: Record<string, unknown>;
    try {
      args = parseArguments(call.function.arguments);
    } catch (error) {
      return toolFailure(errorMessage(error));
    }

    try {
      switch (call.function.name) {
        case "list_files":
          return toolSuccess(
            await listWorkspaceFiles(
              workspace,
              optionalString(args, "path") ?? ".",
              boundedInteger(args.maxDepth, 1, 8, 4)
            )
          );
        case "read_file":
          return toolSuccess(
            await readWorkspaceFile(
              workspace,
              requiredString(args, "path"),
              optionalInteger(args, "startLine"),
              optionalInteger(args, "endLine"),
              this.maxFileBytes
            )
          );
        case "search_files":
          return toolSuccess(
            await searchWorkspaceFiles(
              workspace,
              requiredString(args, "query"),
              optionalString(args, "path") ?? ".",
              boundedInteger(args.maxResults, 1, 200, 50),
              this.maxFileBytes
            )
          );
        case "write_file": {
          requireWorkspaceWrite(sandbox);
          const path = requiredString(args, "path");
          const bytes = await writeWorkspaceFile(
            workspace,
            path,
            requiredString(args, "content"),
            this.maxFileBytes
          );
          return toolSuccess({ path, bytes, operation: "write" }, [
            { type: "file-change", id: call.id, changes: [{ path, operation: "write" }] }
          ]);
        }
        case "replace_text": {
          requireWorkspaceWrite(sandbox);
          const path = requiredString(args, "path");
          const replacements = await replaceWorkspaceText(
            workspace,
            path,
            requiredString(args, "oldText"),
            requiredString(args, "newText"),
            optionalBoolean(args, "replaceAll") ?? false,
            this.maxFileBytes
          );
          return toolSuccess({ path, replacements, operation: "replace" }, [
            { type: "file-change", id: call.id, changes: [{ path, operation: "replace" }] }
          ]);
        }
        case "delete_file": {
          requireWorkspaceWrite(sandbox);
          const path = requiredString(args, "path");
          await deleteWorkspaceFile(workspace, path);
          return toolSuccess({ path, operation: "delete" }, [
            { type: "file-change", id: call.id, changes: [{ path, operation: "delete" }] }
          ]);
        }
        case "run_command": {
          requireWorkspaceWrite(sandbox);
          const command = requiredString(args, "command");
          const commandArgs = stringArray(args.args, "args");
          const timeoutMs = boundedInteger(
            args.timeoutMs,
            1_000,
            this.commandTimeoutMs,
            this.commandTimeoutMs
          );
          validateCommand(command, commandArgs, this.allowedCommands);
          const display = [command, ...commandArgs].join(" ");
          const result = await this.runCommand(
            workspace,
            command,
            commandArgs,
            timeoutMs,
            turnId,
            active
          );
          const status = result.exitCode === 0 && !result.timedOut ? "completed" : "failed";
          return toolSuccess(result, [
            { type: "command", id: call.id, command: display, status: "started" },
            {
              type: "command",
              id: call.id,
              command: display,
              status,
              ...(typeof result.exitCode === "number" ? { exitCode: result.exitCode } : {})
            }
          ]);
        }
        case "complete_task": {
          const summary = requiredString(args, "summary");
          return {
            content: JSON.stringify({ ok: true, summary }),
            events: [],
            completed: true,
            summary
          };
        }
        default:
          return toolFailure(`Unknown tool: ${call.function.name}`);
      }
    } catch (error) {
      return toolFailure(errorMessage(error));
    }
  }

  private async runCommand(
    workspace: string,
    command: string,
    args: string[],
    timeoutMs: number,
    _turnId: string,
    active: ActiveTurn
  ): Promise<CommandResult> {
    const resolution = await resolveCommand(command, {
      configurationPath: command,
      versionArgs: null
    });
    if (!resolution.resolvedPath || !resolution.invocationKind) {
      throw new Error(`Allowed command was not found: ${command}`);
    }
    const invocation = commandInvocation(resolution, args);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: workspace,
      env: sanitizedCommandEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.end();
    active.children.add(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk.toString("utf8"), this.maxToolOutputBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"), this.maxToolOutputBytes);
    });

    const abort = (): void => {
      child.kill();
    };
    active.controller.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    try {
      const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", resolveExit);
      });
      throwIfAborted(active.controller.signal);
      return { exitCode, stdout, stderr, timedOut };
    } finally {
      clearTimeout(timer);
      active.controller.signal.removeEventListener("abort", abort);
      active.children.delete(child);
    }
  }
}

class KeyringPuterTokenStore implements PuterTokenStore {
  async get(): Promise<string | null> {
    if (process.platform !== "win32") return null;
    try {
      const { Entry } = await import("@napi-rs/keyring");
      return new Entry("PersonalCodexAgent:Puter", "puter-auth-token").getPassword() ?? null;
    } catch {
      return null;
    }
  }

  async set(token: string): Promise<void> {
    if (process.platform !== "win32") return;
    const { Entry } = await import("@napi-rs/keyring");
    new Entry("PersonalCodexAgent:Puter", "puter-auth-token").setPassword(token);
  }
}

async function loadPuterSdk(): Promise<PuterSdk> {
  try {
    return (await import("@heyputer/puter.js/src/init.cjs")) as PuterSdk;
  } catch (error) {
    throw new Error(
      `Puter.js is not installed. Run npm install before using AGENT_CODEX_PROVIDER=puter. ${errorMessage(error)}`,
      { cause: error }
    );
  }
}

function buildTools(sandbox: SendTurnInput["sandbox"]): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [
    functionTool(
      "list_files",
      "List files below a workspace-relative directory. Generated and dependency directories are skipped.",
      {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative directory; defaults to ." },
          maxDepth: { type: "integer", minimum: 1, maximum: 8 }
        },
        additionalProperties: false
      }
    ),
    functionTool("read_file", "Read a UTF-8 text file with optional inclusive line bounds.", {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 }
      },
      required: ["path"],
      additionalProperties: false
    }),
    functionTool("search_files", "Search text files for a literal case-insensitive string.", {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        path: { type: "string", description: "Workspace-relative directory; defaults to ." },
        maxResults: { type: "integer", minimum: 1, maximum: 200 }
      },
      required: ["query"],
      additionalProperties: false
    })
  ];

  if (sandbox === "workspace-write") {
    tools.push(
      functionTool("write_file", "Create or atomically replace one UTF-8 workspace file.", {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false
      }),
      functionTool(
        "replace_text",
        "Replace exact text in one workspace file. Fails if the old text is absent or ambiguous unless replaceAll is true.",
        {
          type: "object",
          properties: {
            path: { type: "string" },
            oldText: { type: "string", minLength: 1 },
            newText: { type: "string" },
            replaceAll: { type: "boolean" }
          },
          required: ["path", "oldText", "newText"],
          additionalProperties: false
        }
      ),
      functionTool(
        "delete_file",
        "Delete one regular workspace file. Directories cannot be deleted.",
        {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false
        }
      ),
      functionTool(
        "run_command",
        "Run an allowlisted, non-shell verification command in the workspace. Package installation, network, deployment, and destructive Git operations are blocked.",
        {
          type: "object",
          properties: {
            command: { type: "string" },
            args: { type: "array", items: { type: "string" }, maxItems: 64 },
            timeoutMs: { type: "integer", minimum: 1000 }
          },
          required: ["command", "args"],
          additionalProperties: false
        }
      )
    );
  }

  tools.push(
    functionTool(
      "complete_task",
      "Finish the turn after implementation and verification. Summarize concrete changes and checks run.",
      {
        type: "object",
        properties: { summary: { type: "string", minLength: 1 } },
        required: ["summary"],
        additionalProperties: false
      }
    )
  );
  return tools;
}

function functionTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>
): Record<string, unknown> {
  return {
    type: "function",
    function: { name, description, parameters }
  };
}

function normalizeAssistantMessage(response: PuterChatResponse): PuterMessage {
  if (!response.message) throw new Error("Puter returned no assistant message");
  const content = normalizeContent(response.message.content);
  const toolCalls = normalizeToolCalls(response.message.tool_calls);
  return {
    role: "assistant",
    content,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
  };
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part) && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeToolCalls(value: unknown): PuterToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: PuterToolCall[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isRecord(item.function)) continue;
    if (typeof item.id !== "string" || typeof item.function.name !== "string") continue;
    const rawArguments = item.function.arguments;
    calls.push({
      id: item.id,
      type: "function",
      function: {
        name: item.function.name,
        arguments:
          typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments ?? {})
      }
    });
  }
  return calls;
}

async function canonicalWorkspace(path: string): Promise<string> {
  const resolved = await realpath(resolve(path));
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) throw new Error(`Workspace is not a directory: ${path}`);
  return resolved;
}

async function resolveWorkspacePath(
  workspace: string,
  requestedPath: string,
  mode: "read" | "write"
): Promise<string> {
  if (!requestedPath || requestedPath.includes("\0") || isAbsolute(requestedPath)) {
    throw new Error("Tool paths must be non-empty workspace-relative paths");
  }
  const candidate = resolve(workspace, requestedPath);
  assertContained(workspace, candidate);
  rejectProtectedPath(workspace, candidate);
  rejectSensitivePath(workspace, candidate);

  const existingAncestor = await nearestExistingAncestor(candidate);
  const ancestorRealPath = await realpath(existingAncestor);
  assertContained(workspace, ancestorRealPath);

  try {
    const metadata = await lstat(candidate);
    if (mode === "write" && metadata.isSymbolicLink()) {
      throw new Error("Writing through symbolic links is not allowed");
    }
    const targetRealPath = await realpath(candidate);
    assertContained(workspace, targetRealPath);
    return mode === "read" ? targetRealPath : candidate;
  } catch (error) {
    if (isMissing(error)) return candidate;
    throw error;
  }
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error(`No existing ancestor for ${path}`, {
        cause: error
      });
      current = parent;
    }
  }
}

function assertContained(workspace: string, candidate: string): void {
  const rel = relative(workspace, candidate);
  if (rel === "") return;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Path escapes the isolated workspace");
  }
}

function rejectProtectedPath(workspace: string, candidate: string): void {
  const parts = relative(workspace, candidate).split(/[\\/]+/u);
  if (parts.some((part) => part === ".git" || part === ".agent-runs")) {
    throw new Error("Agent metadata and Git internals are protected");
  }
}

function rejectSensitivePath(workspace: string, candidate: string): void {
  const name = basename(relative(workspace, candidate)).toLocaleLowerCase();
  const isEnvironmentFile =
    (name === ".env" || name.startsWith(".env.")) && name !== ".env.example";
  const isPrivateKey = name.endsWith(".pem") || name.endsWith(".key");
  if (isEnvironmentFile || isPrivateKey || SENSITIVE_FILE_NAMES.has(name)) {
    throw new Error("Secret-bearing files are not available to the Puter agent");
  }
}

function isSensitiveWorkspaceEntry(name: string): boolean {
  const normalized = name.toLocaleLowerCase();
  return (
    ((normalized === ".env" || normalized.startsWith(".env.")) && normalized !== ".env.example") ||
    normalized.endsWith(".pem") ||
    normalized.endsWith(".key") ||
    SENSITIVE_FILE_NAMES.has(normalized)
  );
}

async function listWorkspaceFiles(
  workspace: string,
  requestedPath: string,
  maxDepth: number
): Promise<{ path: string; entries: string[]; truncated: boolean }> {
  const root = await resolveWorkspacePath(workspace, requestedPath, "read");
  if (!(await stat(root)).isDirectory()) throw new Error("list_files path must be a directory");
  const entries: string[] = [];
  let truncated = false;

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (entries.length >= 500) {
      truncated = true;
      return;
    }
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (entries.length >= 500) {
        truncated = true;
        return;
      }
      if (
        SKIPPED_DIRECTORIES.has(child.name) ||
        isSensitiveWorkspaceEntry(child.name) ||
        child.isSymbolicLink()
      ) {
        continue;
      }
      const absolute = join(directory, child.name);
      const display = toWorkspacePath(workspace, absolute) + (child.isDirectory() ? "/" : "");
      entries.push(display);
      if (child.isDirectory() && depth < maxDepth) await visit(absolute, depth + 1);
    }
  };

  await visit(root, 1);
  return { path: toWorkspacePath(workspace, root) || ".", entries, truncated };
}

async function readWorkspaceFile(
  workspace: string,
  requestedPath: string,
  startLine: number | undefined,
  endLine: number | undefined,
  maxFileBytes: number
): Promise<{
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
}> {
  const path = await resolveWorkspacePath(workspace, requestedPath, "read");
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("read_file path must be a regular file");
  if (metadata.size > maxFileBytes) {
    throw new Error(`File exceeds the ${String(maxFileBytes)} byte read limit`);
  }
  const buffer = await readFile(path);
  if (buffer.includes(0)) throw new Error("Binary files cannot be read with read_file");
  const lines = buffer.toString("utf8").split(/\r?\n/u);
  const first = Math.max(1, startLine ?? 1);
  const last = Math.min(lines.length, endLine ?? lines.length);
  if (last < first) throw new Error("endLine must be greater than or equal to startLine");
  return {
    path: toWorkspacePath(workspace, path),
    content: lines.slice(first - 1, last).join("\n"),
    startLine: first,
    endLine: last,
    totalLines: lines.length
  };
}

async function searchWorkspaceFiles(
  workspace: string,
  query: string,
  requestedPath: string,
  maxResults: number,
  maxFileBytes: number
): Promise<{
  query: string;
  matches: Array<{ path: string; line: number; text: string }>;
  truncated: boolean;
}> {
  if (!query) throw new Error("search_files query cannot be empty");
  const root = await resolveWorkspacePath(workspace, requestedPath, "read");
  if (!(await stat(root)).isDirectory()) throw new Error("search_files path must be a directory");
  const needle = query.toLocaleLowerCase();
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let truncated = false;

  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      if (matches.length >= maxResults) {
        truncated = true;
        return;
      }
      if (
        SKIPPED_DIRECTORIES.has(child.name) ||
        isSensitiveWorkspaceEntry(child.name) ||
        child.isSymbolicLink()
      ) {
        continue;
      }
      const absolute = join(directory, child.name);
      if (child.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!child.isFile()) continue;
      const metadata = await stat(absolute);
      if (metadata.size > maxFileBytes) continue;
      const buffer = await readFile(absolute);
      if (buffer.includes(0)) continue;
      const lines = buffer.toString("utf8").split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (!line.toLocaleLowerCase().includes(needle)) continue;
        matches.push({
          path: toWorkspacePath(workspace, absolute),
          line: index + 1,
          text: line.slice(0, 500)
        });
        if (matches.length >= maxResults) {
          truncated = true;
          return;
        }
      }
    }
  };

  await visit(root);
  return { query, matches, truncated };
}

async function writeWorkspaceFile(
  workspace: string,
  requestedPath: string,
  content: string,
  maxFileBytes: number
): Promise<number> {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxFileBytes) {
    throw new Error(`Write exceeds the ${String(maxFileBytes)} byte file limit`);
  }
  const path = await resolveWorkspacePath(workspace, requestedPath, "write");
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const parentRealPath = await realpath(parent);
  assertContained(workspace, parentRealPath);
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return bytes;
}

async function replaceWorkspaceText(
  workspace: string,
  requestedPath: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
  maxFileBytes: number
): Promise<number> {
  if (!oldText) throw new Error("oldText cannot be empty");
  const path = await resolveWorkspacePath(workspace, requestedPath, "write");
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maxFileBytes) {
    throw new Error("replace_text requires a regular text file within the file-size limit");
  }
  const buffer = await readFile(path);
  if (buffer.includes(0)) throw new Error("Binary files cannot be changed with replace_text");
  const current = buffer.toString("utf8");
  const occurrences = current.split(oldText).length - 1;
  if (occurrences === 0) throw new Error("oldText was not found");
  if (!replaceAll && occurrences !== 1) {
    throw new Error(
      `oldText matched ${String(occurrences)} times; use replaceAll or a larger exact block`
    );
  }
  const next = replaceAll
    ? current.split(oldText).join(newText)
    : current.replace(oldText, newText);
  await writeWorkspaceFile(workspace, requestedPath, next, maxFileBytes);
  return replaceAll ? occurrences : 1;
}

async function deleteWorkspaceFile(workspace: string, requestedPath: string): Promise<void> {
  const path = await resolveWorkspacePath(workspace, requestedPath, "write");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("delete_file can delete regular files only");
  }
  await rm(path);
}

function validateCommand(command: string, args: string[], allowedCommands: Set<string>): void {
  const name = normalizeCommandName(command);
  if (!allowedCommands.has(name)) throw new Error(`Command is not allowlisted: ${command}`);
  if (command.includes("/") || command.includes("\\")) {
    throw new Error("Commands must be invoked by allowlisted name, not by path");
  }
  const forbiddenFlags = ["--prefix", "--cwd", "--global", "--location=global", "-g", "-C"];
  if (
    args.some((arg) => forbiddenFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))
  ) {
    throw new Error("Command arguments may not change workspace or global installation state");
  }

  const first = args[0] ?? "";
  switch (name) {
    case "git":
      if (!new Set(["status", "diff", "grep", "ls-files", "show", "rev-parse", "log"]).has(first)) {
        throw new Error(`Git subcommand is read-only allowlist only: ${first || "<missing>"}`);
      }
      break;
    case "npm":
      if (!new Set(["test", "run", "run-script", "--version", "-v"]).has(first)) {
        throw new Error(`npm subcommand is not allowed: ${first || "<missing>"}`);
      }
      break;
    case "pnpm":
    case "yarn":
      if (!new Set(["test", "run", "build", "lint", "typecheck", "--version", "-v"]).has(first)) {
        throw new Error(`${name} subcommand is not allowed: ${first || "<missing>"}`);
      }
      break;
    case "bun":
      if (!new Set(["test", "run", "--version", "-v"]).has(first)) {
        throw new Error(`bun subcommand is not allowed: ${first || "<missing>"}`);
      }
      break;
    case "node":
      if (!new Set(["--test", "--check", "--version", "-v"]).has(first)) {
        throw new Error("node is limited to --test, --check, and version checks");
      }
      break;
    default:
      throw new Error(`No safety policy is defined for command: ${name}`);
  }
}

function sanitizedCommandEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "PROGRAMDATA",
    "COMSPEC",
    "TERM",
    "CI"
  ];
  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    NO_COLOR: "1",
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false"
  };
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function commandsFromEnvironment(): string[] {
  return (process.env.PUTER_ALLOWED_COMMANDS ?? "npm,pnpm,yarn,bun,node,git")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeCommandName(command: string): string {
  return basename(command)
    .toLocaleLowerCase()
    .replace(/\.(?:cmd|exe)$/u, "");
}

function numberFromEnvironment(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function parseArguments(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw new Error("Tool arguments must be a JSON object");
  return parsed;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function optionalInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function stringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  if (value.length > 64) throw new Error(`${key} contains too many values`);
  return value as string[];
}

function requireWorkspaceWrite(sandbox: SendTurnInput["sandbox"]): void {
  if (sandbox !== "workspace-write") throw new Error("This tool requires workspace-write sandbox");
}

function toolSuccess(value: unknown, events: CodexEvent[] = []): ToolExecution {
  return {
    content: JSON.stringify({ ok: true, result: value }),
    events,
    completed: false
  };
}

function toolFailure(message: string): ToolExecution {
  return {
    content: JSON.stringify({ ok: false, error: message }),
    events: [],
    completed: false
  };
}

function toWorkspacePath(workspace: string, path: string): string {
  return relative(workspace, path).split(sep).join("/");
}

function appendLimited(current: string, next: string, maximumBytes: number): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= maximumBytes) return combined;
  const buffer = Buffer.from(combined, "utf8");
  return `${buffer.subarray(0, maximumBytes).toString("utf8")}\n[output truncated]`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error("Turn interrupted");
    error.name = "AbortError";
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
