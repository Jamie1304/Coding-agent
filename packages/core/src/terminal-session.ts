import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { commandInvocation, resolveCommand } from "@agent/shared";
import type { StepRuntimeError, StepRuntimeWarning, StepTerminalOperation } from "@agent/shared";
import type { CommandRequest } from "./process-runner.js";
import { validateCommandRequest } from "./process-runner.js";
import {
  redactArguments,
  redactSecrets,
  validatePathWithinWorkspace,
  validateWorkspacePath
} from "./security.js";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const MAX_UNTERMINATED_LINE_BYTES = 16_000;

export interface TerminalOperationStore {
  saveStepTerminalOperation(operation: StepTerminalOperation): void;
}

export interface TerminalOutputEvent {
  stream: "stdout" | "stderr";
  text: string;
  at: string;
}

export interface TerminalReadiness {
  logPattern?: string | RegExp;
  httpUrl?: string;
  expectedStatus?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface TerminalSessionRequest extends CommandRequest {
  runId: string;
  stepId: string;
  workspacePath: string;
  operationId?: string;
  onOutput?: (event: TerminalOutputEvent) => void;
}

export interface TerminalSessionOptions {
  store?: TerminalOperationStore;
  errorRecorder?: RuntimeErrorRecorder;
  killGraceMs?: number;
  now?: () => Date;
}

export interface RuntimeErrorRecorder {
  recordTerminalOperation(operation: StepTerminalOperation): StepRuntimeError[];
}

export class TerminalSession {
  private readonly startedAt: Date;
  private readonly stdout = new LineRedactor();
  private readonly stderr = new LineRedactor();
  private readonly errors = new Map<string, StepRuntimeError>();
  private readonly warnings = new Map<string, StepRuntimeWarning>();
  private completionResolver!: (operation: StepTerminalOperation) => void;
  private readonly process: ChildProcessWithoutNullStreams;
  private operation: StepTerminalOperation;
  private stdoutText = "";
  private stderrText = "";
  private combinedText = "";
  private truncated = false;
  private timedOut = false;
  private stopRequested = false;
  private finalized = false;
  private timeout: NodeJS.Timeout | null = null;
  private stopPromise: Promise<StepTerminalOperation> | null = null;
  readonly completion: Promise<StepTerminalOperation>;

  private constructor(
    readonly request: TerminalSessionRequest,
    process: ChildProcessWithoutNullStreams,
    private readonly options: {
      store: TerminalOperationStore | undefined;
      errorRecorder: RuntimeErrorRecorder | undefined;
      killGraceMs: number;
      now: () => Date;
    }
  ) {
    this.process = process;
    this.startedAt = options.now();
    this.completion = new Promise<StepTerminalOperation>((resolve) => {
      this.completionResolver = resolve;
    });
    const id = request.operationId ?? randomUUID();
    const logRoot = `database://runs/${request.runId}/steps/${request.stepId}/terminal/${id}`;
    this.operation = {
      id,
      runId: request.runId,
      stepId: request.stepId,
      command: redactSecrets([request.executable, ...request.args].join(" ")),
      executable: redactSecrets(request.executable),
      safeArguments: redactArguments(request.args),
      workingDirectory: request.cwd,
      startedAt: this.startedAt.toISOString(),
      readyAt: null,
      completedAt: null,
      processId: process.pid ?? null,
      childProcessIds: process.pid ? [process.pid] : [],
      exitCode: null,
      signal: null,
      status: "running",
      stdoutLocator: `${logRoot}/stdout`,
      stderrLocator: `${logRoot}/stderr`,
      combinedLogLocator: `${logRoot}/combined`,
      normalizedLog: null,
      errorsDetected: [],
      warningsDetected: [],
      secretRedactionApplied: true
    };
    process.stdout.on("data", (chunk: Buffer) => this.recordOutput("stdout", chunk));
    process.stderr.on("data", (chunk: Buffer) => this.recordOutput("stderr", chunk));
    process.once("error", (error) => this.finalize(null, null, redactSecrets(error.message)));
    process.once("close", (exitCode, signal) => this.finalize(exitCode, signal, null));
    this.timeout = setTimeout(() => {
      this.timedOut = true;
      void this.stop();
    }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.persist();
  }

  static async start(
    request: TerminalSessionRequest,
    options: TerminalSessionOptions = {}
  ): Promise<TerminalSession> {
    const workspacePath = await validateWorkspacePath(request.workspacePath);
    const cwd = await validatePathWithinWorkspace(workspacePath, request.cwd);
    const normalizedRequest: TerminalSessionRequest = { ...request, cwd };
    await validateCommandRequest(normalizedRequest);
    const env = { ...process.env, ...normalizedRequest.env };
    const resolution = await resolveCommand(normalizedRequest.executable, {
      env,
      configurationPath: normalizedRequest.executable,
      versionArgs: null
    });
    if (
      !resolution.resolvedPath ||
      !resolution.invocationKind ||
      resolution.status === "not_found"
    ) {
      throw new Error(`Command not found: ${normalizedRequest.executable}`);
    }
    const invocation = commandInvocation(resolution, normalizedRequest.args, env);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(invocation.executable, invocation.args, {
        cwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: "pipe",
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const redactedDetail = redactSecrets(detail);
      throw new Error(
        `Could not start ${redactSecrets(normalizedRequest.executable)}: ${redactedDetail}`,
        { cause: error }
      );
    }
    return new TerminalSession(normalizedRequest, child, {
      store: options.store,
      errorRecorder: options.errorRecorder,
      killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
      now: options.now ?? (() => new Date())
    });
  }

  snapshot(): StepTerminalOperation {
    return {
      ...this.operation,
      safeArguments: [...this.operation.safeArguments],
      childProcessIds: [...this.operation.childProcessIds],
      normalizedLog: this.operation.normalizedLog
        ? { ...this.operation.normalizedLog }
        : this.operation.normalizedLog,
      errorsDetected: this.operation.errorsDetected.map((error) => ({ ...error })),
      warningsDetected: this.operation.warningsDetected.map((warning) => ({ ...warning }))
    };
  }

  async waitForReadiness(readiness: TerminalReadiness): Promise<StepTerminalOperation> {
    if (!readiness.logPattern && !readiness.httpUrl) {
      throw new Error("Readiness requires a log pattern or HTTP URL");
    }
    const timeoutMs = readiness.timeoutMs ?? 30_000;
    const pollIntervalMs = readiness.pollIntervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.finalized) {
        throw new Error("Runtime exited before readiness was confirmed");
      }
      const logReady = !readiness.logPattern || matches(this.combinedText, readiness.logPattern);
      const httpReady = !readiness.httpUrl || (await hasExpectedStatus(readiness));
      if (logReady && httpReady) {
        this.markReady();
        return this.snapshot();
      }
      if (Date.now() >= deadline) throw new Error("Runtime readiness timed out");
      await delay(pollIntervalMs);
    }
  }

  markReady(): StepTerminalOperation {
    if (this.operation.readyAt === null) {
      this.operation = { ...this.operation, readyAt: this.options.now().toISOString() };
      this.persist();
    }
    return this.snapshot();
  }

  async stop(): Promise<StepTerminalOperation> {
    if (this.finalized) return this.completion;
    if (this.stopPromise) return this.stopPromise;
    this.stopRequested = true;
    this.stopPromise = this.stopOwnedProcessTree();
    return this.stopPromise;
  }

  private async stopOwnedProcessTree(): Promise<StepTerminalOperation> {
    await terminateGracefully(this.process);
    const exited = await Promise.race([
      this.completion.then(() => true),
      delay(this.options.killGraceMs).then(() => false)
    ]);
    if (!exited && !this.finalized) await forceTerminateTree(this.process.pid);
    return this.completion;
  }

  private recordOutput(stream: "stdout" | "stderr", chunk: Buffer): void {
    const redactor = stream === "stdout" ? this.stdout : this.stderr;
    for (const text of redactor.push(chunk.toString("utf8"))) this.appendOutput(stream, text);
  }

  private appendOutput(stream: "stdout" | "stderr", text: string): void {
    if (!text) return;
    if (stream === "stdout") this.stdoutText = this.appendBounded(this.stdoutText, text);
    else this.stderrText = this.appendBounded(this.stderrText, text);
    this.combinedText = this.appendBounded(this.combinedText, `[${stream}] ${text}`);
    this.detectDiagnostics(text, stream);
    this.request.onOutput?.({ stream, text, at: this.options.now().toISOString() });
  }

  private appendBounded(current: string, text: string): string {
    const limit = this.request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const combined = current + text;
    if (Buffer.byteLength(combined) <= limit) return combined;
    this.truncated = true;
    return Buffer.from(combined).subarray(-limit).toString("utf8");
  }

  private detectDiagnostics(text: string, stream: "stdout" | "stderr"): void {
    const source = `terminal-session:${stream}`;
    if (/\b(?:error|exception|fatal|failed|eaddrinuse|unhandled)\b/i.test(text)) {
      const signature = diagnosticSignature("error", text);
      if (!this.errors.has(signature)) {
        const now = this.options.now().toISOString();
        this.errors.set(signature, {
          id: `${this.operation.id}:error:${this.errors.size + 1}`,
          runId: this.operation.runId,
          stepId: this.operation.stepId,
          signature,
          category: text.includes("EADDRINUSE") ? "port" : "unknown",
          severity: "error",
          message: text.trim().slice(0, 20_000),
          source,
          evidencePath: this.operation.combinedLogLocator ?? "terminal-output",
          firstSeenAt: now,
          lastSeenAt: now,
          occurrences: 1,
          status: "open",
          resolution: "Pending runtime correction"
        });
      }
    }
    if (/\bwarn(?:ing)?\b/i.test(text)) {
      const signature = diagnosticSignature("warning", text);
      if (!this.warnings.has(signature)) {
        this.warnings.set(signature, {
          signature,
          category: "unknown",
          message: text.trim().slice(0, 20_000),
          source,
          evidencePath: this.operation.combinedLogLocator ?? "terminal-output",
          firstSeenAt: this.options.now().toISOString(),
          occurrences: 1
        });
      }
    }
  }

  private finalize(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    spawnError: string | null
  ): void {
    if (this.finalized) return;
    this.finalized = true;
    if (this.timeout) clearTimeout(this.timeout);
    for (const text of this.stdout.flush()) this.appendOutput("stdout", text);
    for (const text of this.stderr.flush()) this.appendOutput("stderr", text);
    if (spawnError) this.detectDiagnostics(spawnError, "stderr");
    const status = this.timedOut
      ? "timed_out"
      : this.stopRequested
        ? "cancelled"
        : exitCode === 0
          ? "passed"
          : "failed";
    this.operation = {
      ...this.operation,
      completedAt: this.options.now().toISOString(),
      exitCode,
      signal,
      status,
      normalizedLog: {
        stdout: this.stdoutText,
        stderr: this.stderrText,
        combined: this.combinedText,
        truncated: this.truncated || this.stdout.truncated || this.stderr.truncated
      },
      errorsDetected: [...this.errors.values()],
      warningsDetected: [...this.warnings.values()]
    };
    this.persist();
    this.options.errorRecorder?.recordTerminalOperation(this.snapshot());
    this.completionResolver(this.snapshot());
  }

  private persist(): void {
    this.options.store?.saveStepTerminalOperation(this.snapshot());
  }
}

class LineRedactor {
  private pending = "";
  truncated = false;

  push(text: string): string[] {
    this.pending += text;
    const output: string[] = [];
    let lineEnd = this.pending.indexOf("\n");
    while (lineEnd >= 0) {
      output.push(redactSecrets(this.pending.slice(0, lineEnd + 1)));
      this.pending = this.pending.slice(lineEnd + 1);
      lineEnd = this.pending.indexOf("\n");
    }
    if (Buffer.byteLength(this.pending) > MAX_UNTERMINATED_LINE_BYTES) {
      this.pending = "";
      this.truncated = true;
      output.push("[REDACTED_UNTERMINATED_OUTPUT]");
    }
    return output;
  }

  flush(): string[] {
    if (!this.pending) return [];
    const output = redactSecrets(this.pending);
    this.pending = "";
    return [output];
  }
}

function matches(value: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") return value.includes(pattern);
  pattern.lastIndex = 0;
  return pattern.test(value);
}

async function hasExpectedStatus(readiness: TerminalReadiness): Promise<boolean> {
  try {
    const response = await fetch(readiness.httpUrl!, { signal: AbortSignal.timeout(1_000) });
    return response.status === (readiness.expectedStatus ?? 200);
  } catch {
    return false;
  }
}

function diagnosticSignature(kind: "error" | "warning", text: string): string {
  return `${kind}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

async function terminateGracefully(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform === "win32" && child.pid) {
    const stopped = await taskkill(child.pid, false);
    if (stopped) return;
  }
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    // The process may have exited between the readiness check and shutdown request.
  }
}

async function forceTerminateTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The process group has already exited.
    }
    return;
  }
  await taskkill(pid, true);
}

async function taskkill(pid: number, force: boolean): Promise<boolean> {
  const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  return new Promise((resolve) => {
    let killer: ReturnType<typeof spawn>;
    try {
      killer = spawn(taskkill, ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
        cwd: process.cwd(),
        env: process.env,
        shell: false,
        stdio: "ignore",
        windowsHide: true
      });
    } catch {
      resolve(false);
      return;
    }
    killer.once("error", () => resolve(false));
    killer.once("close", (exitCode) => resolve(exitCode === 0));
  });
}
