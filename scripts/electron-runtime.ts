import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { runCommandResolution } from "@agent/shared";

export interface ElectronDiagnostic {
  packageVersion: string;
  rawExecutable: string;
  rawExists: boolean;
  rawSize: number | null;
  pathFile: string;
  pathFileValue: string | null;
  pathFileValid: boolean;
  rawVersion: string | null;
  rawLaunchStatus: "available" | "missing" | "blocked_or_not_executable" | "invalid";
  rawError: string | null;
  packagedExecutable: string;
  packagedExists: boolean;
  packagedSize: number | null;
  packagedVersion: string | null;
  packagedLaunchStatus: "available" | "missing" | "blocked_or_not_executable" | "invalid";
  packagedError: string | null;
  selectedExecutable: string | null;
  selectedKind: "raw-electron" | "packaged-application" | null;
  warning: string | null;
  repairActions: string[];
}

export async function diagnoseElectron(
  repositoryRoot: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ElectronDiagnostic> {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("electron/package.json");
  const packageDirectory = resolve(packageJsonPath, "..");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version: string };
  const pathFile = join(packageDirectory, "path.txt");
  let pathFileValue: string | null = null;
  try {
    pathFileValue = (await readFile(pathFile, "utf8")).trim();
  } catch {
    // Reported below.
  }
  const rawExecutable = pathFileValue
    ? join(packageDirectory, "dist", pathFileValue)
    : join(packageDirectory, "dist", process.platform === "win32" ? "electron.exe" : "electron");
  const rawDetails = await fileDetails(rawExecutable);
  const expectedRaw = join(
    packageDirectory,
    "dist",
    process.platform === "win32" ? "electron.exe" : "electron"
  );
  const pathFileValid =
    Boolean(pathFileValue) &&
    isAbsolute(rawExecutable) &&
    resolve(rawExecutable).toLowerCase() === resolve(expectedRaw).toLowerCase();
  let rawVersion: string | null = null;
  let rawError: string | null = null;
  let rawLaunchStatus: ElectronDiagnostic["rawLaunchStatus"] = rawDetails.exists
    ? "invalid"
    : "missing";
  if (rawDetails.exists && pathFileValid) {
    const cleanEnvironment = electronEnvironment(env);
    const result = await runCommandResolution(
      { resolvedPath: rawExecutable, invocationKind: "exe" },
      ["--version"],
      {
        cwd: repositoryRoot,
        env: cleanEnvironment,
        timeoutMs: 10_000,
        maxOutputBytes: 64_000
      }
    );
    rawVersion = `${result.stdout}\n${result.stderr}`.trim() || null;
    rawError = result.spawnError;
    rawLaunchStatus =
      result.exitCode === 0 && rawVersion?.includes(packageJson.version)
        ? "available"
        : result.spawnError
          ? "blocked_or_not_executable"
          : "invalid";
  }
  const packagedExecutable = join(
    repositoryRoot,
    "artifacts",
    "desktop",
    "Personal Codex Agent-win32-x64",
    "Personal Codex Agent.exe"
  );
  const packagedDetails = await fileDetails(packagedExecutable);
  let packagedVersion: string | null = null;
  let packagedError: string | null = null;
  let packagedLaunchStatus: ElectronDiagnostic["packagedLaunchStatus"] = packagedDetails.exists
    ? "invalid"
    : "missing";
  if (packagedDetails.exists) {
    const probeEnvironment = electronEnvironment(env);
    probeEnvironment.ELECTRON_RUN_AS_NODE = "1";
    const result = await runCommandResolution(
      { resolvedPath: packagedExecutable, invocationKind: "exe" },
      ["--version"],
      {
        cwd: repositoryRoot,
        env: probeEnvironment,
        timeoutMs: 10_000,
        maxOutputBytes: 64_000
      }
    );
    packagedVersion = `${result.stdout}\n${result.stderr}`.trim() || null;
    packagedError = result.spawnError;
    packagedLaunchStatus =
      result.exitCode === 0 && packagedVersion
        ? "available"
        : result.spawnError
          ? "blocked_or_not_executable"
          : "invalid";
  }
  const selectedExecutable =
    rawLaunchStatus === "available"
      ? rawExecutable
      : packagedLaunchStatus === "available"
        ? packagedExecutable
        : null;
  const selectedKind =
    rawLaunchStatus === "available"
      ? "raw-electron"
      : packagedLaunchStatus === "available"
        ? "packaged-application"
        : null;
  const repairActions: string[] = [];
  if (!rawDetails.exists || !pathFileValid) repairActions.push("npm run electron:install");
  if (rawLaunchStatus === "blocked_or_not_executable") {
    repairActions.push(
      `Ask your Windows administrator or Windows Security to allow: ${rawExecutable}`
    );
    repairActions.push("npm run package");
  }
  if (packagedLaunchStatus === "blocked_or_not_executable") {
    repairActions.push(
      `Ask your Windows administrator to allow the packaged application under the active Code Integrity policy: ${packagedExecutable}`
    );
  }
  return {
    packageVersion: packageJson.version,
    rawExecutable,
    rawExists: rawDetails.exists,
    rawSize: rawDetails.size,
    pathFile,
    pathFileValue,
    pathFileValid,
    rawVersion,
    rawLaunchStatus,
    rawError,
    packagedExecutable,
    packagedExists: packagedDetails.exists,
    packagedSize: packagedDetails.size,
    packagedVersion,
    packagedLaunchStatus,
    packagedError,
    selectedExecutable,
    selectedKind,
    warning:
      rawLaunchStatus === "available"
        ? null
        : packagedLaunchStatus === "available"
          ? "The raw Electron development binary is unavailable; development will use the packaged application executable."
          : "Windows could not execute either Electron application binary.",
    repairActions
  };
}

export function electronEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  delete clean.ELECTRON_RUN_AS_NODE;
  delete clean.ELECTRON_OVERRIDE_DIST_PATH;
  clean.PERSONAL_CODEX_AGENT_DEV = "1";
  return clean;
}

async function fileDetails(path: string): Promise<{ exists: boolean; size: number | null }> {
  try {
    const details = await stat(path);
    return { exists: details.isFile(), size: details.isFile() ? details.size : null };
  } catch {
    return { exists: false, size: null };
  }
}
