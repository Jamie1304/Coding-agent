import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveCommand, runCommandResolution, type CommandResolution } from "@agent/shared";
import { diagnoseElectron, type ElectronDiagnostic } from "./electron-runtime.js";

export type DoctorLevel = "PASS" | "WARNING" | "OPTIONAL" | "ACTION REQUIRED" | "FAIL";

export interface DoctorCheck {
  id: string;
  name: string;
  level: DoctorLevel;
  requirement: "required" | "optional" | "integration";
  detail: string;
  resolvedPath: string | null;
  version: string | null;
  authenticationRequired: boolean;
  blocking: boolean;
  repairCommand: string | null;
  inAppAction: string | null;
}

export interface DoctorReport {
  generatedAt: string;
  repositoryRoot: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  checks: DoctorCheck[];
  electron: ElectronDiagnostic;
  summary: {
    pass: number;
    warnings: number;
    optional: number;
    actionRequired: number;
    failures: number;
    blockingFailures: number;
  };
}

export interface DoctorDependencies {
  electron?: ElectronDiagnostic;
}

export async function runDoctor(
  repositoryRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: DoctorDependencies = {}
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push(
    await commandCheck({
      id: "node",
      name: "Node.js",
      command: process.execPath,
      minimumMajorVersion: 22,
      requirement: "required",
      repairCommand: "winget install --id OpenJS.NodeJS.LTS -e",
      inAppAction: null,
      env
    })
  );
  checks.push(
    await commandCheck({
      id: "npm",
      name: "npm",
      command: "npm",
      requirement: "required",
      repairCommand: "winget install --id OpenJS.NodeJS.LTS -e",
      inAppAction: null,
      env
    })
  );
  checks.push(
    await commandCheck({
      id: "git",
      name: "Git",
      command: "git",
      requirement: "integration",
      repairCommand: "winget install --id Git.Git -e",
      inAppAction: "Git is required only when a run performs repository lifecycle operations.",
      env
    })
  );
  const vscode = await commandCheck({
    id: "vscode",
    name: "VS Code",
    command: "code",
    requirement: "optional",
    repairCommand: "winget install --id Microsoft.VisualStudioCode -e",
    inAppAction: "Manual folder selection remains available.",
    env
  });
  checks.push(vscode);
  checks.push(
    await integrationStatus({
      id: "vscode-extension",
      name: "VS Code extension",
      command: vscode,
      args: ["--list-extensions"],
      requirement: "optional",
      success: (output) =>
        output.toLowerCase().includes("personal-codex-agent.personal-codex-agent-vscode"),
      missingDetail:
        "VS Code is available, but the Personal Codex Agent extension is not installed.",
      repairCommand: ".\\scripts\\install-vscode-extension.ps1",
      inAppAction: "Manual folder selection remains available.",
      repositoryRoot,
      env
    })
  );
  const github = await commandCheck({
    id: "github",
    name: "GitHub CLI",
    command: "gh",
    requirement: "optional",
    repairCommand: "winget install --id GitHub.cli -e",
    inAppAction: "Configure GitHub only when issue, pull request, or release automation is needed.",
    env
  });
  checks.push(github);
  checks.push(
    await integrationStatus({
      id: "github-auth",
      name: "GitHub authentication",
      command: github,
      args: ["auth", "status"],
      requirement: "optional",
      success: (_output, exitCode) => exitCode === 0,
      missingDetail: "GitHub CLI is not authenticated; local runs remain available.",
      repairCommand: "gh auth login",
      inAppAction: "Required only for GitHub lifecycle automation.",
      repositoryRoot,
      env
    })
  );
  const codex = await commandCheck({
    id: "codex",
    name: "Codex CLI",
    command: env.CODEX_EXECUTABLE ?? "codex",
    requirement: "integration",
    repairCommand: "npm install -g @openai/codex",
    inAppAction: "The desktop shell and provider setup work without Codex.",
    env
  });
  checks.push(codex);
  checks.push(await codexAuthentication(codex, repositoryRoot, env));

  const dataDirectory =
    env.AGENT_DATA_DIR ?? join(env.LOCALAPPDATA ?? repositoryRoot, "PersonalCodexAgent");
  try {
    await mkdir(dataDirectory, { recursive: true });
    const probe = join(dataDirectory, `.doctor-${process.pid}`);
    await writeFile(probe, "ok", "utf8");
    await access(probe);
    await rm(probe);
    checks.push({
      id: "data",
      name: "Local data/report access",
      level: "PASS",
      requirement: "required",
      detail: dataDirectory,
      resolvedPath: dataDirectory,
      version: null,
      authenticationRequired: false,
      blocking: false,
      repairCommand: null,
      inAppAction: null
    });
  } catch (error) {
    checks.push({
      id: "data",
      name: "Local data/report access",
      level: "FAIL",
      requirement: "required",
      detail: safeError(error),
      resolvedPath: dataDirectory,
      version: null,
      authenticationRequired: false,
      blocking: true,
      repairCommand: "$env:AGENT_DATA_DIR='<WRITABLE-LOCAL-DIRECTORY>'",
      inAppAction: "Choose a writable report directory in Settings."
    });
  }
  const electron = dependencies.electron ?? (await diagnoseElectron(repositoryRoot, env));
  checks.push({
    id: "electron",
    name: "Electron desktop runtime",
    level: electron.selectedExecutable
      ? electron.rawLaunchStatus === "available"
        ? "PASS"
        : "WARNING"
      : "FAIL",
    requirement: "required",
    detail: electron.selectedExecutable
      ? `${electron.selectedKind} selected`
      : "No runnable Electron executable was found.",
    resolvedPath: electron.selectedExecutable,
    version: electron.packageVersion,
    authenticationRequired: false,
    blocking: !electron.selectedExecutable,
    repairCommand: electron.repairActions[0] ?? null,
    inAppAction: null
  });

  return {
    generatedAt: new Date().toISOString(),
    repositoryRoot,
    platform: process.platform,
    nodeVersion: process.version,
    checks,
    electron,
    summary: {
      pass: checks.filter((item) => item.level === "PASS").length,
      warnings: checks.filter((item) => item.level === "WARNING").length,
      optional: checks.filter((item) => item.level === "OPTIONAL").length,
      actionRequired: checks.filter((item) => item.level === "ACTION REQUIRED").length,
      failures: checks.filter((item) => item.level === "FAIL").length,
      blockingFailures: checks.filter((item) => item.blocking).length
    }
  };
}

interface CommandCheckInput {
  id: string;
  name: string;
  command: string;
  minimumMajorVersion?: number;
  requirement: DoctorCheck["requirement"];
  repairCommand: string;
  inAppAction: string | null;
  env: NodeJS.ProcessEnv;
}

async function commandCheck(input: CommandCheckInput): Promise<DoctorCheck> {
  const resolution = await resolveCommand(input.command, {
    env: input.env,
    configurationPath: input.command,
    ...(input.minimumMajorVersion === undefined
      ? {}
      : { minimumMajorVersion: input.minimumMajorVersion })
  });
  const available =
    resolution.status === "available" || resolution.status === "installed_not_on_path";
  const blocking = input.requirement === "required" && !available;
  const level: DoctorLevel = available
    ? resolution.status === "installed_not_on_path"
      ? "WARNING"
      : "PASS"
    : blocking
      ? "FAIL"
      : input.requirement === "optional"
        ? "OPTIONAL"
        : "ACTION REQUIRED";
  return {
    id: input.id,
    name: input.name,
    level,
    requirement: input.requirement,
    detail: commandDetail(resolution),
    resolvedPath: resolution.resolvedPath,
    version: resolution.version,
    authenticationRequired: false,
    blocking,
    repairCommand: available ? null : input.repairCommand,
    inAppAction: input.inAppAction
  };
}

async function codexAuthentication(
  codex: DoctorCheck,
  repositoryRoot: string,
  env: NodeJS.ProcessEnv
): Promise<DoctorCheck> {
  if (!codex.resolvedPath) {
    return {
      id: "codex-auth",
      name: "Codex authentication",
      level: "ACTION REQUIRED",
      requirement: "integration",
      detail: "Install Codex before authentication.",
      resolvedPath: null,
      version: null,
      authenticationRequired: true,
      blocking: false,
      repairCommand: "npm install -g @openai/codex",
      inAppAction: "Codex-backed repository runs remain disabled."
    };
  }
  const kind = codex.resolvedPath.toLowerCase().endsWith(".cmd")
    ? "cmd"
    : codex.resolvedPath.toLowerCase().endsWith(".bat")
      ? "bat"
      : "exe";
  const result = await runCommandResolution(
    { resolvedPath: codex.resolvedPath, invocationKind: kind },
    ["login", "status"],
    { cwd: repositoryRoot, env, timeoutMs: 15_000, maxOutputBytes: 64_000 }
  );
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const authenticated = result.exitCode === 0 && !result.spawnError;
  return {
    id: "codex-auth",
    name: "Codex authentication",
    level: authenticated ? "PASS" : "ACTION REQUIRED",
    requirement: "integration",
    detail: output || result.spawnError || `Exited with code ${String(result.exitCode)}`,
    resolvedPath: codex.resolvedPath,
    version: null,
    authenticationRequired: true,
    blocking: false,
    repairCommand: authenticated ? null : "codex login",
    inAppAction: authenticated ? null : "Codex-backed operations remain disabled until sign-in."
  };
}

function commandDetail(resolution: CommandResolution): string {
  if (resolution.resolvedPath) {
    return `${resolution.version ?? "version unknown"} at ${resolution.resolvedPath}`;
  }
  return resolution.error ?? "Not found";
}

async function integrationStatus(input: {
  id: string;
  name: string;
  command: DoctorCheck;
  args: string[];
  requirement: "optional" | "integration";
  success: (output: string, exitCode: number | null) => boolean;
  missingDetail: string;
  repairCommand: string;
  inAppAction: string;
  repositoryRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<DoctorCheck> {
  if (!input.command.resolvedPath) {
    return {
      id: input.id,
      name: input.name,
      level: input.requirement === "optional" ? "OPTIONAL" : "ACTION REQUIRED",
      requirement: input.requirement,
      detail: `Cannot check because ${input.command.name} is unavailable.`,
      resolvedPath: null,
      version: null,
      authenticationRequired: input.id.endsWith("-auth"),
      blocking: false,
      repairCommand: input.command.repairCommand,
      inAppAction: input.inAppAction
    };
  }
  const lower = input.command.resolvedPath.toLowerCase();
  const invocationKind = lower.endsWith(".cmd") ? "cmd" : lower.endsWith(".bat") ? "bat" : "exe";
  const result = await runCommandResolution(
    { resolvedPath: input.command.resolvedPath, invocationKind },
    input.args,
    {
      cwd: input.repositoryRoot,
      env: input.env,
      timeoutMs: 15_000,
      maxOutputBytes: 128_000
    }
  );
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const successful = !result.spawnError && input.success(output, result.exitCode);
  return {
    id: input.id,
    name: input.name,
    level: successful ? "PASS" : input.requirement === "optional" ? "OPTIONAL" : "ACTION REQUIRED",
    requirement: input.requirement,
    detail: successful
      ? input.id === "vscode-extension"
        ? "personal-codex-agent.personal-codex-agent-vscode"
        : (output.split(/\r?\n/)[0] ?? "Configured")
      : input.missingDetail,
    resolvedPath: input.command.resolvedPath,
    version: null,
    authenticationRequired: input.id.endsWith("-auth"),
    blocking: false,
    repairCommand: successful ? null : input.repairCommand,
    inAppAction: successful ? null : input.inAppAction
  };
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/(?:sk|key|token|secret)-[A-Za-z0-9._-]+/gi, "[REDACTED]");
}
