import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import YAML from "yaml";
import {
  ProjectConfigSchema,
  type ProjectConfig,
  type WorkspaceAnalysis,
  type WorkspaceSnapshot
} from "@agent/shared";
import { ProcessRunner } from "./process-runner.js";
import { validateWorkspacePath } from "./security.js";

const ignored = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".venv",
  "vendor"
]);

export class WorkspaceInspector {
  constructor(private readonly runner = new ProcessRunner()) {}

  async inspect(path: string, trusted = true): Promise<WorkspaceAnalysis> {
    const root = await validateWorkspacePath(path);
    const files = await listFiles(root, 4, 2_000);
    const isGit = files.includes(".git") || (await this.isGit(root));
    const git = isGit
      ? {
          isRepository: true,
          branch: await this.gitValue(root, ["branch", "--show-current"]),
          defaultBranch: await this.defaultBranch(root),
          remote: await this.gitValue(root, ["remote", "get-url", "origin"]),
          commit: await this.gitValue(root, ["rev-parse", "HEAD"]),
          dirty: Boolean(await this.gitValue(root, ["status", "--porcelain"]))
        }
      : {
          isRepository: false,
          branch: null,
          defaultBranch: null,
          remote: null,
          commit: null,
          dirty: false
        };
    const technologies = detectTechnologies(files);
    const packageManager = files.includes("pnpm-lock.yaml")
      ? "pnpm"
      : files.includes("yarn.lock")
        ? "yarn"
        : files.includes("package-lock.json")
          ? "npm"
          : files.includes("uv.lock")
            ? "uv"
            : files.includes("poetry.lock")
              ? "poetry"
              : null;
    const config = await this.loadConfig(root);
    return {
      snapshot: {
        path: root,
        name: basename(root),
        trusted,
        activeFile: null,
        source: "manual"
      },
      git,
      technologies,
      packageManager,
      testCommands: await detectTestCommands(root, files),
      configStatus: config ? "configured" : "not_configured",
      files
    };
  }

  async loadConfig(root: string): Promise<ProjectConfig | null> {
    try {
      const content = await readFile(join(root, ".agent", "project.yml"), "utf8");
      return ProjectConfigSchema.parse(YAML.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async isGit(root: string): Promise<boolean> {
    const result = await this.runner.run({
      executable: "git",
      args: ["rev-parse", "--is-inside-work-tree"],
      cwd: root,
      timeoutMs: 5_000
    });
    return result.exitCode === 0 && result.stdout.trim() === "true";
  }

  private async gitValue(root: string, args: string[]): Promise<string | null> {
    const result = await this.runner.run({
      executable: "git",
      args,
      cwd: root,
      timeoutMs: 5_000
    });
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  }

  private async defaultBranch(root: string): Promise<string | null> {
    const symbolic = await this.gitValue(root, [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD"
    ]);
    return symbolic?.replace(/^origin\//, "") ?? null;
  }
}

async function listFiles(root: string, maxDepth: number, maxFiles: number): Promise<string[]> {
  const output: string[] = [];
  async function walk(directory: string, prefix: string, depth: number): Promise<void> {
    if (depth > maxDepth || output.length >= maxFiles) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (output.length >= maxFiles || ignored.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      output.push(rel);
      if (entry.isDirectory()) await walk(join(directory, entry.name), rel, depth + 1);
    }
  }
  await walk(root, "", 0);
  return output;
}

function detectTechnologies(files: string[]): string[] {
  const found = new Set<string>();
  if (files.some((file) => file.endsWith(".ts") || file.endsWith(".tsx"))) found.add("TypeScript");
  if (files.some((file) => file.endsWith(".js") || file.endsWith(".jsx"))) found.add("JavaScript");
  if (files.some((file) => file.endsWith(".py"))) found.add("Python");
  if (files.some((file) => file.endsWith(".rs"))) found.add("Rust");
  if (files.some((file) => file.endsWith(".go"))) found.add("Go");
  if (files.includes("package.json")) found.add("Node.js");
  if (files.some((file) => /(?:^|\/)vite\.config\./.test(file))) found.add("Vite");
  if (files.some((file) => file.endsWith(".tsx"))) found.add("React");
  if (files.includes("pyproject.toml")) found.add("Python project");
  return [...found];
}

async function detectTestCommands(root: string, files: string[]): Promise<string[]> {
  const commands: string[] = [];
  if (files.includes("package.json")) {
    try {
      const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      for (const name of ["test", "lint", "typecheck", "build"]) {
        if (pkg.scripts?.[name]) commands.push(`npm run ${name}`);
      }
    } catch {
      // A malformed package file contributes no detected npm commands.
    }
  }
  if (files.includes("pyproject.toml") || files.includes("pytest.ini")) commands.push("pytest");
  if (files.includes("Cargo.toml")) commands.push("cargo test");
  if (files.includes("go.mod")) commands.push("go test ./...");
  return commands;
}

export function selectActiveWorkspace(
  folders: WorkspaceSnapshot[],
  activeFile: string | null
): WorkspaceSnapshot | null {
  if (folders.length === 0) return null;
  if (activeFile) {
    const normalized = activeFile.toLowerCase();
    const candidates = folders
      .filter((folder) => normalized.startsWith(folder.path.toLowerCase()))
      .sort((a, b) => b.path.length - a.path.length);
    if (candidates[0]) return { ...candidates[0], activeFile };
  }
  return folders[0] ?? null;
}
