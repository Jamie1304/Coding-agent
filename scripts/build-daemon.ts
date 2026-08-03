import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const repositoryRoot = process.cwd();
const outputDirectory = join(repositoryRoot, "dist", "daemon");
const napiModuleDirectory = join(repositoryRoot, "node_modules", "@napi-rs");
const nativeModules = (await readdir(napiModuleDirectory, { withFileTypes: true }))
  .filter(
    (entry) =>
      entry.isDirectory() && (entry.name === "keyring" || entry.name.startsWith("keyring-"))
  )
  .map((entry) => entry.name);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [join(repositoryRoot, "apps", "daemon", "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: join(outputDirectory, "index.cjs"),
  external: ["@napi-rs/keyring"],
  sourcemap: false,
  logLevel: "info"
});

for (const name of nativeModules) {
  const source = join(napiModuleDirectory, name);
  const destination = join(outputDirectory, "node_modules", "@napi-rs", name);
  await cp(source, destination, { recursive: true, force: true });
}

console.log("Bundled daemon runtime with the installed credential-storage native module.");
