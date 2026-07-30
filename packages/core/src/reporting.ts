import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRun, FinalReport, PromptRevision, TimelineEvent } from "@agent/shared";

const artifactNames = [
  "approved-specification.json",
  "prompt-review.json",
  "prompt-revisions.md",
  "preflight-report.md",
  "implementation-plan.md",
  "acceptance-criteria.md",
  "acceptance-test-matrix.json",
  "changed-files.md",
  "commands.jsonl",
  "test-report.md",
  "coverage-report.md",
  "security-report.md",
  "dependency-report.md",
  "independent-review.md",
  "ci-report.md",
  "deployment-report.md",
  "rollback-report.md",
  "changelog-entry.md",
  "release-notes.md",
  "executive-summary.md",
  "final-report.json"
] as const;

export class ReportGenerator {
  async initialize(root: string, runId: string): Promise<string> {
    const directory = join(root, ".agent-runs", runId);
    await mkdir(directory, { recursive: true });
    for (const name of artifactNames) {
      await writeFile(join(directory, name), initialContent(name), "utf8");
    }
    return directory;
  }

  async writeAlignment(
    directory: string,
    run: AgentRun,
    revisions: PromptRevision[]
  ): Promise<void> {
    const approved = revisions.find((revision) => revision.approved);
    if (approved) {
      await writeFile(
        join(directory, "approved-specification.json"),
        JSON.stringify(approved, null, 2),
        "utf8"
      );
    }
    await writeFile(
      join(directory, "prompt-revisions.md"),
      revisions
        .map(
          (revision) =>
            `# Revision ${revision.revision}\n\n${revision.content}\n\nChanges:\n${revision.changes.map((item) => `- ${item}`).join("\n")}`
        )
        .join("\n\n---\n\n"),
      "utf8"
    );
    await writeFile(
      join(directory, "prompt-review.json"),
      JSON.stringify({ runId: run.id, originalPrompt: run.originalPrompt, revisions }, null, 2),
      "utf8"
    );
  }

  async writeTimeline(directory: string, events: TimelineEvent[]): Promise<void> {
    const commands = events
      .filter((event) => event.evidence?.command)
      .map((event) => JSON.stringify(event))
      .join("\n");
    await writeFile(join(directory, "commands.jsonl"), commands, "utf8");
  }

  async writeFinal(directory: string, report: FinalReport): Promise<void> {
    await writeFile(join(directory, "final-report.json"), JSON.stringify(report, null, 2), "utf8");
    await writeFile(
      join(directory, "executive-summary.md"),
      [
        `# Run ${report.runId}`,
        "",
        `Status: **${report.finalStatus}**`,
        `Workspace: \`${report.workspace}\``,
        "",
        "## Implementation",
        ...report.implementationSummary.map((item) => `- ${item}`),
        "",
        "## Validation",
        ...report.qualityGates.map((gate) => `- ${gate.name}: ${gate.status} (${gate.evidence})`),
        "",
        "## Known limitations",
        ...(report.knownLimitations.length
          ? report.knownLimitations.map((item) => `- ${item}`)
          : ["- None recorded."])
      ].join("\n"),
      "utf8"
    );
  }
}

function initialContent(name: string): string {
  if (name.endsWith(".json")) return "{}\n";
  if (name.endsWith(".jsonl")) return "";
  return `# ${name.replace(/\.md$/, "").replaceAll("-", " ")}\n\nNot reached or not applicable.\n`;
}
