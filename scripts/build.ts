import { spawn } from "node:child_process";

for (const script of ["build:daemon", "build:desktop", "build:extension"]) {
  await runNpm(script);
}

function runNpm(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const npmCli = process.env.npm_execpath;
    const executable = npmCli ? process.execPath : "npm";
    const args = npmCli ? [npmCli, "run", script] : ["run", script];
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: false,
      windowsHide: true
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} failed with exit code ${code}`))
    );
  });
}
