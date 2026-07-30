import { spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

export interface RepairAction {
  label: string;
  command: string | null;
}

export interface CommandResolution {
  command: string;
  status:
    | "available"
    | "not_found"
    | "installed_not_on_path"
    | "not_executable"
    | "version_unsupported"
    | "error";
  resolvedPath: string | null;
  invocationKind: "exe" | "cmd" | "bat" | "script" | null;
  discoveredBy: "path" | "where" | "known_location" | "npm_prefix" | "configuration" | null;
  version: string | null;
  warning: string | null;
  repairActions: RepairAction[];
  error: string | null;
}

export interface CommandResolverOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  configurationPath?: string;
  knownLocations?: string[];
  versionArgs?: string[] | null;
  versionPattern?: RegExp;
  minimumMajorVersion?: number;
  timeoutMs?: number;
}

interface Candidate {
  path: string;
  discoveredBy: NonNullable<CommandResolution["discoveredBy"]>;
  onPath: boolean;
}

export async function resolveCommand(
  command: string,
  options: CommandResolverOptions = {}
): Promise<CommandResolution> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const candidates = await commandCandidates(command, platform, env, options);
  for (const candidate of candidates) {
    const checked = await validateCandidate(candidate.path, platform);
    if (!checked.valid) continue;
    const invocationKind = kindFor(checked.path, platform);
    const base: CommandResolution = {
      command,
      status: candidate.onPath ? "available" : "installed_not_on_path",
      resolvedPath: checked.path,
      invocationKind,
      discoveredBy: candidate.discoveredBy,
      version: null,
      warning: candidate.onPath ? null : "Installed but not available through the current PATH.",
      repairActions: candidate.onPath
        ? []
        : [{ label: "Add the command directory to PATH", command: null }],
      error: null
    };
    if (options.versionArgs === null) return base;
    const versionArgs = options.versionArgs ?? ["--version"];
    const result = await runCommandResolution(base, versionArgs, {
      cwd: process.cwd(),
      env,
      timeoutMs: options.timeoutMs ?? 10_000,
      maxOutputBytes: 64_000
    });
    if (result.spawnError) {
      return {
        ...base,
        status: "not_executable",
        warning: "The command was found but Windows could not execute it.",
        error: result.spawnError
      };
    }
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const version = parseVersion(output, options.versionPattern);
    if (result.timedOut || result.exitCode !== 0) {
      return {
        ...base,
        status: "error",
        version,
        warning: result.timedOut
          ? "Version check timed out."
          : `Version check exited with code ${String(result.exitCode)}.`,
        error: output || null
      };
    }
    if (
      options.minimumMajorVersion !== undefined &&
      version !== null &&
      Number(version.match(/\d+/)?.[0]) < options.minimumMajorVersion
    ) {
      return {
        ...base,
        status: "version_unsupported",
        version,
        warning: `Version ${version} is below required major version ${options.minimumMajorVersion}.`
      };
    }
    return { ...base, version };
  }
  return {
    command,
    status: "not_found",
    resolvedPath: null,
    invocationKind: null,
    discoveredBy: null,
    version: null,
    warning: null,
    repairActions: [],
    error: null
  };
}

export function commandInvocation(
  resolution: Pick<CommandResolution, "resolvedPath" | "invocationKind">,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): { executable: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (!resolution.resolvedPath || !resolution.invocationKind) {
    throw new Error("Cannot invoke an unresolved command");
  }
  if (resolution.invocationKind === "cmd" || resolution.invocationKind === "bat") {
    const comspec =
      env.ComSpec ?? env.COMSPEC ?? join(env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    const commandLine = [resolution.resolvedPath, ...args].map(quoteCmdArgument).join(" ");
    return {
      executable: comspec,
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      windowsVerbatimArguments: true
    };
  }
  if (resolution.invocationKind === "script") {
    return {
      executable: process.execPath,
      args: [resolution.resolvedPath, ...args],
      windowsVerbatimArguments: false
    };
  }
  return { executable: resolution.resolvedPath, args, windowsVerbatimArguments: false };
}

export interface ResolvedRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface ResolvedRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  spawnError: string | null;
}

export async function runCommandResolution(
  resolution: Pick<CommandResolution, "resolvedPath" | "invocationKind">,
  args: string[],
  options: ResolvedRunOptions
): Promise<ResolvedRunResult> {
  const invocation = commandInvocation(resolution, args, options.env);
  return new Promise((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const limit = options.maxOutputBytes ?? 2_000_000;
    let child;
    try {
      child = spawn(invocation.executable, invocation.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments
      });
    } catch (error) {
      const detail = error instanceof Error ? error : new Error(String(error));
      resolveRun({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        truncated,
        spawnError: `${detail.message}${"code" in detail ? ` (${String(detail.code)})` : ""}`
      });
      return;
    }
    const append = (current: string, chunk: Buffer): string => {
      const combined = current + chunk.toString("utf8");
      if (Buffer.byteLength(combined) <= limit) return combined;
      truncated = true;
      return combined.slice(-limit);
    };
    const finish = (result: ResolvedRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolveRun(result);
    };
    child.stdout.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)));
    child.once("error", (error) =>
      finish({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        truncated,
        spawnError: `${error.message}${"code" in error ? ` (${String(error.code)})` : ""}`
      })
    );
    const abort = (): void => {
      terminateProcess(child.pid, child.kill.bind(child), options.env);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => {
        timedOut = true;
        terminateProcess(child.pid, child.kill.bind(child), options.env);
      },
      options.timeoutMs ?? 10 * 60_000
    );
    child.once("close", (exitCode, childSignal) =>
      finish({
        exitCode,
        signal: childSignal,
        stdout,
        stderr,
        timedOut,
        truncated,
        spawnError: null
      })
    );
  });
}

function terminateProcess(
  pid: number | undefined,
  fallback: () => boolean,
  env: NodeJS.ProcessEnv | undefined
): void {
  if (process.platform !== "win32" || !pid) {
    fallback();
    return;
  }
  const taskkill = join(
    env?.SystemRoot ?? process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "taskkill.exe"
  );
  try {
    const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
      env: env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: "ignore"
    });
    killer.once("error", fallback);
  } catch {
    fallback();
  }
}

async function commandCandidates(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  options: CommandResolverOptions
): Promise<Candidate[]> {
  const output: Candidate[] = [];
  const add = (
    path: string | undefined,
    discoveredBy: Candidate["discoveredBy"],
    onPath: boolean
  ): void => {
    if (!path) return;
    const normalized = resolve(path.replace(/^"|"$/g, ""));
    if (!output.some((item) => item.path.toLowerCase() === normalized.toLowerCase())) {
      output.push({ path: normalized, discoveredBy, onPath });
    }
  };
  add(options.configurationPath, "configuration", true);
  if (isAbsolute(command)) add(command, "configuration", true);
  else {
    const extensions = executableExtensions(command, platform, env);
    for (const directory of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
      for (const extension of extensions)
        add(join(directory, `${command}${extension}`), "path", true);
    }
    for (const result of await whereResults(command, platform, env)) add(result, "where", true);
    const npmDirectory = env.APPDATA ? join(env.APPDATA, "npm") : null;
    if (npmDirectory) {
      for (const extension of extensions) {
        add(join(npmDirectory, `${command}${extension}`), "npm_prefix", false);
      }
    }
    const nodeDirectory = dirname(process.execPath);
    for (const extension of extensions) {
      add(join(nodeDirectory, `${command}${extension}`), "known_location", false);
    }
  }
  for (const location of options.knownLocations ?? knownLocations(command, env)) {
    add(location, "known_location", false);
  }
  return output;
}

function executableExtensions(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] {
  if (extname(command)) return [""];
  if (platform !== "win32") return [""];
  return (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((item) => item.toLowerCase());
}

async function whereResults(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): Promise<string[]> {
  if (platform !== "win32") return [];
  const wherePath = join(env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");
  const candidate = await validateCandidate(wherePath, platform);
  if (!candidate.valid) return [];
  const resolution = {
    resolvedPath: candidate.path,
    invocationKind: "exe" as const
  };
  const result = await runCommandResolution(resolution, [command], {
    cwd: process.cwd(),
    env,
    timeoutMs: 3_000,
    maxOutputBytes: 32_000
  });
  return result.exitCode === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
}

async function validateCandidate(
  path: string,
  platform: NodeJS.Platform
): Promise<{ valid: boolean; path: string }> {
  try {
    const canonical = await realpath(path);
    const details = await stat(canonical);
    if (!details.isFile()) return { valid: false, path: canonical };
    if (platform !== "win32") await access(canonical, 1);
    return { valid: true, path: canonical };
  } catch {
    return { valid: false, path };
  }
}

function kindFor(path: string, platform: NodeJS.Platform): CommandResolution["invocationKind"] {
  const extension = extname(path).toLowerCase();
  if (extension === ".cmd") return "cmd";
  if (extension === ".bat") return "bat";
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "script";
  return platform === "win32" || extension ? "exe" : "script";
}

function knownLocations(command: string, env: NodeJS.ProcessEnv): string[] {
  const local = env.LOCALAPPDATA;
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES;
  const appData = env.APPDATA;
  const names = command.toLowerCase().replace(/\.(exe|cmd|bat)$/i, "");
  const locations: Record<string, Array<string | undefined>> = {
    code: [
      local ? join(local, "Programs", "Microsoft VS Code", "bin", "code.cmd") : undefined,
      local ? join(local, "Programs", "Microsoft VS Code", "Code.exe") : undefined,
      programFiles ? join(programFiles, "Microsoft VS Code", "bin", "code.cmd") : undefined
    ],
    gh: [programFiles ? join(programFiles, "GitHub CLI", "gh.exe") : undefined],
    codex: [appData ? join(appData, "npm", "codex.cmd") : undefined],
    npm: [appData ? join(appData, "npm", "npm.cmd") : undefined]
  };
  return (locations[names] ?? []).filter((item): item is string => Boolean(item));
}

function parseVersion(output: string, pattern?: RegExp): string | null {
  if (!output) return null;
  const match = pattern ? output.match(pattern) : output.match(/v?\d+(?:\.\d+){1,3}(?:[-+.\w]*)?/i);
  return match?.[1] ?? match?.[0] ?? output.split(/\r?\n/)[0]?.trim() ?? null;
}

function quoteCmdArgument(value: string): string {
  if (/[\r\n"%]/.test(value)) {
    throw new Error(
      "A .cmd/.bat argument contains a character that cannot be passed safely through cmd.exe."
    );
  }
  return `"${value}"`;
}
