import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PuterCodexProvider, type CodexEvent } from "@agent/codex-provider";

describe("PuterCodexProvider", () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(
      workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
  });

  it("writes an approved change through Puter tool calls and completes the turn", async () => {
    const workspace = await createWorkspace();
    const chat = vi
      .fn()
      .mockResolvedValueOnce(
        toolResponse("write-1", "write_file", {
          path: "src/hello.ts",
          content: 'export const hello = "puter";\n'
        })
      )
      .mockResolvedValueOnce(
        toolResponse("done-1", "complete_task", {
          summary: "Added the Puter-backed implementation file."
        })
      );
    const provider = createProvider(chat);
    const thread = await provider.createThread({ cwd: workspace });
    const events = await collect(
      provider.sendTurn({
        threadId: thread.id,
        prompt: "Add the implementation",
        cwd: workspace,
        sandbox: "workspace-write",
        approvalPolicy: "on-request"
      })
    );

    expect(await readFile(join(workspace, "src/hello.ts"), "utf8")).toBe(
      'export const hello = "puter";\n'
    );
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["turn-started", "file-change", "message", "turn-completed"])
    );
    expect(events.at(-1)).toMatchObject({ type: "turn-completed", status: "completed" });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("returns path traversal failures to the model without writing outside the workspace", async () => {
    const workspace = await createWorkspace();
    const snapshots: unknown[] = [];
    const chat = vi.fn(async (messages: unknown[]) => {
      snapshots.push(structuredClone(messages));
      if (snapshots.length === 1) {
        return toolResponse("escape-1", "write_file", {
          path: "../escaped.txt",
          content: "nope"
        });
      }
      return toolResponse("done-2", "complete_task", {
        summary: "No unsafe write was performed."
      });
    });
    const provider = createProvider(chat);
    const thread = await provider.createThread({ cwd: workspace });

    await collect(
      provider.sendTurn({
        threadId: thread.id,
        prompt: "Try an unsafe path",
        cwd: workspace,
        sandbox: "workspace-write",
        approvalPolicy: "on-request"
      })
    );

    expect(JSON.stringify(snapshots[1])).toContain("Path escapes the isolated workspace");
    await expect(readFile(join(workspace, "..", "escaped.txt"), "utf8")).rejects.toThrow();
  });

  it("keeps secret-bearing files out of model tool results", async () => {
    const workspace = await createWorkspace();
    await writeFile(join(workspace, ".env"), "API_KEY=do-not-expose\n");
    const snapshots: unknown[] = [];
    const chat = vi.fn(async (messages: unknown[]) => {
      snapshots.push(structuredClone(messages));
      if (snapshots.length === 1) {
        return toolResponse("secret-1", "read_file", { path: ".env" });
      }
      return toolResponse("done-secret", "complete_task", {
        summary: "The protected secret file was not read."
      });
    });
    const provider = createProvider(chat);
    const thread = await provider.createThread({ cwd: workspace });

    await collect(
      provider.sendTurn({
        threadId: thread.id,
        prompt: "Read the environment file",
        cwd: workspace,
        sandbox: "read-only",
        approvalPolicy: "never"
      })
    );

    expect(JSON.stringify(snapshots[1])).toContain(
      "Secret-bearing files are not available to the Puter agent"
    );
    expect(JSON.stringify(snapshots[1])).not.toContain("do-not-expose");
  });

  it("exposes only read tools in read-only turns", async () => {
    const workspace = await createWorkspace();
    let toolNames: string[] = [];
    const chat = vi.fn(async (_messages: unknown[], options: Record<string, unknown>) => {
      toolNames = (options.tools as Array<{ function: { name: string } }>).map(
        (tool) => tool.function.name
      );
      return { message: { role: "assistant", content: "Inspection complete." } };
    });
    const provider = createProvider(chat);
    const thread = await provider.createThread({ cwd: workspace });

    await collect(
      provider.sendTurn({
        threadId: thread.id,
        prompt: "Inspect only",
        cwd: workspace,
        sandbox: "read-only",
        approvalPolicy: "never"
      })
    );

    expect(toolNames).toContain("read_file");
    expect(toolNames).not.toContain("write_file");
    expect(toolNames).not.toContain("run_command");
  });

  it("blocks destructive Git subcommands", async () => {
    const workspace = await createWorkspace();
    const snapshots: unknown[] = [];
    const chat = vi.fn(async (messages: unknown[]) => {
      snapshots.push(structuredClone(messages));
      if (snapshots.length === 1) {
        return toolResponse("git-1", "run_command", {
          command: "git",
          args: ["reset", "--hard"]
        });
      }
      return toolResponse("done-3", "complete_task", {
        summary: "Rejected the destructive command."
      });
    });
    const provider = createProvider(chat);
    const thread = await provider.createThread({ cwd: workspace });
    const events = await collect(
      provider.sendTurn({
        threadId: thread.id,
        prompt: "Reset the repository",
        cwd: workspace,
        sandbox: "workspace-write",
        approvalPolicy: "on-request"
      })
    );

    expect(JSON.stringify(snapshots[1])).toContain("Git subcommand is read-only allowlist only");
    expect(events.some((event) => event.type === "command")).toBe(false);
  });

  async function createWorkspace(): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), "puter-provider-"));
    workspaces.push(workspace);
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "package.json"), '{"scripts":{"test":"node --test"}}\n');
    return workspace;
  }
});

function createProvider(chat: ReturnType<typeof vi.fn>): PuterCodexProvider {
  return new PuterCodexProvider({
    authToken: "test-token",
    sdkLoader: async () =>
      ({
        init: (_token: string) => ({
          ai: {
            chat: chat as unknown as (
              messages: unknown[],
              options: Record<string, unknown>
            ) => Promise<unknown>
          },
          auth: { getUser: async () => ({ username: "tester" }) }
        })
      }) as unknown as any,
    tokenStore: {
      get: async () => null,
      set: async () => undefined
    },
    maxAgentSteps: 5
  });
}

function toolResponse(id: string, name: string, args: Record<string, unknown>): unknown {
  return {
    message: {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) }
        }
      ]
    }
  };
}

async function collect(iterable: AsyncIterable<CodexEvent>): Promise<CodexEvent[]> {
  const events: CodexEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
