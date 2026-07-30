import { runDoctor } from "../../scripts/doctor-lib.js";
import type { ElectronDiagnostic } from "../../scripts/electron-runtime.js";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;

windowsOnly("Windows doctor", () => {
  it("truthfully detects npm and VS Code while keeping GitHub optional", async () => {
    const electron: ElectronDiagnostic = {
      packageVersion: "43.2.0",
      rawExecutable: "electron.exe",
      rawExists: true,
      rawSize: 2_000_000,
      pathFile: "path.txt",
      pathFileValue: "electron.exe",
      pathFileValid: true,
      rawVersion: "v43.2.0",
      rawLaunchStatus: "available",
      rawError: null,
      packagedExecutable: "Personal Codex Agent.exe",
      packagedExists: true,
      packagedSize: 2_000_000,
      packagedVersion: "v24.8.0",
      packagedLaunchStatus: "available",
      packagedError: null,
      selectedExecutable: "electron.exe",
      selectedKind: "raw-electron",
      warning: null,
      repairActions: []
    };
    const report = await runDoctor(process.cwd(), process.env, { electron });
    const byId = new Map(report.checks.map((check) => [check.id, check]));
    expect(byId.get("npm")).toMatchObject({ level: "PASS", blocking: false });
    expect(byId.get("npm")?.resolvedPath?.toLowerCase()).toMatch(/npm\.(cmd|exe)$/);
    expect(byId.get("vscode")?.resolvedPath?.toLowerCase()).toMatch(/(code\.cmd|code\.exe)$/);
    expect(byId.get("github")?.requirement).toBe("optional");
    expect(report.summary.blockingFailures).toBe(0);
    const serialized = JSON.stringify(report);
    expect(JSON.parse(serialized)).toMatchObject({ repositoryRoot: process.cwd() });
    expect(serialized).not.toContain(process.env.GITHUB_TOKEN ?? "__no_token__");
  }, 30_000);
});
