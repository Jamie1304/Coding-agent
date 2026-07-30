import { PromptReviewer } from "@agent/core";
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

  it("asks a different precise question after rejection and preserves confirmations", () => {
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
});
