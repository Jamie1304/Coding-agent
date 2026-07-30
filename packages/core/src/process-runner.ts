import { resolveCommand, runCommandResolution } from "@agent/shared";

export interface CommandRequest {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}

export interface CommandResult {
  executable: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export class ProcessRunner {
  async run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
    const started = performance.now();
    const env = { ...process.env, ...request.env };
    const resolution = await resolveCommand(request.executable, {
      env,
      configurationPath: request.executable,
      versionArgs: null
    });
    if (
      !resolution.resolvedPath ||
      !resolution.invocationKind ||
      resolution.status === "not_found"
    ) {
      throw new Error(`Command not found: ${request.executable}`);
    }
    const result = await runCommandResolution(resolution, request.args, {
      cwd: request.cwd,
      env,
      timeoutMs: request.timeoutMs ?? 10 * 60_000,
      maxOutputBytes: request.maxOutputBytes ?? 2_000_000,
      ...(signal ? { signal } : {})
    });
    if (result.spawnError) {
      throw new Error(`Could not start ${resolution.resolvedPath}: ${result.spawnError}`);
    }
    return {
      executable: resolution.resolvedPath,
      args: request.args,
      cwd: request.cwd,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Math.round(performance.now() - started),
      timedOut: result.timedOut,
      truncated: result.truncated
    };
  }
}
