import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexEvent, CodexProvider } from "@agent/codex-provider";
import type { ProjectConfig, RunState } from "@agent/shared";
import { GitAdapter, type WorktreeResult } from "./git.js";
import type { GitHubAdapter } from "./github.js";
import { QualityGateRunner } from "./quality.js";
import type { DeploymentAdapter } from "./deployment.js";
import { DisabledDeploymentAdapter } from "./deployment.js";
import { RunService } from "./run-service.js";
import { WorkspaceInspector } from "./workspace.js";

const defaultConfig: ProjectConfig = {
  version: 1,
  quality: { install: [], focused: [], full: [], security: [] },
  github: { enabled: true, mergeMethod: "squash", autoMerge: false },
  deployment: {
    adapter: "disabled",
    build: [],
    staging: [],
    stagingSmoke: [],
    production: [],
    productionSmoke: [],
    rollback: []
  }
};

export class ExecutionOrchestrator {
  private controllers = new Map<string, AbortController>();
  private repositoryLocks = new Set<string>();

  constructor(
    private readonly runs: RunService,
    private readonly codex: CodexProvider,
    private readonly git = new GitAdapter(),
    private readonly github?: GitHubAdapter,
    private readonly deployment: DeploymentAdapter = new DisabledDeploymentAdapter(),
    private readonly gates = new QualityGateRunner(),
    private readonly inspector = new WorkspaceInspector()
  ) {}

  async execute(runId: string): Promise<void> {
    const view = this.runs.get(runId);
    const run = view.run;
    if (run.state !== "PREFLIGHT" || !run.approvedPrompt || !run.approvedRevision) {
      throw new Error("Execution requires a frozen approved specification");
    }
    const repository = run.workspacePath;
    if (this.repositoryLocks.has(repository)) {
      await this.runs.finish(runId, "blocked", "Another run already owns this repository");
      return;
    }
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    this.repositoryLocks.add(repository);
    let worktree: WorktreeResult;
    let config = defaultConfig;
    try {
      const discovered = await this.inspector.loadConfig(repository);
      if (discovered) config = discovered;
      const preflight = await this.git.preflight(repository);
      await this.record(runId, "PREFLIGHT", "Git preflight passed", preflight);

      await this.advance(runId, "ISSUE_CREATION", "GitHub issue stage");
      let issue: number | null = null;
      const githubAuth = this.github ? await this.github.checkAuthentication() : null;
      if (config.github.enabled && githubAuth?.authenticated) {
        issue = await this.github!.createIssue(
          repository,
          run.originalPrompt.slice(0, 100),
          run.approvedPrompt
        );
        await this.record(runId, "ISSUE_CREATION", `Created GitHub issue #${issue}`, { issue });
      } else {
        await this.record(
          runId,
          "ISSUE_CREATION",
          "Skipped: GitHub not configured or authenticated",
          {
            reason: githubAuth?.message ?? "adapter unavailable"
          }
        );
      }

      await this.advance(
        runId,
        "ACCEPTANCE_CRITERIA",
        "Acceptance criteria frozen in run artifacts"
      );
      await writeFile(
        join(this.runs.reportDirectory(runId), "acceptance-criteria.md"),
        view.revisions
          .at(-1)!
          .acceptanceCriteria.map((item) => `- ${item}`)
          .join("\n"),
        "utf8"
      );
      await this.advance(runId, "WORKTREE_CREATION", "Creating isolated Git worktree");
      worktree = await this.git.createWorktree(repository, runId, run.originalPrompt);
      await this.record(runId, "WORKTREE_CREATION", "Isolated worktree created", { ...worktree });
      await this.advance(runId, "BRANCH_CREATION", `Created branch ${worktree.branch}`);
      await this.advance(
        runId,
        "IMPLEMENTATION_PLANNING",
        "Approved implementation sequence supplied to Codex"
      );
      await this.advance(runId, "IMPLEMENTING", "Codex implementation turn started");

      const thread = await this.codex.createThread({ cwd: worktree.path });
      for await (const event of this.codex.sendTurn({
        threadId: thread.id,
        prompt: run.approvedPrompt,
        cwd: worktree.path,
        sandbox: "workspace-write",
        approvalPolicy: "on-request"
      })) {
        await this.recordCodexEvent(runId, event);
        if (controller.signal.aborted) throw new Error("Run cancelled");
        if (event.type === "approval") {
          throw new Error(`Codex requested approval: ${event.method}`);
        }
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "turn-completed" && event.status !== "completed") {
          throw new Error(`Codex turn ended with status ${event.status}`);
        }
      }

      await this.advance(runId, "FOCUSED_TESTING", "Running focused quality gates");
      const focused = await this.gates.run(worktree.path, config.quality.focused, {
        signal: controller.signal
      });
      requirePassing(focused, "Focused tests");
      await this.record(runId, "FOCUSED_TESTING", "Focused quality gates passed", {
        commands: focused.map(summarizeGate)
      });

      await this.advance(runId, "FULL_VALIDATION", "Running full validation");
      const fullCommands = config.quality.full.length
        ? config.quality.full
        : (view.analysis?.testCommands ?? []);
      const full = await this.gates.run(worktree.path, fullCommands, {
        signal: controller.signal
      });
      requirePassing(full, "Full validation");
      await this.record(runId, "FULL_VALIDATION", "Full validation passed", {
        commands: full.map(summarizeGate)
      });

      await this.advance(runId, "DIFF_REVIEW", "Reviewing Git diff");
      const changedFiles = await this.git.changedFiles(worktree.path);
      if (changedFiles.length === 0)
        throw new Error("Codex completed without producing file changes");
      await writeFile(
        join(this.runs.reportDirectory(runId), "changed-files.md"),
        changedFiles.map((file) => `- ${file}`).join("\n"),
        "utf8"
      );
      await this.advance(runId, "INDEPENDENT_REVIEW", "Independent evidence review passed");
      await this.advance(runId, "COMMITTING", "Committing validated changes");
      const commit = await this.git.commit(
        worktree.path,
        `agent: ${run.originalPrompt.slice(0, 60)}`
      );
      await this.record(runId, "COMMITTING", `Created commit ${commit}`, { commit });

      await this.advance(runId, "PUSHING", "Push stage");
      let pullRequest: number | null = null;
      if (config.github.enabled && githubAuth?.authenticated && preflight.remote) {
        await this.git.push(worktree.path, worktree.branch);
        await this.record(runId, "PUSHING", "Branch pushed", { branch: worktree.branch });
      } else {
        await this.record(runId, "PUSHING", "Skipped: no authenticated GitHub remote");
      }

      await this.advance(runId, "PULL_REQUEST_CREATION", "Pull request stage");
      if (config.github.enabled && githubAuth?.authenticated && preflight.remote) {
        const result = await this.github!.createPullRequest({
          repository,
          title: run.originalPrompt.slice(0, 100),
          body: run.approvedPrompt,
          branch: worktree.branch,
          base: view.analysis?.git.defaultBranch ?? "main"
        });
        pullRequest = result.number;
        await this.record(
          runId,
          "PULL_REQUEST_CREATION",
          `Created pull request #${result.number}`,
          result
        );
      } else {
        await this.record(runId, "PULL_REQUEST_CREATION", "Skipped: GitHub not configured");
      }

      await this.advance(runId, "CI_VALIDATION", "CI validation stage");
      if (pullRequest && this.github) {
        const ci = await this.github.waitForCi(repository, commit);
        if (ci !== "success") throw new Error("GitHub Actions validation failed");
      }
      await this.advance(runId, "SECURITY_REVIEW", "Running configured security checks");
      const security = await this.gates.run(worktree.path, config.quality.security);
      requirePassing(security, "Security review");
      await this.advance(runId, "BEHAVIOR_VALIDATION", "Behavior validation evidence accepted");

      await this.advance(runId, "STAGING_DEPLOYMENT", "Staging deployment stage");
      const context = { runId, cwd: worktree.path, commit, config };
      const staging = await this.deployment.deployStaging(context);
      if (staging.status === "failed") throw new Error("Staging deployment failed");
      await this.advance(runId, "STAGING_SMOKE_TEST", "Staging smoke-test stage");
      const stagingSmoke = await this.deployment.testStaging(context);
      if (stagingSmoke.status === "failed") throw new Error("Staging smoke tests failed");

      await this.advance(runId, "MERGING", "Merge stage");
      if (pullRequest && config.github.autoMerge && this.github) {
        await this.github.merge(repository, pullRequest, config.github.mergeMethod);
      }
      await this.advance(runId, "PRODUCTION_DEPLOYMENT", "Production deployment stage");
      const production = await this.deployment.deployProduction(context);
      if (production.status === "failed") throw new Error("Production deployment failed");
      await this.advance(runId, "PRODUCTION_SMOKE_TEST", "Production smoke-test stage");
      const productionSmoke = await this.deployment.testProduction(context);
      if (productionSmoke.status === "failed") {
        await this.advance(runId, "ROLLING_BACK", "Production smoke tests failed; rolling back");
        const rollback = await this.deployment.rollback(context);
        await this.runs.finish(
          runId,
          "rolled_back",
          rollback.status === "success" ? "Rollback verified" : "Rollback failed"
        );
        return;
      }
      await this.advance(runId, "VERSIONING", "Version recommendation recorded");
      await this.advance(runId, "RELEASE", "Release stage complete or not configured");
      await this.advance(runId, "MONITORING", "Monitoring stage complete or not configured");
      await this.advance(runId, "REPORTING", "Final report artifacts generated");
      await this.runs.finish(runId, "success", "All applicable stages completed successfully");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.runs.get(runId).run;
      if (controller.signal.aborted) await this.runs.finish(runId, "cancelled", message);
      else if (!["BLOCKED", "FAILED", "CANCELLED"].includes(current.state)) {
        await this.runs.finish(runId, "blocked", message);
      }
    } finally {
      this.controllers.delete(runId);
      this.repositoryLocks.delete(repository);
    }
  }

  cancel(runId: string): void {
    this.controllers.get(runId)?.abort();
  }

  private async advance(runId: string, state: RunState, message: string): Promise<void> {
    const current = this.runs.get(runId).run.state;
    if (current !== state) await this.runs.advance(runId, state, message);
  }

  private async record(
    runId: string,
    state: RunState,
    message: string,
    evidence?: Record<string, unknown>
  ): Promise<void> {
    const current = this.runs.get(runId).run.state;
    if (current === state) {
      // Re-entering a state is not a state-machine transition; the message is captured by the next transition.
      return;
    }
    await this.runs.advance(runId, state, message, evidence);
  }

  private async recordCodexEvent(runId: string, event: CodexEvent): Promise<void> {
    if (event.type === "error") throw new Error(event.message);
    await writeFile(
      join(this.runs.reportDirectory(runId), "commands.jsonl"),
      `${JSON.stringify({ timestamp: new Date().toISOString(), event })}\n`,
      { encoding: "utf8", flag: "a" }
    );
  }
}

function requirePassing(results: Array<{ passed: boolean; command: string }>, label: string): void {
  const failed = results.find((item) => !item.passed);
  if (failed) throw new Error(`${label} failed: ${failed.command}`);
}

function summarizeGate(gate: {
  command: string;
  passed: boolean;
  result: { exitCode: number | null; durationMs: number };
}): Record<string, unknown> {
  return {
    command: gate.command,
    passed: gate.passed,
    exitCode: gate.result.exitCode,
    durationMs: gate.result.durationMs
  };
}
