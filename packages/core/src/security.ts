import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const secretPatterns: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /sk-[a-zA-Z0-9_-]{16,}/g, replacement: "[REDACTED]" },
  { pattern: /gh[opusr]_[a-zA-Z0-9]{20,}/g, replacement: "[REDACTED]" },
  {
    pattern: /((?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
    replacement: "$1[REDACTED]"
  },
  {
    pattern: /(authorization:\s*bearer\s+)[^\s]+/gi,
    replacement: "$1[REDACTED]"
  },
  {
    pattern: /(--(?:token|password|secret|api[_-]?key)(?:=|\s+))[^\s,;]+/gi,
    replacement: "$1[REDACTED]"
  }
];

export function redactSecrets(value: string): string {
  return secretPatterns.reduce(
    (text, { pattern, replacement }) => text.replace(pattern, replacement),
    value
  );
}

export function redactArguments(args: readonly string[]): string[] {
  return args.map((argument) => redactSecrets(argument));
}

export async function validateWorkspacePath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Workspace path must be absolute");
  const canonical = await realpath(resolve(path));
  const details = await stat(canonical);
  if (!details.isDirectory()) throw new Error("Workspace path must be a directory");
  return canonical;
}

export async function validatePathWithinWorkspace(
  workspacePath: string,
  candidatePath: string
): Promise<string> {
  const workspace = await validateWorkspacePath(workspacePath);
  const unresolved = isAbsolute(candidatePath)
    ? resolve(candidatePath)
    : resolve(workspacePath, candidatePath);
  const candidate = await canonicalizePotentialPath(unresolved);
  const rel = relative(workspace, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path escapes workspace");
  return candidate;
}

async function canonicalizePotentialPath(path: string): Promise<string> {
  const missing: string[] = [];
  let cursor = path;
  for (;;) {
    try {
      const canonical = await realpath(cursor);
      return join(canonical, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

export function safeBranchFragment(value: string): string {
  const sanitized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 42);
  return sanitized || "change";
}
