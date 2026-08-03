import { diagnoseElectron, electronEnvironment } from "../../scripts/electron-runtime.js";

describe("Electron runtime diagnosis", () => {
  it("removes inherited Electron mode overrides", () => {
    const env = electronEnvironment({
      PATH: "safe",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_OVERRIDE_DIST_PATH: "bad"
    });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.ELECTRON_OVERRIDE_DIST_PATH).toBeUndefined();
    expect(env.PERSONAL_CODEX_AGENT_DEV).toBe("1");
  });

  it("validates the locked binary or reports its missing-install recovery", async () => {
    const diagnostic = await diagnoseElectron(process.cwd());
    expect(diagnostic.packageVersion).toBe("43.2.0");
    if (!diagnostic.pathFileValue) {
      expect(diagnostic.pathFileValid).toBe(false);
      expect(diagnostic.rawExists).toBe(false);
      expect(diagnostic.rawLaunchStatus).toBe("missing");
      expect(diagnostic.selectedExecutable).toBeNull();
      expect(diagnostic.repairActions).toContain("npm run electron:install");
      return;
    }
    expect(
      diagnostic.pathFileValid,
      JSON.stringify({
        platform: process.platform,
        pathFileValue: diagnostic.pathFileValue,
        pathFile: diagnostic.pathFile,
        rawExecutable: diagnostic.rawExecutable
      })
    ).toBe(true);
    expect(diagnostic.rawExists).toBe(true);
    expect(diagnostic.rawSize).toBeGreaterThan(1_000_000);
    if (diagnostic.selectedExecutable) {
      expect(diagnostic.selectedKind).toMatch(/raw-electron|packaged-application/);
    } else {
      expect(diagnostic.rawLaunchStatus).toBe("blocked_or_not_executable");
      expect(diagnostic.packagedLaunchStatus).toBe("blocked_or_not_executable");
    }
  }, 40_000);
});
