import { createHash, randomUUID } from "node:crypto";
import type { PromptRevision, Question, WorkspaceAnalysis } from "@agent/shared";

const materialPatterns = [
  {
    id: "behavior",
    test: (prompt: string) => !/(should|must|when|if|acceptance|expected)/i.test(prompt),
    text: "What observable behavior should be considered successful?",
    reason: "The request does not define a verifiable outcome.",
    affects: "Acceptance criteria and behavior tests",
    options: ["Match an existing pattern", "Define a new explicit behavior"]
  },
  {
    id: "compatibility",
    test: (prompt: string) => /(?:api|database|schema|migration|public)/i.test(prompt),
    text: "Must this change remain backward compatible with existing consumers and stored data?",
    reason: "The request may alter a compatibility boundary.",
    affects: "Version bump, migrations, and rollback strategy",
    options: ["Yes, preserve compatibility", "No, a breaking change is acceptable"]
  },
  {
    id: "failure",
    test: (prompt: string) =>
      /(?:integration|network|upload|deploy|external|service)/i.test(prompt),
    text: "What should users observe when the external operation fails or times out?",
    reason: "Failure behavior changes the implementation and recovery tests.",
    affects: "Error handling, retries, and user feedback",
    options: ["Fail safely with retry", "Block and require manual recovery"]
  },
  {
    id: "security",
    test: (prompt: string) => /(?:auth|secret|token|permission|user|credential)/i.test(prompt),
    text: "Which trust boundary and credential-storage rules apply?",
    reason: "Security-sensitive behavior must be explicit before implementation.",
    affects: "Authorization checks, storage, redaction, and security tests",
    options: ["Use existing project security conventions", "Define a new scoped policy"]
  }
];

export class PromptReviewer {
  createQuestions(
    prompt: string,
    analysis: WorkspaceAnalysis,
    revision: number,
    existing: Question[] = [],
    rejectionReason?: string
  ): Question[] {
    const asked = new Set(existing.map((question) => question.id.split(":")[0]));
    const candidates = materialPatterns.filter(
      (pattern) =>
        pattern.test(prompt) && (!asked.has(pattern.id) || contradicts(existing, rejectionReason))
    );
    if (rejectionReason) {
      candidates.unshift({
        id: `rejection-${createHash("sha1").update(rejectionReason).digest("hex").slice(0, 8)}`,
        test: () => true,
        text: `Which concrete requirement should replace the rejected interpretation: “${rejectionReason.slice(0, 180)}”?`,
        reason: "The rejection must become an explicit implementation decision.",
        affects: "The next prompt revision and acceptance criteria",
        options: []
      });
    }
    if (analysis.testCommands.length === 0 && !asked.has("validation")) {
      candidates.push({
        id: "validation",
        test: () => true,
        text: "Which command or observable check should validate this change?",
        reason: "No reliable project test command was detected.",
        affects: "The required quality gate",
        options: ["Add a project-native automated test", "Use an explicit manual verification"]
      });
    }
    return candidates.slice(0, 3).map((candidate) => ({
      id: `${candidate.id}:${randomUUID()}`,
      text: candidate.text,
      reason: candidate.reason,
      affects: candidate.affects,
      options: candidate.options,
      answer: null,
      revision,
      confirmed: false,
      superseded: false
    }));
  }

  revise(
    originalPrompt: string,
    analysis: WorkspaceAnalysis,
    questions: Question[],
    revision: number,
    rejectionReason?: string
  ): PromptRevision {
    const decisions = questions
      .filter((question) => question.confirmed && question.answer)
      .map((question) => `${question.text} — ${question.answer}`);
    const tests =
      analysis.testCommands.length > 0
        ? analysis.testCommands.map((command) => `Run \`${command}\` and require exit code 0.`)
        : ["Add focused automated coverage and run the new test with a real exit code."];
    const criteria = [
      "Implement the requested behavior within the detected workspace only.",
      "Preserve unrelated behavior and existing user changes.",
      ...decisions.map((decision) => `Honor confirmed decision: ${decision}`),
      "Add or update tests for every changed behavior.",
      "Run detected quality gates and review the final diff before completion."
    ];
    const sections = [
      "# Approved implementation specification",
      "",
      "## Goal",
      originalPrompt.trim(),
      "",
      "## Repository context",
      `- Workspace: ${analysis.snapshot.path}`,
      `- Technologies: ${analysis.technologies.join(", ") || "not detected"}`,
      `- Starting commit: ${analysis.git.commit ?? "not a Git repository"}`,
      "",
      "## Confirmed decisions",
      ...(decisions.length ? decisions.map((item) => `- ${item}`) : ["- None required."]),
      "",
      "## Acceptance criteria",
      ...criteria.map((item) => `- ${item}`),
      "",
      "## Required validation",
      ...tests.map((item) => `- ${item}`)
    ];
    return {
      revision,
      content: sections.join("\n"),
      changes: [
        "Added detected repository context.",
        "Converted the request into observable acceptance criteria.",
        "Mapped validation to detected project commands.",
        ...(rejectionReason ? [`Replaced rejected interpretation: ${rejectionReason}`] : [])
      ],
      assumptions: [
        "Existing project conventions remain authoritative where the specification is silent.",
        "No deployment occurs unless .agent/project.yml explicitly configures it."
      ],
      acceptanceCriteria: criteria,
      tests,
      risks: [
        ...(analysis.git.dirty ? ["The source repository has uncommitted changes."] : []),
        ...(analysis.git.isRepository ? [] : ["The workspace is not a Git repository."])
      ],
      affectedComponents: inferComponents(originalPrompt, analysis.files),
      versionChange: inferVersionChange(originalPrompt),
      sequence: [
        "Inspect relevant code and existing tests.",
        "Implement the smallest coherent change.",
        "Run focused tests and correct failures.",
        "Run full quality gates and security checks.",
        "Review the diff and generate evidence."
      ],
      approved: false,
      frozenAt: null
    };
  }
}

function contradicts(existing: Question[], rejectionReason?: string): boolean {
  if (!rejectionReason) return false;
  const lower = rejectionReason.toLowerCase();
  return existing.some(
    (question) => question.answer && lower.includes(question.answer.toLowerCase().slice(0, 20))
  );
}

function inferComponents(prompt: string, files: string[]): string[] {
  const candidates = new Set<string>();
  const lower = prompt.toLowerCase();
  if (/ui|screen|button|form|component/.test(lower)) candidates.add("user interface");
  if (/api|server|endpoint|daemon/.test(lower)) candidates.add("backend/API");
  if (/database|schema|migration/.test(lower)) candidates.add("persistence");
  if (/test|quality/.test(lower)) candidates.add("automated tests");
  if (files.includes("package.json")) candidates.add("Node.js project");
  return [...candidates].length
    ? [...candidates]
    : ["repository implementation", "automated tests"];
}

function inferVersionChange(prompt: string): "patch" | "minor" | "major" {
  if (/breaking|remove|incompatible|major/i.test(prompt)) return "major";
  if (/add|create|feature|support|new/i.test(prompt)) return "minor";
  return "patch";
}
