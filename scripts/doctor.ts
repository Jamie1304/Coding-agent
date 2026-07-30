import { resolve } from "node:path";
import { runDoctor } from "./doctor-lib.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const json = process.argv.includes("--json");
const report = await runDoctor(repositoryRoot);

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("\nPersonal Codex Agent diagnostics\n");
  for (const check of report.checks) {
    console.log(`[${check.level}] ${check.name}: ${check.detail}`);
    console.log(`       Requirement: ${check.requirement}`);
    if (check.resolvedPath) console.log(`       Resolved: ${check.resolvedPath}`);
    if (check.repairCommand) console.log(`       Repair: ${check.repairCommand}`);
    if (check.inAppAction) console.log(`       In app: ${check.inAppAction}`);
  }
  console.log(
    `\n${report.summary.pass} passed, ${report.summary.warnings} warning(s), ` +
      `${report.summary.optional} optional missing, ${report.summary.actionRequired} action required, ` +
      `${report.summary.blockingFailures} blocking failure(s).`
  );
}

process.exitCode = report.summary.blockingFailures > 0 ? 1 : 0;
