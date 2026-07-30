import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitAdapter, WorkspaceInspector, selectActiveWorkspace } from "@agent/core";
import { temporaryProject } from "../helpers.js";

describe("workspace and Git integration", () => {
  it("detects technologies, commands, dirty state, and paths containing spaces", async () => {
    const root = await temporaryProject({ git: true, space: true });
    const inspector = new WorkspaceInspector();
    const clean = await inspector.inspect(root);
    expect(clean.git.isRepository).toBe(true);
    expect(clean.git.dirty).toBe(false);
    expect(clean.technologies).toContain("TypeScript");
    expect(clean.testCommands).toContain("npm run test");
    await writeFile(join(root, "src", "index.ts"), "export const value = 2;\n");
    expect((await inspector.inspect(root)).git.dirty).toBe(true);
  });

  it("creates an isolated branch/worktree and detects changed files", async () => {
    const root = await temporaryProject({ git: true });
    const git = new GitAdapter();
    const worktree = await git.createWorktree(root, "12345678-test", "Add example");
    await writeFile(join(worktree.path, "change.txt"), "evidence\n");
    expect(await git.changedFiles(worktree.path)).toContain("change.txt");
    const commit = await git.commit(worktree.path, "test: evidence");
    expect(commit).toMatch(/^[a-f0-9]{40}$/);
  });

  it("selects the deepest multi-root folder containing the active file", () => {
    const selected = selectActiveWorkspace(
      [
        { path: "C:\\repo", name: "repo", trusted: true, activeFile: null, source: "vscode" },
        { path: "C:\\repo\\app", name: "app", trusted: true, activeFile: null, source: "vscode" }
      ],
      "C:\\repo\\app\\src\\index.ts"
    );
    expect(selected?.name).toBe("app");
    expect(selectActiveWorkspace([], null)).toBeNull();
  });
});
