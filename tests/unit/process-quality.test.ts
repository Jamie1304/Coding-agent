import { ProcessRunner, QualityGateRunner, splitCommand } from "@agent/core";

describe("process and quality gates", () => {
  it("uses argument arrays and captures real exit codes and output", async () => {
    const result = await new ProcessRunner().run({
      executable: process.execPath,
      args: ["-e", "console.log('ok')"],
      cwd: process.cwd()
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });

  it("captures failures and timeouts", async () => {
    const failed = await new ProcessRunner().run({
      executable: process.execPath,
      args: ["-e", "process.exit(7)"],
      cwd: process.cwd()
    });
    expect(failed.exitCode).toBe(7);
    const timed = await new ProcessRunner().run({
      executable: process.execPath,
      args: ["-e", "setTimeout(()=>{}, 5000)"],
      cwd: process.cwd(),
      timeoutMs: 50
    });
    expect(timed.timedOut).toBe(true);
  });

  it("parses quoted configured commands without invoking a shell", async () => {
    expect(splitCommand('node -e "console.log(1)"')).toEqual(["node", "-e", "console.log(1)"]);
    const results = await new QualityGateRunner().run(process.cwd(), [
      `"${process.execPath}" -e "process.exit(0)"`
    ]);
    expect(results[0]!.passed).toBe(true);
  });
});
