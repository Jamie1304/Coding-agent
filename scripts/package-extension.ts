import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
await mkdir(join(root, "artifacts"), { recursive: true });
const cli = join(root, "node_modules", "@vscode", "vsce", "vsce");
const output = join(root, "artifacts", "personal-codex-agent-vscode-0.2.0.vsix");
await new Promise<void>((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [cli, "package", "--out", output, "--no-dependencies", "--allow-missing-repository"],
    {
      cwd: join(root, "apps", "vscode-extension"),
      stdio: "inherit",
      windowsHide: true
    }
  );
  child.once("error", reject);
  child.once("close", (code) =>
    code === 0 ? resolve() : reject(new Error(`VSIX packaging failed with exit code ${code}`))
  );
});
