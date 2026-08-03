import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveCommand } from "@agent/shared";

export interface RuntimeDiagnostic {
  id: string;
  name: string;
  level: "PASS" | "OPTIONAL" | "ACTION REQUIRED" | "FAIL";
  requirement: "required" | "optional" | "integration";
  detail: string;
  resolvedPath: string | null;
  version: string | null;
  blocking: boolean;
  repairCommand: string | null;
  inAppAction: string | null;
}

export async function runRuntimeDiagnostics(dataDirectory: string): Promise<{
  generatedAt: string;
  mode: "packaged" | "development";
  checks: RuntimeDiagnostic[];
}> {
  const checks: RuntimeDiagnostic[] = [
    {
      id: "bundled-runtime",
      name: "Bundled Electron runtime",
      level: "PASS",
      requirement: "required",
      detail:
        "The app-owned daemon runs through Electron; system Node.js and npm are not required.",
      resolvedPath: process.execPath,
      version: process.versions.electron,
      blocking: false,
      repairCommand: null,
      inAppAction: null
    },
    await dataAccessCheck(dataDirectory),
    await integrationCheck(
      "git",
      "Git",
      "integration",
      "Git is required for repository lifecycle operations."
    ),
    await integrationCheck(
      "codex",
      "Codex CLI",
      "integration",
      "Codex-backed implementation remains disabled until the CLI is installed and signed in."
    ),
    await integrationCheck(
      "github",
      "GitHub CLI",
      "optional",
      "GitHub lifecycle automation remains unavailable until the CLI is installed and signed in."
    ),
    await integrationCheck(
      "vscode",
      "VS Code",
      "optional",
      "Manual folder selection remains available without VS Code."
    ),
    await integrationCheck("ollama", "Ollama", "optional", "Local model support remains optional.")
  ];
  return {
    generatedAt: new Date().toISOString(),
    mode: process.env.AGENT_MANAGED_BY_DESKTOP === "1" ? "packaged" : "development",
    checks
  };
}

async function dataAccessCheck(dataDirectory: string): Promise<RuntimeDiagnostic> {
  try {
    await mkdir(dataDirectory, { recursive: true });
    const probe = join(dataDirectory, `.diagnostic-${process.pid}`);
    await writeFile(probe, "ok", "utf8");
    await access(probe);
    await rm(probe, { force: true });
    return {
      id: "data",
      name: "Local data and log directory",
      level: "PASS",
      requirement: "required",
      detail: dataDirectory,
      resolvedPath: dataDirectory,
      version: null,
      blocking: false,
      repairCommand: null,
      inAppAction: null
    };
  } catch (error) {
    return {
      id: "data",
      name: "Local data and log directory",
      level: "FAIL",
      requirement: "required",
      detail: error instanceof Error ? error.message : String(error),
      resolvedPath: dataDirectory,
      version: null,
      blocking: true,
      repairCommand: null,
      inAppAction: "Choose a writable data directory before continuing."
    };
  }
}

async function integrationCheck(
  id: string,
  name: string,
  requirement: "optional" | "integration",
  unavailableAction: string
): Promise<RuntimeDiagnostic> {
  const command = { github: "gh", vscode: "code" }[id] ?? id;
  const resolution = await resolveCommand(command, {
    configurationPath: command
  });
  const available =
    resolution.status === "available" || resolution.status === "installed_not_on_path";
  return {
    id,
    name,
    level: available ? "PASS" : requirement === "optional" ? "OPTIONAL" : "ACTION REQUIRED",
    requirement,
    detail: available
      ? `${resolution.version ?? "version unknown"} at ${resolution.resolvedPath ?? "unknown path"}`
      : (resolution.error ?? "Not found"),
    resolvedPath: resolution.resolvedPath,
    version: resolution.version,
    blocking: false,
    repairCommand: available ? null : `Install ${name} from Setup & Connections.`,
    inAppAction: available ? null : unavailableAction
  };
}
