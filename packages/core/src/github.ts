import { ProcessRunner } from "./process-runner.js";

export interface PullRequestInput {
  repository: string;
  title: string;
  body: string;
  branch: string;
  base: string;
}

export interface GitHubAdapter {
  checkAuthentication(): Promise<{ authenticated: boolean; message: string }>;
  createIssue(repository: string, title: string, body: string): Promise<number>;
  createPullRequest(input: PullRequestInput): Promise<{ number: number; url: string }>;
  waitForCi(repository: string, commit: string): Promise<"success" | "failure">;
  merge(
    repository: string,
    pullRequest: number,
    method: "merge" | "squash" | "rebase"
  ): Promise<string>;
}

export class GhCliAdapter implements GitHubAdapter {
  constructor(private readonly runner = new ProcessRunner()) {}

  async checkAuthentication(): Promise<{ authenticated: boolean; message: string }> {
    try {
      const result = await this.runner.run({
        executable: "gh",
        args: ["auth", "status"],
        cwd: process.cwd(),
        timeoutMs: 10_000
      });
      return {
        authenticated: result.exitCode === 0,
        message: (result.stdout || result.stderr).trim()
      };
    } catch (error) {
      return { authenticated: false, message: (error as Error).message };
    }
  }

  async createIssue(repository: string, title: string, body: string): Promise<number> {
    const output = await this.run(repository, [
      "issue",
      "create",
      "--title",
      title,
      "--body",
      body
    ]);
    return parseNumberFromUrl(output);
  }

  async createPullRequest(input: PullRequestInput): Promise<{ number: number; url: string }> {
    const url = await this.run(input.repository, [
      "pr",
      "create",
      "--title",
      input.title,
      "--body",
      input.body,
      "--head",
      input.branch,
      "--base",
      input.base
    ]);
    return { number: parseNumberFromUrl(url), url };
  }

  async waitForCi(repository: string, commit: string): Promise<"success" | "failure"> {
    const result = await this.runner.run({
      executable: "gh",
      args: ["run", "watch", "--exit-status", "--commit", commit],
      cwd: repository,
      timeoutMs: 30 * 60_000
    });
    return result.exitCode === 0 ? "success" : "failure";
  }

  async merge(
    repository: string,
    pullRequest: number,
    method: "merge" | "squash" | "rebase"
  ): Promise<string> {
    await this.run(repository, ["pr", "merge", String(pullRequest), `--${method}`]);
    return this.run(repository, [
      "pr",
      "view",
      String(pullRequest),
      "--json",
      "mergeCommit",
      "--jq",
      ".mergeCommit.oid"
    ]);
  }

  private async run(cwd: string, args: string[]): Promise<string> {
    const result = await this.runner.run({ executable: "gh", args, cwd });
    if (result.exitCode !== 0) {
      throw new Error(
        `gh ${args[0]} failed (${result.exitCode}): ${result.stderr || result.stdout}`
      );
    }
    return result.stdout.trim();
  }
}

export class FakeGitHubAdapter implements GitHubAdapter {
  issue = 100;
  pullRequest = 200;
  ci: "success" | "failure" = "success";

  async checkAuthentication(): Promise<{ authenticated: boolean; message: string }> {
    return { authenticated: true, message: "fake authenticated" };
  }
  async createIssue(_repository: string, _title: string, _body: string): Promise<number> {
    return this.issue;
  }
  async createPullRequest(_input: PullRequestInput): Promise<{ number: number; url: string }> {
    return { number: this.pullRequest, url: `https://example.test/pull/${this.pullRequest}` };
  }
  async waitForCi(_repository: string, _commit: string): Promise<"success" | "failure"> {
    return this.ci;
  }
  async merge(
    _repository: string,
    _pullRequest: number,
    _method: "merge" | "squash" | "rebase"
  ): Promise<string> {
    return "fake-merge-commit";
  }
}

function parseNumberFromUrl(value: string): number {
  const match = /\/(\d+)\/?$/.exec(value.trim());
  if (!match?.[1]) throw new Error(`Could not parse GitHub number from: ${value}`);
  return Number(match[1]);
}
