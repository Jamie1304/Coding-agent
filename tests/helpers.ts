import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRunner } from "@agent/core";

export async function temporaryProject(
  options: { git?: boolean; space?: boolean } = {}
): Promise<string> {
  const parent = await mkdtemp(
    join(tmpdir(), options.space ? "agent fixture space " : "agent-fixture-")
  );
  await writeFile(
    join(parent, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: {
        test: 'node -e "process.exit(0)"',
        lint: 'node -e "process.exit(0)"'
      }
    }),
    "utf8"
  );
  await mkdir(join(parent, "src"));
  await writeFile(join(parent, "src", "index.ts"), "export const value = 1;\n", "utf8");
  if (options.git) {
    const runner = new ProcessRunner();
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.email", "fixture@example.test"],
      ["config", "user.name", "Fixture User"],
      ["add", "."],
      ["commit", "-m", "initial"]
    ]) {
      const result = await runner.run({ executable: "git", args, cwd: parent });
      if (result.exitCode !== 0) throw new Error(result.stderr);
    }
  }
  return parent;
}
