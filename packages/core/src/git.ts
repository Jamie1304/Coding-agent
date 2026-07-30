import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ProcessRunner, type CommandResult } from "./process-runner.js";
import { safeBranchFragment, validateWorkspacePath } from "./security.js";

export interface WorktreeResult {
  path: string;
  branch: string;
  baseCommit: string;
}

export class GitAdapter {
  constructor(private readonly runner = new ProcessRunner()) {}

  async preflight(
    repository: string
  ): Promise<{ commit: string; dirty: boolean; remote: string | null }> {
    const root = await validateWorkspacePath(repository);
    const commit = await this.require(root, ["rev-parse", "HEAD"]);
    const status = await this.require(root, ["status", "--porcelain"]);
    const remote = await this.optional(root, ["remote", "get-url", "origin"]);
    return { commit, dirty: Boolean(status), remote };
  }

  async createWorktree(
    repository: string,
    runId: string,
    summary: string,
    base = "HEAD"
  ): Promise<WorktreeResult> {
    const root = await validateWorkspacePath(repository);
    const baseCommit = await this.require(root, ["rev-parse", base]);
    const branch = `agent/${runId.slice(0, 8)}-${safeBranchFragment(summary)}`;
    const commonDir = await this.require(root, ["rev-parse", "--git-common-dir"]);
    const parent = join(
      dirname(commonDir.startsWith(".") ? join(root, commonDir) : commonDir),
      "agent-worktrees"
    );
    const path = join(parent, runId);
    await mkdir(parent, { recursive: true });
    const collision = await this.optional(root, ["show-ref", "--verify", `refs/heads/${branch}`]);
    if (collision !== null) throw new Error(`Branch already exists: ${branch}`);
    const result = await this.runner.run({
      executable: "git",
      args: ["worktree", "add", "-b", branch, path, baseCommit],
      cwd: root
    });
    if (result.exitCode !== 0) throw commandError(result);
    return { path, branch, baseCommit };
  }

  async diff(worktree: string): Promise<string> {
    return this.require(worktree, ["diff", "--stat", "HEAD"]);
  }

  async changedFiles(worktree: string): Promise<string[]> {
    const output = await this.require(worktree, ["status", "--porcelain"]);
    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3));
  }

  async commit(worktree: string, message: string): Promise<string> {
    await this.require(worktree, ["add", "--all"]);
    await this.require(worktree, ["commit", "-m", message]);
    return this.require(worktree, ["rev-parse", "HEAD"]);
  }

  async push(worktree: string, branch: string): Promise<void> {
    await this.require(worktree, ["push", "--set-upstream", "origin", branch]);
  }

  async cleanup(repository: string, worktree: string): Promise<void> {
    const result = await this.runner.run({
      executable: "git",
      args: ["worktree", "remove", worktree],
      cwd: repository
    });
    if (result.exitCode !== 0) throw commandError(result);
    await rm(worktree, { recursive: true, force: true });
  }

  private async require(cwd: string, args: string[]): Promise<string> {
    const result = await this.runner.run({ executable: "git", args, cwd });
    if (result.exitCode !== 0) throw commandError(result);
    return result.stdout.trim();
  }

  private async optional(cwd: string, args: string[]): Promise<string | null> {
    const result = await this.runner.run({ executable: "git", args, cwd });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }
}

function commandError(result: CommandResult): Error {
  return new Error(
    `git ${result.args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`
  );
}
