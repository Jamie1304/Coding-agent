import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeStatus } from "./runtime-manager.js";
import { PRODUCT_VERSION } from "./product.js";

export async function appendRuntimeLog(
  dataDirectory: string,
  event: string,
  detail: Record<string, unknown> = {}
): Promise<void> {
  const directory = join(dataDirectory, "logs");
  await mkdir(directory, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), event, detail: redact(detail) });
  const path = join(directory, "desktop.jsonl");
  let previous = "";
  try {
    previous = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(path, `${previous}${line}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function diagnosticExport(
  dataDirectory: string,
  runtime: RuntimeStatus,
  mode: "development" | "packaged"
): Promise<string> {
  const logPath = join(dataDirectory, "logs", "desktop.jsonl");
  let logs = "";
  try {
    logs = await readFile(logPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return JSON.stringify(
    redact({
      generatedAt: new Date().toISOString(),
      productVersion: PRODUCT_VERSION,
      mode,
      dataDirectory,
      runtime,
      logs
    }),
    null,
    2
  );
}

function redact(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  return JSON.parse(
    serialized.replace(
      /(?:gh[opsu]_[a-z0-9_-]{8,}|sk-(?:proj-)?[a-z0-9_-]{8,}|bearer\s+[a-z0-9._-]{8,}|api[_-]?key\s*[=:]\s*\S+|token\s*[=:]\s*\S+)/gi,
      "[REDACTED]"
    )
  ) as unknown;
}
