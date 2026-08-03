import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveCommand } from "@agent/shared";
import { PRODUCT_VERSION } from "./product.js";

export type SetupComponentId =
  "git" | "codex" | "vscode" | "vscode-extension" | "github" | "ollama";

export interface SetupComponent {
  id: SetupComponentId;
  name: string;
  requiredFor: string;
  status: "available" | "missing" | "failed" | "not_checked";
  version: string | null;
  detail: string;
  lastCheckedAt: string | null;
  lastActionAt: string | null;
}

export interface SetupState {
  schemaVersion: 1;
  productVersion: string;
  updatedAt: string;
  components: SetupComponent[];
}

interface ToolSpec {
  id: Exclude<SetupComponentId, "vscode-extension">;
  command: string;
  wingetId: string;
  requiredFor: string;
}

const tools: ToolSpec[] = [
  {
    id: "git",
    command: "git",
    wingetId: "Git.Git",
    requiredFor: "Repository lifecycle operations"
  },
  {
    id: "codex",
    command: "codex",
    wingetId: "OpenAI.Codex",
    requiredFor: "Codex-backed implementation"
  },
  {
    id: "vscode",
    command: "code",
    wingetId: "Microsoft.VisualStudioCode",
    requiredFor: "Optional workspace bridge"
  },
  { id: "github", command: "gh", wingetId: "GitHub.cli", requiredFor: "Optional GitHub lifecycle" },
  {
    id: "ollama",
    command: "ollama",
    wingetId: "Ollama.Ollama",
    requiredFor: "Optional local models"
  }
];

export class SetupManager {
  constructor(
    private readonly dataDirectory: string,
    private readonly extensionPath: string,
    private readonly execute = runCommand
  ) {}

  async status(): Promise<SetupState> {
    const prior = await this.readState();
    const components = await Promise.all([
      ...tools.map((tool) => this.checkTool(tool, prior)),
      this.checkExtension(prior)
    ]);
    const state: SetupState = {
      schemaVersion: 1,
      productVersion: PRODUCT_VERSION,
      updatedAt: new Date().toISOString(),
      components
    };
    await this.writeState(state);
    return state;
  }

  async install(id: SetupComponentId, consent: boolean): Promise<SetupState> {
    if (!consent) throw new Error("Installation requires explicit consent.");
    if (id === "vscode-extension") {
      const code = await resolveCommand("code", { configurationPath: "code" });
      if (!code.resolvedPath) throw new Error("Install VS Code before installing its extension.");
      await this.execute(code.resolvedPath, ["--install-extension", this.extensionPath], 120_000);
      return this.status();
    }
    const tool = tools.find((candidate) => candidate.id === id);
    if (!tool) throw new Error("Unknown setup component.");
    await this.execute(
      "winget",
      [
        "install",
        "--exact",
        "--id",
        tool.wingetId,
        "--accept-source-agreements",
        "--accept-package-agreements"
      ],
      300_000
    );
    return this.status();
  }

  async repair(): Promise<SetupState> {
    return this.status();
  }

  private async checkTool(tool: ToolSpec, prior: SetupState | null): Promise<SetupComponent> {
    const resolution = await resolveCommand(tool.command, { configurationPath: tool.command });
    const available =
      resolution.status === "available" || resolution.status === "installed_not_on_path";
    const priorComponent = prior?.components.find((component) => component.id === tool.id);
    return {
      id: tool.id,
      name: tool.id === "codex" ? "Codex CLI" : title(tool.id),
      requiredFor: tool.requiredFor,
      status: available ? "available" : "missing",
      version: resolution.version,
      detail: available
        ? `${resolution.version ?? "version unknown"} at ${resolution.resolvedPath ?? "unknown path"}`
        : (resolution.error ?? "Not found"),
      lastCheckedAt: new Date().toISOString(),
      lastActionAt: priorComponent?.lastActionAt ?? null
    };
  }

  private async checkExtension(prior: SetupState | null): Promise<SetupComponent> {
    const code = await resolveCommand("code", { configurationPath: "code" });
    const priorComponent = prior?.components.find(
      (component) => component.id === "vscode-extension"
    );
    return {
      id: "vscode-extension",
      name: "Personal Codex VS Code extension",
      requiredFor: "Optional workspace bridge",
      status: code.resolvedPath ? "missing" : "not_checked",
      version: null,
      detail: code.resolvedPath
        ? "Install from the bundled VSIX after confirming the optional integration."
        : "Install VS Code first.",
      lastCheckedAt: new Date().toISOString(),
      lastActionAt: priorComponent?.lastActionAt ?? null
    };
  }

  private statePath(): string {
    return join(this.dataDirectory, "setup-state.v1.json");
  }

  private async readState(): Promise<SetupState | null> {
    try {
      const state = JSON.parse(await readFile(this.statePath(), "utf8")) as {
        schemaVersion?: unknown;
      };
      if (state.schemaVersion === 1) return state as SetupState;
      await rename(this.statePath(), `${this.statePath()}.unsupported-${Date.now()}.bak`);
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeState(state: SetupState): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    const temporary = `${this.statePath()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.statePath());
  }
}

function title(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function runCommand(executable: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      shell: false,
      windowsHide: false,
      stdio: "ignore"
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${executable} timed out after ${String(timeoutMs)}ms.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${executable} exited with code ${String(code)}.`));
    });
  });
}
