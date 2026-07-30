import type { CommandResult } from "./process-runner.js";
import { ProcessRunner } from "./process-runner.js";

export interface QualityGateResult {
  name: string;
  command: string;
  result: CommandResult;
  passed: boolean;
}

export class QualityGateRunner {
  constructor(private readonly runner = new ProcessRunner()) {}

  async run(
    cwd: string,
    commands: string[],
    options: { retries?: number; signal?: AbortSignal } = {}
  ): Promise<QualityGateResult[]> {
    const results: QualityGateResult[] = [];
    for (const command of commands) {
      const [executable, ...args] = splitCommand(command);
      let result: CommandResult | null = null;
      const retries = options.retries ?? 0;
      for (let attempt = 0; attempt <= retries; attempt++) {
        result = await this.runner.run(
          { executable: executable!, args, cwd, timeoutMs: 20 * 60_000 },
          options.signal
        );
        if (result.exitCode === 0) break;
      }
      results.push({
        name: command,
        command,
        result: result!,
        passed: result!.exitCode === 0 && !result!.timedOut
      });
    }
    return results;
  }
}

export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
    } else if (char === quote) {
      quote = null;
    } else if (/\s/.test(char) && !quote) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (quote) throw new Error("Unclosed quote in configured command");
  if (current) tokens.push(current);
  if (tokens.length === 0) throw new Error("Configured command cannot be empty");
  return tokens;
}
