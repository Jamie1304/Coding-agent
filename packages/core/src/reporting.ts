import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentRun,
  ApprovedStepPlan,
  FinalReport,
  PlanStep,
  PromptRevision,
  StepCompletionGate,
  TimelineEvent
} from "@agent/shared";

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
      await writeIfMissing(join(directory, name), initialContent(name));
    }
    return directory;
  }

  async initializeStepPlan(root: string, plan: ApprovedStepPlan): Promise<string> {
    const directory = await this.initialize(root, plan.runId);
    await writeIfMissing(
      join(directory, "approved-step-plan.json"),
      `${JSON.stringify(plan, null, 2)}\n`
    );
    await writeIfMissing(join(directory, "approved-step-plan.md"), approvedStepPlanMarkdown(plan));
    return directory;
  }

  async initializeStepEvidence(
    root: string,
    runId: string,
    step: PlanStep,
    gate: StepCompletionGate
  ): Promise<string> {
    const directory = join(
      root,
      ".agent-runs",
      runId,
      "steps",
      `${String(step.order).padStart(3, "0")}-${step.id}`
    );
    await mkdir(directory, { recursive: true });
    const contents: Record<string, string> = {
      "step-definition.json": `${JSON.stringify(step, null, 2)}\n`,
      "completion-gate.json": `${JSON.stringify(gate, null, 2)}\n`,
      "context-analysis.md": initialStepContent("context analysis"),
      "implementation-summary.md": initialStepContent("implementation summary"),
      "changed-files.md": initialStepContent("changed files"),
      "terminal-operations.jsonl": "",
      "runtime-start.log": "",
      "runtime-errors.json": "[]\n",
      "correction-attempts.json": "[]\n",
      "acceptance-test-matrix.json": "[]\n",
      "focused-tests.md": initialStepContent("focused tests"),
      "runtime-tests.md": initialStepContent("runtime tests"),
      "restart-tests.md": initialStepContent("restart tests"),
      "ui-tests.md": initialStepContent("ui tests"),
      "api-tests.md": initialStepContent("api tests"),
      "diff-review.md": initialStepContent("diff review"),
      "independent-review.md": initialStepContent("independent review"),
      "documentation-updates.md": initialStepContent("documentation updates"),
      "knowledge-updates.md": initialStepContent("knowledge updates"),
      "git-checkpoint.json": "{}\n"
    };
    for (const [name, content] of Object.entries(contents)) {
      await writeIfMissing(join(directory, name), content);
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

function initialStepContent(name: string): string {
  return `# ${name}\n\nNot reached or not applicable.\n`;
}

function approvedStepPlanMarkdown(plan: ApprovedStepPlan): string {
  const steps = [...plan.steps]
    .sort((left, right) => left.order - right.order)
    .map(
      (step) =>
        `## ${step.order}. ${step.title}\n\n${step.objective}\n\n` +
        `- Dependencies: ${step.dependencies.length ? step.dependencies.join(", ") : "None"}\n` +
        `- Acceptance criteria: ${step.acceptanceCriteria.map((criterion) => criterion.id).join(", ")}\n` +
        `- Required tests: ${Object.values(step.requiredTests).flat().length}\n` +
        `- Checkpoint: ${step.gitCheckpoint.expectedCommitMessage}\n`
    )
    .join("\n");
  return (
    `# Approved step plan\n\n` +
    `- Run: ${plan.runId}\n` +
    `- Frozen revision: ${plan.approvedRevision}\n` +
    `- Frozen at: ${plan.frozenAt}\n\n` +
    steps
  );
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
