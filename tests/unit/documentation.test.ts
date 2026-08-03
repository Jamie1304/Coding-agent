import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

describe("runnable documentation", () => {
  it("contains no unmarked legacy path and references real scripts and artifacts", async () => {
    const files = ["README.md", "docs/user-setup-guide.md", "docs/troubleshooting.md"];
    const text = (
      await Promise.all(files.map((file) => readFile(join(process.cwd(), file), "utf8")))
    ).join("\n");
    expect(text).not.toContain(String.raw`C:\path\to\personal-codex-agent`);
    expect(text).toContain(String.raw`C:\Users\Jamie Kanbier\Documents\Coding agent`);
    for (const script of ["bootstrap.ps1", "doctor.ps1", "dev.ps1"]) {
      await expect(access(join(process.cwd(), "scripts", script))).resolves.toBeUndefined();
    }
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const name of ["dev", "doctor", "package", "package:extension"]) {
      expect(packageJson.scripts[name]).toBeTruthy();
    }
    expect(text).toContain("Personal-Codex-Agent-Setup-0.3.0-x64.exe");
  });

  it("excludes mutable agent runtime state from formatting checks", async () => {
    const ignored = await readFile(join(process.cwd(), ".prettierignore"), "utf8");
    expect(ignored).toContain(".agent/");
    expect(ignored).toContain(".agent-runs/");
    const attributes = await readFile(join(process.cwd(), ".gitattributes"), "utf8");
    expect(attributes).toContain("* text=auto eol=lf");
  });
});
