import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  TerminalSession,
  type TerminalReadiness,
  type TerminalSessionOptions,
  type TerminalSessionRequest
} from "./terminal-session.js";
import type { StepTerminalOperation } from "@agent/shared";

export interface RuntimeLaunchRequest extends TerminalSessionRequest {
  readiness: TerminalReadiness;
  expectedPorts?: number[];
  portHost?: string;
}

export interface RuntimeSupervisorOptions extends TerminalSessionOptions {
  portReleaseTimeoutMs?: number;
}

interface SupervisedRuntime {
  session: TerminalSession;
  request: RuntimeLaunchRequest;
}

export class RuntimeSupervisor {
  private readonly sessions = new Map<string, SupervisedRuntime>();
  private readonly portReleaseTimeoutMs: number;

  constructor(private readonly options: RuntimeSupervisorOptions = {}) {
    this.portReleaseTimeoutMs = options.portReleaseTimeoutMs ?? 10_000;
  }

  async start(request: RuntimeLaunchRequest): Promise<TerminalSession> {
    const session = await TerminalSession.start(request, this.options);
    const id = session.snapshot().id;
    if (this.sessions.has(id)) {
      await session.stop();
      throw new Error(`A runtime session already exists for ${id}`);
    }
    this.sessions.set(id, { session, request: cloneRequest(request) });
    void session.completion.then(() => this.sessions.delete(id));
    try {
      await session.waitForReadiness(request.readiness);
      return session;
    } catch (error) {
      await session.stop();
      this.sessions.delete(id);
      throw error;
    }
  }

  session(id: string): TerminalSession | null {
    return this.sessions.get(id)?.session ?? null;
  }

  async stop(id: string): Promise<StepTerminalOperation> {
    const runtime = this.sessions.get(id);
    if (!runtime) throw new Error(`Runtime session not found: ${id}`);
    const operation = await runtime.session.stop();
    await this.assertPortsReleased(runtime.request.expectedPorts ?? [], runtime.request.portHost);
    this.sessions.delete(id);
    return operation;
  }

  async restart(id: string): Promise<TerminalSession> {
    const runtime = this.sessions.get(id);
    if (!runtime) throw new Error(`Runtime session not found: ${id}`);
    const request = cloneRequest(runtime.request);
    delete request.operationId;
    await this.stop(id);
    return this.start(request);
  }

  async stopAll(): Promise<StepTerminalOperation[]> {
    const ids = [...this.sessions.keys()];
    return Promise.all(ids.map((id) => this.stop(id)));
  }

  async assertPortsReleased(ports: number[], host = "127.0.0.1"): Promise<void> {
    if (ports.length === 0) return;
    const invalid = ports.find((port) => !Number.isInteger(port) || port < 1 || port > 65_535);
    if (invalid !== undefined) throw new Error(`Invalid runtime port: ${invalid}`);
    const deadline = Date.now() + this.portReleaseTimeoutMs;
    for (;;) {
      if (
        await Promise.all(ports.map((port) => isPortAvailable(port, host))).then((result) =>
          result.every(Boolean)
        )
      ) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Runtime ports were not released: ${ports.join(", ")}`);
      }
      await delay(100);
    }
  }
}

export async function isPortAvailable(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close((error) => resolve(!error));
    });
  });
}

function cloneRequest(request: RuntimeLaunchRequest): RuntimeLaunchRequest {
  return {
    ...request,
    args: [...request.args],
    ...(request.env ? { env: { ...request.env } } : {}),
    ...(request.expectedPorts ? { expectedPorts: [...request.expectedPorts] } : {})
  };
}
