import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  commandInvocation,
  kindFor,
  resolveCommand,
  runCommandResolution,
  type CommandResolution
} from "@agent/shared";

describe("cross-platform command classification", () => {
  it("treats extensionless Unix commands as executables rather than Node scripts", () => {
    expect(kindFor("/usr/bin/git", "linux")).toBe("exe");
    expect(kindFor("/usr/local/bin/tool", "darwin")).toBe("exe");
    expect(kindFor("/tmp/worker.mjs", "linux")).toBe("script");
  });
});

const windowsOnly = process.platform === "win32" ? describe : describe.skip;

windowsOnly("Windows command resolver", () => {
  async function fixture(): Promise<string> {
    return mkdtemp(join(tmpdir(), "agent resolver space "));
  }

  it.each([
    ["cmd", ".cmd"],
    ["bat", ".bat"]
  ])("discovers and invokes a %s wrapper from a path containing spaces", async (_, extension) => {
    const directory = await fixture();
    const name = `agent-wrapper-${Date.now()}`;
    await writeFile(
      join(directory, `${name}${extension}`),
      '@echo off\r\nnode -e "console.log(process.argv[1])" %1\r\n',
      "utf8"
    );
    const env = {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      PATHEXT: `.EXE;.BAT;.CMD`
    };
    const resolution = await resolveCommand(name, {
      platform: "win32",
      env,
      versionArgs: null
    });
    expect(resolution.status).toBe("available");
    expect(resolution.invocationKind).toBe(extension.slice(1));
    expect(resolution.resolvedPath).toContain("resolver space");
    const result = await runCommandResolution(resolution, ["value with spaces"], {
      cwd: directory,
      env,
      timeoutMs: 5_000
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("value with spaces");
  });

  it("uses PATHEXT and distinguishes a known location from PATH", async () => {
    const directory = await fixture();
    const executable = join(directory, "known-tool.cmd");
    await writeFile(executable, "@echo off\r\necho v7.8.9\r\n", "utf8");
    const resolution = await resolveCommand("known-tool", {
      platform: "win32",
      env: { ...process.env, PATH: "", PATHEXT: ".CMD" },
      knownLocations: [executable]
    });
    expect(resolution).toMatchObject({
      status: "installed_not_on_path",
      discoveredBy: "known_location",
      invocationKind: "cmd",
      version: "v7.8.9"
    });
  });

  it("discovers npm-style wrappers through APPDATA", async () => {
    const directory = await fixture();
    const npmDirectory = join(directory, "npm");
    await mkdir(npmDirectory);
    await writeFile(join(npmDirectory, "global-tool.cmd"), "@echo off\r\necho 4.5.6\r\n", "utf8");
    const resolution = await resolveCommand("global-tool", {
      platform: "win32",
      env: { ...process.env, PATH: "", PATHEXT: ".CMD", APPDATA: directory }
    });
    expect(resolution.status).toBe("installed_not_on_path");
    expect(resolution.discoveredBy).toBe("npm_prefix");
  });

  it("discovers an exe and parses its version", async () => {
    const directory = await fixture();
    const executable = join(directory, "version-tool.exe");
    await copyFile(process.execPath, executable);
    const resolution = await resolveCommand("version-tool", {
      platform: "win32",
      env: {
        ...process.env,
        PATH: directory,
        PATHEXT: ".EXE"
      }
    });
    expect(resolution.resolvedPath?.toLowerCase()).toContain("version-tool.exe");
    expect(resolution.invocationKind).toBe("exe");
    expect(resolution.version).toMatch(/\d+\.\d+\.\d+/);
  });

  it("preserves non-zero exits, times out, and does not inject shell commands", async () => {
    const directory = await fixture();
    const wrapper = join(directory, "capture.cmd");
    const capture = join(directory, "capture.mjs");
    await writeFile(
      capture,
      "if (process.argv[2] === 'wait') setTimeout(() => {}, 30000); else { console.log(JSON.stringify(process.argv.slice(2))); process.exit(Number(process.argv[2]) || 0); }\n",
      "utf8"
    );
    await writeFile(wrapper, '@echo off\r\nnode "%~dp0capture.mjs" %*\r\n', "utf8");
    const resolution: Pick<CommandResolution, "resolvedPath" | "invocationKind"> = {
      resolvedPath: wrapper,
      invocationKind: "cmd"
    };
    const nonZero = await runCommandResolution(resolution, ["7"], {
      cwd: directory,
      env: process.env,
      timeoutMs: 5_000
    });
    expect(nonZero.exitCode).toBe(7);
    const unsafe = "safe & echo injected";
    const safe = await runCommandResolution(resolution, ["0", unsafe], {
      cwd: directory,
      env: process.env,
      timeoutMs: 5_000
    });
    expect(safe.exitCode).toBe(0);
    expect(JSON.parse(safe.stdout.trim())).toEqual(["0", unsafe]);
    expect(() => commandInvocation(resolution, ["%PATH%"], process.env)).toThrow(
      /cannot be passed/
    );
    const timed = await runCommandResolution(resolution, ["wait"], {
      cwd: directory,
      env: process.env,
      timeoutMs: 100
    });
    expect(timed.timedOut).toBe(true);
  });

  it("reports missing and unsupported commands without inventing success", async () => {
    const missing = await resolveCommand(`missing-${Date.now()}`, {
      platform: "win32",
      env: { ...process.env, PATH: "", PATHEXT: ".EXE" }
    });
    expect(missing.status).toBe("not_found");
    const directory = await fixture();
    const wrapper = join(directory, "old.cmd");
    await writeFile(wrapper, "@echo off\r\necho 1.2.3\r\n", "utf8");
    const unsupported = await resolveCommand("old", {
      platform: "win32",
      env: { ...process.env, PATH: directory, PATHEXT: ".CMD" },
      minimumMajorVersion: 22
    });
    expect(unsupported.status).toBe("version_unsupported");
  });

  it("constructs cmd invocation without shell mode ambiguity", () => {
    const invocation = commandInvocation(
      { resolvedPath: String.raw`C:\A path\tool.cmd`, invocationKind: "cmd" },
      ["argument with spaces"],
      { ComSpec: String.raw`C:\Windows\System32\cmd.exe` }
    );
    expect(invocation.executable).toBe(String.raw`C:\Windows\System32\cmd.exe`);
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]).toContain('"C:\\A path\\tool.cmd"');
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });
});
