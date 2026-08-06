import { createHash, randomUUID } from "node:crypto";
import type { PromptRevision, Question, WorkspaceAnalysis } from "@agent/shared";

/**
 * A candidate clarification question generated from request analysis.
 * Each candidate identifies a specific material unknown with evidence.
 */
interface QuestionCandidate {
  id: string;
  text: string;
  reason: string;
  affects: string;
  options: string[];
  repositoryEvidence: string[];
  assumptions: string[];
  isRejectionFollowUp?: boolean;
}

/**
 * Analyses a rough request against repository evidence to generate
 * adaptive, material clarification questions.
 *
 * Material questions are those whose answers can change:
 * scope, public behavior, architecture, persistent data, security,
 * provider choice, IDE behavior, compatibility, cost, privacy, tests,
 * deployment, rollback, user-visible workflow, or definition of done.
 */
function deriveQuestionCandidates(
  prompt: string,
  analysis: WorkspaceAnalysis
): QuestionCandidate[] {
  const candidates: QuestionCandidate[] = [];
  const hasFiles = analysis.files.length > 0;
  const isGitRepo = analysis.git.isRepository;
  const hasTests = analysis.testCommands.length > 0;
  const techs = analysis.technologies.join(", ");

  // --- Observable behavior ---
  if (!/(should|must|when|if|acceptance\s+criteria|expected\s+result|observable)/i.test(prompt)) {
    candidates.push({
      id: "behavior",
      text: "What observable behavior should be considered successful — what exactly changes for the user?",
      reason:
        "The request does not define a verifiable outcome, making acceptance criteria impossible to write.",
      affects: "Acceptance criteria, behavior tests, and definition of done",
      options: [
        "Match the behavior of an existing similar feature",
        "Define a new explicit user-facing outcome"
      ],
      repositoryEvidence: hasTests
        ? [`Detected test commands: ${analysis.testCommands.join(", ")}`]
        : ["No automated test commands detected"],
      assumptions: []
    });
  }

  // --- Backward compatibility ---
  if (/(?:api|database|schema|migration|public\s+interface|breaking)/i.test(prompt)) {
    const dbEvidence: string[] = [];
    if (analysis.files.some((file) => /migration|schema|\.sql/i.test(file))) {
      dbEvidence.push("Repository contains migration or schema files");
    }
    if (/package\.json/.test(analysis.files.join(","))) {
      dbEvidence.push("Node.js project detected — version bump may be required");
    }
    candidates.push({
      id: "compatibility",
      text: "Must this change remain backward compatible with existing API consumers, stored data, or dependent systems?",
      reason:
        "The request touches an API, schema, or public interface that may have existing consumers.",
      affects: "Version bump, migration strategy, deprecation plan, and rollback path",
      options: [
        "Yes — full backward compatibility required",
        "Tolerate a limited breaking change with migration guide",
        "Breaking change acceptable"
      ],
      repositoryEvidence: dbEvidence,
      assumptions: ["All changes preserve compatibility unless explicitly stated otherwise"]
    });
  }

  // --- Failure and error handling ---
  if (
    /(?:integration|network|upload|deploy|external|service|webhook|api\s+call|http)/i.test(prompt)
  ) {
    candidates.push({
      id: "failure",
      text: "What should users observe when the external operation fails, times out, or returns an error?",
      reason:
        "External operations fail unpredictably; failure behavior determines retry logic, user messaging, and recovery paths.",
      affects: "Error handling, retry policy, user feedback, and recovery tests",
      options: [
        "Fail transparently with a clear error message and retry option",
        "Queue and retry silently",
        "Block and require manual recovery"
      ],
      repositoryEvidence: [],
      assumptions: []
    });
  }

  // --- Security and credentials ---
  if (/(?:auth|secret|token|permission|user|credential|role|access|trust)/i.test(prompt)) {
    const secEvidence: string[] = [];
    if (isGitRepo)
      secEvidence.push("Repository is version-controlled — credentials must not appear in commits");
    if (analysis.technologies.some((t) => /node|electron/i.test(t))) {
      secEvidence.push("Node.js/Electron architecture — renderer must remain sandboxed");
    }
    candidates.push({
      id: "security",
      text: "Which trust boundary and credential-storage rules apply to this change?",
      reason:
        "Security-sensitive behavior must be explicit before implementation to avoid credential leaks or privilege escalation.",
      affects:
        "Authorization checks, credential storage, redaction, sandbox boundaries, and security tests",
      options: [
        "Use existing project security conventions (Windows Credential Manager + sandboxed renderer)",
        "Define a new scoped security policy"
      ],
      repositoryEvidence: secEvidence,
      assumptions: [
        "Credentials are stored in OS-protected storage; they do not appear in SQLite, logs, or renderer state"
      ]
    });
  }

  // --- Scope and affected components ---
  if (hasFiles && !/scope|only|just|specifically|limited\s+to|within/i.test(prompt)) {
    const relevantFiles = analysis.files
      .filter((file) => /src|lib|packages|apps/i.test(file))
      .slice(0, 5);
    if (relevantFiles.length > 0) {
      candidates.push({
        id: "scope",
        text: `Is the change scoped to specific files or components, or does it span the whole repository?`,
        reason:
          "Without a clear scope, implementation may inadvertently affect unrelated components.",
        affects: "Implementation scope, affected files, test coverage, and review effort",
        options: ["Scoped to a specific module or feature", "Repository-wide change"],
        repositoryEvidence: [
          `Repository has ${analysis.files.length} tracked files; e.g. ${relevantFiles.join(", ")}`
        ],
        assumptions: []
      });
    }
  }

  // --- Validation when no test commands detected ---
  if (!hasTests) {
    candidates.push({
      id: "validation",
      text: "Which command or observable check should validate this change?",
      reason: `No automated test commands were detected in ${techs || "this project"}.`,
      affects: "The required quality gate and CI configuration",
      options: [
        "Add a project-native automated test",
        "Use a manual verification step",
        "Extend an existing test suite"
      ],
      repositoryEvidence:
        analysis.technologies.length > 0 ? [`Detected technologies: ${techs}`] : [],
      assumptions: []
    });
  }

  // --- Migration concerns for database changes ---
  if (/(?:database|schema|sqlite|migration|table|column|add\s+field)/i.test(prompt)) {
    if (!/(migration|upgrade|rollback)/i.test(prompt)) {
      candidates.push({
        id: "migration",
        text: "Does this schema change require a database migration, and what is the rollback strategy?",
        reason:
          "Schema changes to existing tables require safe migrations and rollback procedures.",
        affects: "Migration scripts, data integrity, rollback plan, and deployment sequence",
        options: [
          "Add a versioned migration with rollback",
          "In-place schema change without migration (new installations only)"
        ],
        repositoryEvidence: analysis.files
          .filter((file) => /database|migration|sqlite/i.test(file))
          .slice(0, 3),
        assumptions: []
      });
    }
  }

  // --- Privacy and data handling for user data ---
  if (/(?:user\s+data|personal|pii|privacy|gdpr|log|telemetry|analytics)/i.test(prompt)) {
    candidates.push({
      id: "privacy",
      text: "Does this change collect, store, or transmit any user-identifiable or sensitive data?",
      reason: "Personal data handling has legal, compliance, and user-trust implications.",
      affects: "Data retention policy, encryption, anonymization, and audit trail",
      options: [
        "No personal data involved",
        "Personal data handled with explicit consent and secure storage",
        "Anonymized aggregate data only"
      ],
      repositoryEvidence: [],
      assumptions: []
    });
  }

  return candidates;
}

/**
 * Deduplicate candidates against already-asked questions.
 * A question is considered already asked if its base ID appears in the existing list
 * AND the existing answer is not contradicted by a rejection reason.
 */
function deduplicate(
  candidates: QuestionCandidate[],
  existing: Question[],
  rejectionReason?: string
): QuestionCandidate[] {
  const asked = new Set(existing.map((q) => q.id.split(":")[0]));
  return candidates.filter((candidate) => {
    if (!asked.has(candidate.id)) return true;
    // Re-ask if there's a direct contradiction with an existing answer
    if (rejectionReason) {
      const lower = rejectionReason.toLowerCase();
      const conflict = existing.find(
        (q) =>
          q.id.startsWith(candidate.id) &&
          q.answer &&
          lower.includes(q.answer.toLowerCase().slice(0, 20))
      );
      return Boolean(conflict);
    }
    return false;
  });
}

export class PromptReviewer {
  createQuestions(
    prompt: string,
    analysis: WorkspaceAnalysis,
    revision: number,
    existing: Question[] = [],
    rejectionReason?: string
  ): Question[] {
    const candidates: QuestionCandidate[] = [];

    // Rejection follow-up always comes first and counts as a question
    if (rejectionReason) {
      const rejectId = `rejection-${createHash("sha1").update(rejectionReason).digest("hex").slice(0, 8)}`;
      candidates.push({
        id: rejectId,
        text: `Which concrete requirement should replace the rejected interpretation: "${rejectionReason.slice(0, 180)}"?`,
        reason:
          "The rejection must become an explicit implementation decision before revising the specification.",
        affects: "The next prompt revision and acceptance criteria",
        options: [],
        repositoryEvidence: [],
        assumptions: [],
        isRejectionFollowUp: true
      });
    }

    // Derive adaptive candidates from the request and repository evidence
    const derived = deriveQuestionCandidates(prompt, analysis);
    const filtered = deduplicate(derived, existing, rejectionReason);
    candidates.push(...filtered);

    // Return at most 3 questions per round so the user is not overwhelmed
    return candidates.slice(0, 3).map((candidate) => ({
      id: `${candidate.id}:${randomUUID()}`,
      text: candidate.text,
      reason: candidate.reason,
      affects: candidate.affects,
      options: candidate.options,
      answer: null,
      revision,
      confirmed: false,
      superseded: false,
      repositoryEvidence: candidate.repositoryEvidence,
      assumptions: candidate.assumptions,
      rejectedInterpretations: [],
      remainingUncertainty: null,
      answeredAt: null
    }));
  }

  /**
   * Returns true when no further material questions remain.
   * Clarification is complete when all required questions are answered
   * OR no new material questions can be generated.
   */
  isComplete(prompt: string, analysis: WorkspaceAnalysis, existing: Question[]): boolean {
    const candidates = deriveQuestionCandidates(prompt, analysis);
    const remaining = deduplicate(candidates, existing);
    // Complete when all candidates are either answered or not applicable
    const unanswered = remaining.filter(
      (c) => !existing.some((q) => q.id.startsWith(c.id) && q.confirmed && q.answer)
    );
    return unanswered.length === 0;
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

    // Infer security requirements from questions answered on security topics
    const securityRequirements: string[] = [];
    for (const q of questions) {
      if (q.id.startsWith("security") && q.confirmed && q.answer) {
        securityRequirements.push(q.answer);
      }
    }
    if (analysis.technologies.some((t) => /electron/i.test(t))) {
      securityRequirements.push("Renderer must remain sandboxed and unprivileged.");
      securityRequirements.push("Secrets must not appear in SQLite, renderer state, or logs.");
    }

    const nonGoals = [
      "No deployment unless .agent/project.yml explicitly configures it.",
      "No force-push or direct push to the default branch."
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
      `- Branch: ${analysis.git.branch ?? "unknown"}`,
      "",
      "## Confirmed decisions",
      ...(decisions.length ? decisions.map((item) => `- ${item}`) : ["- None required."]),
      "",
      "## Acceptance criteria",
      ...criteria.map((item) => `- ${item}`),
      "",
      "## Security requirements",
      ...(securityRequirements.length
        ? securityRequirements.map((item) => `- ${item}`)
        : ["- Follow existing project security conventions."]),
      "",
      "## Non-goals",
      ...nonGoals.map((item) => `- ${item}`),
      "",
      "## Required validation",
      ...tests.map((item) => `- ${item}`)
    ];

    const content = sections.join("\n");
    const revisionId = randomUUID();
    const promptHash = createHash("sha256").update(content).digest("hex");

    return {
      revision,
      revisionId,
      promptHash,
      content,
      changes: [
        "Added detected repository context.",
        "Converted the request into observable acceptance criteria.",
        "Mapped validation to detected project commands.",
        ...(securityRequirements.length
          ? ["Added security requirements from confirmed answers."]
          : []),
        ...(rejectionReason ? [`Replaced rejected interpretation: ${rejectionReason}`] : [])
      ],
      assumptions: [
        "Existing project conventions remain authoritative where the specification is silent.",
        "No deployment occurs unless .agent/project.yml explicitly configures it.",
        ...questions
          .filter((q) => q.assumptions.length > 0 && q.confirmed)
          .flatMap((q) => q.assumptions)
      ],
      acceptanceCriteria: criteria,
      tests,
      risks: [
        ...(analysis.git.dirty ? ["The source repository has uncommitted changes."] : []),
        ...(analysis.git.isRepository ? [] : ["The workspace is not a Git repository."])
      ],
      affectedComponents: inferComponents(originalPrompt, analysis.files),
      versionChange: inferVersionChange(originalPrompt),
      nonGoals,
      securityRequirements,
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
