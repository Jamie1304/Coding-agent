import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { packager } from "@electron/packager";

const artifacts = join(process.cwd(), "artifacts");
await mkdir(artifacts, { recursive: true });
const staging = join(artifacts, ".desktop-staging");
const desktopOutput = join(artifacts, "desktop");
await removePackagingDirectory(staging);
await removePackagingDirectory(desktopOutput);
await mkdir(staging, { recursive: true });
await cp(join(process.cwd(), "dist", "desktop"), join(staging, "dist", "desktop"), {
  recursive: true
});
await writeFile(
  join(staging, "package.json"),
  JSON.stringify(
    {
      name: "personal-codex-agent",
      productName: "Personal Codex Agent",
      version: "0.2.0",
      main: "dist/desktop/main/index.cjs"
    },
    null,
    2
  ),
  "utf8"
);
await packager({
  dir: staging,
  out: desktopOutput,
  name: "Personal Codex Agent",
  platform: "win32",
  arch: "x64",
  electronVersion: "43.2.0",
  asar: true,
  overwrite: true,
  prune: true
});
await removePackagingDirectory(staging);
const files = await collect(artifacts);
const lines: string[] = [];
for (const file of files.filter((value) => !value.endsWith("SHA256SUMS.txt"))) {
  const details = await stat(file);
  if (!details.isFile()) continue;
  const hash = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
  lines.push(`${hash}  ${relative(artifacts, file).replaceAll("\\", "/")}`);
}
await writeFile(join(artifacts, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote checksums for ${lines.length} packaged files.`);

async function collect(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...(await collect(path)));
    else output.push(path);
  }
  return output;
}

async function removePackagingDirectory(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 8 : 2,
    retryDelay: 250
  });
}
