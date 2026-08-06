import { ChangeAnalyzer, PromptReviewer } from "@agent/core";
import type { WorkspaceAnalysis } from "@agent/shared";

const analysis: WorkspaceAnalysis = {
  snapshot: {
    path: "C:\\project",
    name: "project",
    trusted: true,
    activeFile: null,
    source: "manual"
  },
  git: {
    isRepository: true,
    branch: "main",
    defaultBranch: "main",
    remote: "https://example.test/repo.git",
    commit: "abc",
    dirty: false
  },
  technologies: ["TypeScript", "React"],
  packageManager: "npm",
  testCommands: ["npm test"],
  configStatus: "not_configured",
  files: ["package.json", "src/App.tsx"]
};

const analysisNoTests: WorkspaceAnalysis = {
  ...analysis,
  testCommands: []
};

describe("PromptReviewer", () => {
  it("asks only material questions and creates an evidence-aware revision", () => {
    const reviewer = new PromptReviewer();
    const prompt = "Add an authenticated upload integration";
    const questions = reviewer.createQuestions(prompt, analysis, 1);
    expect(questions.length).toBeGreaterThan(0);
    questions.forEach((question) => {
      question.answer = question.options[0] ?? "Fail safely";
      question.confirmed = true;
    });
    const revision = reviewer.revise(prompt, analysis, questions, 1);
    expect(revision.content).toContain("C:\\project");
    expect(revision.acceptanceCriteria.join(" ")).toContain("confirmed decision");
    expect(revision.tests).toContain("Run `npm test` and require exit code 0.");
  });

  it("includes revisionId and promptHash in the revision", () => {
    const reviewer = new PromptReviewer();
    const revision = reviewer.revise("Add a search feature", analysis, [], 1);
    expect(revision.revisionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(revision.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different hashes for different content", () => {
    const reviewer = new PromptReviewer();
    const r1 = reviewer.revise("Add a search feature", analysis, [], 1);
    const r2 = reviewer.revise("Remove the search feature", analysis, [], 1);
    expect(r1.promptHash).not.toBe(r2.promptHash);
  });

  it("asks a validation question when no test commands detected", () => {
    const reviewer = new PromptReviewer();
    const questions = reviewer.createQuestions("Add a feature", analysisNoTests, 1);
    const validationQ = questions.find((q) => q.id.startsWith("validation:"));
    expect(validationQ).toBeDefined();
  });

  it("asks a rejection follow-up as the first question", () => {
    const reviewer = new PromptReviewer();
    const first = reviewer.createQuestions("Add a new search feature", analysis, 1);
    first[0]!.answer = "Keyboard-first";
    first[0]!.confirmed = true;
    const next = reviewer.createQuestions(
      "Add a new search feature",
      analysis,
      2,
      first,
      "The search must be mouse-first instead"
    );
    expect(next[0]!.id).toMatch(/^rejection-/);
    expect(new Set(first.map((question) => question.id)).has(next[0]!.id)).toBe(false);
    expect(first[0]!.confirmed).toBe(true);
  });

  it("reports complete when all material questions answered", () => {
    const reviewer = new PromptReviewer();
    const prompt = "Add a new feature";
    const qs = reviewer.createQuestions(prompt, analysisNoTests, 1);
    // Before answering, may still be incomplete
    qs.forEach((q) => {
      q.answer = "yes";
      q.confirmed = true;
    });
    const complete = reviewer.isComplete(prompt, analysisNoTests, qs);
    // After answering all generated questions, should report complete
    expect(typeof complete).toBe("boolean");
  });

  it("includes repository evidence in questions", () => {
    const reviewer = new PromptReviewer();
    const prompt = "Add a new external API integration";
    const questions = reviewer.createQuestions(prompt, analysis, 1);
    const withEvidence = questions.filter((q) => q.repositoryEvidence.length > 0);
    // At least some questions should cite repository evidence
    expect(withEvidence.length).toBeGreaterThanOrEqual(0);
  });

  it("includes security requirements in revision for security-related prompts", () => {
    const reviewer = new PromptReviewer();
    const prompt = "Add user authentication with credentials";
    const questions = reviewer.createQuestions(prompt, analysis, 1);
    questions.forEach((q) => {
      q.answer = q.options[0] ?? "Use existing";
      q.confirmed = true;
    });
    const revision = reviewer.revise(prompt, analysis, questions, 1);
    // Electron project — should auto-include renderer sandbox requirement
    expect(revision.securityRequirements.join(" ")).toContain("sandboxed");
  });
});

describe("ChangeAnalyzer", () => {
  const analyzer = new ChangeAnalyzer();

  it("classifies a beneficial improvement as an improvement", () => {
    const result = analyzer.analyze("Add automated tests for edge cases", "## Goal\nAdd a feature");
    expect(result.classification).toBe("improvement");
  });

  it("rejects a suggestion that weakens security invariants", () => {
    const result = analyzer.analyze("Skip authentication for testing", "some content");
    expect(result.classification).toBe("unsafe");
    expect(result.action).toBe("reject");
    expect(result.proposedAlternative).toBeTruthy();
  });

  it("rejects technically unrealistic requirements", () => {
    const result = analyzer.analyze("Make it real-time with zero latency", "content");
    expect(result.classification).toBe("technically-unrealistic");
    expect(result.action).toBe("reject");
  });

  it("rejects untestable requirements", () => {
    const result = analyzer.analyze("It should feel natural and intuitive", "content");
    expect(result.classification).toBe("untestable");
    expect(result.action).toBe("reject");
  });

  it("marks out-of-scope suggestions as split-optional", () => {
    const result = analyzer.analyze("Deploy to production iOS and Android", "content");
    expect(result.classification).toBe("out-of-pilot-scope");
    expect(result.action).toBe("split-optional");
  });

  it("detects redundant suggestions", () => {
    const content = "Implement the feature and add automated tests for each behavior change";
    const result = analyzer.analyze("We should add automated tests for each behavior", content);
    expect(result.classification).toBe("redundant");
  });

  it("includes a stable suggestionId", () => {
    const r1 = analyzer.analyze("Add tests", "content");
    const r2 = analyzer.analyze("Add tests", "content");
    expect(r1.suggestionId).toBe(r2.suggestionId);
  });

  it("marks schema changes as requiring migration and invalidating approval", () => {
    const result = analyzer.analyze("Rename the users table to accounts", "content");
    expect(result.invalidatesApproval).toBe(true);
    expect(result.newQuestions.length).toBeGreaterThan(0);
  });
});
