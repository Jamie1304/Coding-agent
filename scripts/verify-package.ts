import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const installers = join(root, "artifacts", "installers");
const version = "0.3.0";
const expected = [
  `Personal-Codex-Agent-Setup-${version}-x64.exe`,
  `Personal-Codex-Agent-Portable-${version}-x64.exe`
];

for (const name of expected) await access(join(installers, name));
await access(join(installers, "win-unpacked", "resources", "app.asar"));
await access(join(installers, "win-unpacked", "resources", "daemon", "index.cjs"));
await access(
  join(
    installers,
    "win-unpacked",
    "resources",
    "daemon",
    "node_modules",
    "@napi-rs",
    "keyring-win32-x64-msvc"
  )
);

const files = await collect(installers);
const lines: string[] = [];
for (const file of files) {
  const details = await stat(file);
  if (!details.isFile()) continue;
  const hash = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
  lines.push(`${hash}  ${relative(installers, file).replaceAll("\\", "/")}`);
}
await mkdir(join(root, "artifacts"), { recursive: true });
await writeFile(join(root, "artifacts", "SHA256SUMS.txt"), `${lines.sort().join("\n")}\n`, "utf8");
console.log(`Verified ${expected.length} Windows artifacts and wrote ${lines.length} checksums.`);

async function collect(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(path)));
    else files.push(path);
  }
  return files;
}
