import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DAEMON_PROTOCOL_VERSION, PRODUCT_VERSION, isLoopbackUrl } from "./product.js";

export type RuntimePhase = "starting" | "ready" | "recovering" | "failed" | "stopped";

export interface RuntimeStatus {
  phase: RuntimePhase;
  message: string;
  attempts: number;
  safeMode: boolean;
  updatedAt: string;
}

export interface DaemonConnection {
  url: string;
  token: string;
  pid: number;
  version: string;
  protocol: number;
}

export interface OwnedProcess {
  pid: number;
  kill(): void;
  onExit(listener: (code: number | null) => void): void;
}

export interface DaemonLaunch {
  process: OwnedProcess;
  ready: Promise<{ url: string; pid: number }>;
}

export interface DaemonManagerOptions {
  dataDirectory: string;
  launch(input: { token: string; safeMode: boolean }): DaemonLaunch;
  fetcher?: typeof fetch;
  productVersion?: string;
  protocolVersion?: number;
  readinessTimeoutMs?: number;
  restartLimit?: number;
  restartDelayMs?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface ConnectionMetadata extends DaemonConnection {
  owner: "desktop";
  startedAt: string;
}

export class DaemonManager {
  private readonly fetcher: typeof fetch;
  private readonly productVersion: string;
  private readonly protocolVersion: number;
  private readonly readinessTimeoutMs: number;
  private readonly restartLimit: number;
  private readonly restartDelayMs: number;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private process: OwnedProcess | null = null;
  private connection: DaemonConnection | null = null;
  private statusValue: RuntimeStatus;
  private startPromise: Promise<DaemonConnection> | null = null;
  private stopping = false;
  private unexpectedRestartCount = 0;

  constructor(private readonly options: DaemonManagerOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.productVersion = options.productVersion ?? PRODUCT_VERSION;
    this.protocolVersion = options.protocolVersion ?? DAEMON_PROTOCOL_VERSION;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 15_000;
    this.restartLimit = options.restartLimit ?? 2;
    this.restartDelayMs = options.restartDelayMs ?? 750;
    this.now = options.now ?? (() => new Date());
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.statusValue = this.status("stopped", "Desktop runtime has not started.", 0, false);
  }

  getStatus(): RuntimeStatus {
    return this.statusValue;
  }

  getConnection(): DaemonConnection | null {
    return this.connection;
  }

  async start(safeMode = false): Promise<DaemonConnection> {
    if (this.connection) return this.connection;
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.unexpectedRestartCount = 0;
    this.startPromise = this.startInternal(safeMode).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async retry(safeMode = false): Promise<DaemonConnection> {
    await this.stop();
    return this.start(safeMode);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.connection = null;
    const current = this.process;
    this.process = null;
    if (current) current.kill();
    await this.removeConnectionMetadata();
    this.statusValue = this.status("stopped", "Desktop runtime stopped.", 0, false);
  }

  private async startInternal(safeMode: boolean): Promise<DaemonConnection> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.restartLimit; attempt += 1) {
      this.statusValue = this.status(
        attempt === 0 ? "starting" : "recovering",
        attempt === 0
          ? "Starting the local runtime…"
          : `Restarting the local runtime (${String(attempt)}/${String(this.restartLimit)})…`,
        attempt,
        safeMode
      );
      try {
        const connection = await this.launchAndVerify(safeMode);
        this.connection = connection;
        this.statusValue = this.status("ready", "Local runtime is ready.", attempt, safeMode);
        await this.writeConnectionMetadata(connection);
        return connection;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.connection = null;
        this.process = null;
        if (attempt < this.restartLimit) await this.sleep(this.restartDelayMs);
      }
    }
    const message = `The local runtime could not start: ${lastError?.message ?? "unknown error"}`;
    this.statusValue = this.status("failed", message, this.restartLimit, safeMode);
    throw new Error(message, lastError ? { cause: lastError } : undefined);
  }

  private async launchAndVerify(safeMode: boolean): Promise<DaemonConnection> {
    const token = randomBytes(32).toString("base64url");
    const launched = this.options.launch({ token, safeMode });
    this.process = launched.process;
    launched.process.onExit((code) => this.handleUnexpectedExit(code));
    const ready = await timeout(
      launched.ready,
      this.readinessTimeoutMs,
      "The local runtime did not report readiness before the timeout."
    );
    if (!isLoopbackUrl(ready.url)) {
      throw new Error("The local runtime reported a non-loopback endpoint.");
    }
    const response = await timeout(
      this.fetcher(`${ready.url}/health`, { headers: { "x-agent-token": token } }),
      this.readinessTimeoutMs,
      "The local runtime health check timed out."
    );
    if (!response.ok)
      throw new Error(`The local runtime health check returned ${response.status}.`);
    const health = (await response.json()) as {
      status?: unknown;
      version?: unknown;
      protocol?: unknown;
      bind?: unknown;
    };
    if (health.status !== "ok" || health.bind !== "127.0.0.1") {
      throw new Error("The local runtime health response was invalid.");
    }
    if (health.version !== this.productVersion || health.protocol !== this.protocolVersion) {
      throw new Error(
        `Runtime compatibility check failed (desktop ${this.productVersion}/${String(this.protocolVersion)}, daemon ${String(health.version)}/${String(health.protocol)}).`
      );
    }
    return {
      url: ready.url,
      token,
      pid: ready.pid,
      version: this.productVersion,
      protocol: this.protocolVersion
    };
  }

  private handleUnexpectedExit(code: number | null): void {
    if (this.stopping || this.process === null) return;
    this.connection = null;
    this.process = null;
    if (this.unexpectedRestartCount < this.restartLimit) {
      this.unexpectedRestartCount += 1;
      this.statusValue = this.status(
        "recovering",
        `The local runtime exited unexpectedly. Restarting (${String(this.unexpectedRestartCount)}/${String(this.restartLimit)})…`,
        this.unexpectedRestartCount,
        this.statusValue.safeMode
      );
      void this.removeConnectionMetadata();
      void this.sleep(this.restartDelayMs).then(() => {
        if (this.stopping || this.connection || this.startPromise) return;
        this.startPromise = this.startInternal(this.statusValue.safeMode).finally(() => {
          this.startPromise = null;
        });
        void this.startPromise.catch(() => undefined);
      });
      return;
    }
    this.statusValue = this.status(
      "failed",
      `The local runtime exited unexpectedly (${code === null ? "unknown" : String(code)}). Select Retry to restart it.`,
      this.statusValue.attempts,
      this.statusValue.safeMode
    );
    void this.removeConnectionMetadata();
  }

  private status(
    phase: RuntimePhase,
    message: string,
    attempts: number,
    safeMode: boolean
  ): RuntimeStatus {
    return { phase, message, attempts, safeMode, updatedAt: this.now().toISOString() };
  }

  private metadataPath(): string {
    return join(this.options.dataDirectory, "daemon.json");
  }

  private async writeConnectionMetadata(connection: DaemonConnection): Promise<void> {
    await mkdir(this.options.dataDirectory, { recursive: true });
    const value: ConnectionMetadata = {
      ...connection,
      owner: "desktop",
      startedAt: this.now().toISOString()
    };
    await writeFile(this.metadataPath(), JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
  }

  private async removeConnectionMetadata(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.metadataPath(), "utf8")) as { owner?: unknown };
      if (parsed.owner !== "desktop") return;
      await rm(this.metadataPath(), { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function timeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
