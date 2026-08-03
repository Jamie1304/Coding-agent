import { randomUUID } from "node:crypto";
import type { AgentDatabase } from "@agent/database";
import {
  type AgentRun,
  type ApprovedStepPlan,
  type PromptRevision,
  type Question,
  type StepCompletionGate,
  type StepState,
  type TimelineEvent,
  type WorkspaceAnalysis
} from "@agent/shared";
import { PromptReviewer } from "./prompt-reviewer.js";
import { ReportGenerator } from "./reporting.js";
import { WorkflowStateMachine } from "./state-machine.js";
import { StepGateEngine, type StepExecutionSnapshot } from "./step-gate.js";
import { StepPlanService } from "./step-plan.js";
import { WorkspaceInspector } from "./workspace.js";

export interface RunView {
  run: AgentRun;
  analysis?: WorkspaceAnalysis;
  questions: Question[];
  revisions: PromptRevision[];
  events: TimelineEvent[];
  stepPlan?: ApprovedStepPlan;
  stepGates?: StepCompletionGate[];
}

export class RunService {
  private analyses = new Map<string, WorkspaceAnalysis>();
  private reportDirectories = new Map<string, string>();
  private readonly stepPlans: StepPlanService;
  private readonly stepGates: StepGateEngine;

  constructor(
    private readonly database: AgentDatabase,
    private readonly inspector = new WorkspaceInspector(),
    private readonly reviewer = new PromptReviewer(),
    private readonly reports = new ReportGenerator()
  ) {
    this.stepPlans = new StepPlanService(database, reports);
    this.stepGates = new StepGateEngine(this.stepPlans);
  }

  async create(workspacePath: string, prompt: string): Promise<RunView> {
    const run: AgentRun = {
      id: randomUUID(),
      workspacePath,
      repositoryIdentity: null,
      startingCommit: null,
      state: "IDLE",
      finalStatus: null,
      originalPrompt: prompt,
      approvedPrompt: null,
      approvedRevision: null,
      createdAt: new Date().toISOString(),
      approvedAt: null,
      completedAt: null,
      retryCount: 0
    };
    this.database.createRun(run);
    await this.transition(run, "WORKSPACE_DISCOVERY", "Discovering workspace");
    const analysis = await this.inspector.inspect(workspacePath);
    this.analyses.set(run.id, analysis);
    run.repositoryIdentity = analysis.git.remote ?? analysis.snapshot.path;
    run.startingCommit = analysis.git.commit;
    this.database.updateRun(run);
    const directory = await this.reports.initialize(analysis.snapshot.path, run.id);
    this.reportDirectories.set(run.id, directory);
    await this.transition(run, "REPOSITORY_ANALYSIS", "Repository inspection complete");
    await this.transition(run, "PROMPT_REVIEW", "Reviewing prompt against repository evidence");
    const questions = this.reviewer.createQuestions(prompt, analysis, 1);
    if (questions.length) {
      questions.forEach((question) => this.database.saveQuestion(run.id, question));
      await this.transition(run, "QUESTIONING", "Critical decisions require user answers");
    } else {
      await this.createRevision(run, analysis);
    }
    return this.get(run.id);
  }

  async answer(
    runId: string,
    answers: Array<{ questionId: string; answer: string }>
  ): Promise<RunView> {
    const run = this.requireRun(runId);
    if (run.state !== "QUESTIONING") throw new Error("Run is not accepting answers");
    const questions = this.database.questions(runId);
    for (const answer of answers) {
      const question = questions.find((item) => item.id === answer.questionId);
      if (!question) throw new Error(`Unknown question: ${answer.questionId}`);
      question.answer = answer.answer;
      question.confirmed = true;
      this.database.saveQuestion(runId, question);
    }
    const unanswered = this.database
      .questions(runId)
      .filter((question) => !question.superseded && !question.confirmed);
    if (unanswered.length === 0) {
      await this.createRevision(run, this.requireAnalysis(runId));
    }
    return this.get(runId);
  }

  async reject(runId: string, reason: string): Promise<RunView> {
    const run = this.requireRun(runId);
    if (run.state !== "AWAITING_APPROVAL") throw new Error("Run is not awaiting approval");
    const analysis = this.requireAnalysis(runId);
    const existing = this.database.questions(runId);
    const revisionNumber = this.database.revisions(runId).length + 1;
    const questions = this.reviewer.createQuestions(
      run.originalPrompt,
      analysis,
      revisionNumber,
      existing,
      reason
    );
    questions.forEach((question) => this.database.saveQuestion(runId, question));
    await this.transition(
      run,
      "QUESTIONING",
      "Revision rejected; requesting new alignment details",
      {
        rejectionReason: reason
      }
    );
    return this.get(runId);
  }

  async approve(runId: string, editedPrompt?: string): Promise<RunView> {
    const run = this.requireRun(runId);
    if (run.state !== "AWAITING_APPROVAL") throw new Error("Run is not awaiting approval");
    const revisions = this.database.revisions(runId);
    const revision = revisions.at(-1);
    if (!revision) throw new Error("No prompt revision exists");
    revision.content = editedPrompt?.trim() || revision.content;
    revision.approved = true;
    revision.frozenAt = new Date().toISOString();
    this.database.saveRevision(runId, revision);
    run.approvedPrompt = revision.content;
    run.approvedRevision = revision.revision;
    run.approvedAt = revision.frozenAt;
    this.database.updateRun(run);
    await this.reports.writeAlignment(
      this.requireReportDirectory(runId),
      run,
      this.database.revisions(runId)
    );
    await this.transition(run, "PREFLIGHT", "Approved specification frozen; execution enabled");
    return this.get(runId);
  }

  async cancel(runId: string): Promise<RunView> {
    const run = this.requireRun(runId);
    if (["SUCCESS", "FAILED", "CANCELLED"].includes(run.state)) return this.get(runId);
    await this.transition(run, "CANCELLED", "Cancelled by user");
    run.finalStatus = "cancelled";
    run.completedAt = new Date().toISOString();
    this.database.updateRun(run);
    return this.get(runId);
  }

  get(runId: string): RunView {
    const run = this.requireRun(runId);
    const stepPlan = this.stepPlans.plan(runId);
    return {
      run,
      ...(this.analyses.get(runId) ? { analysis: this.analyses.get(runId)! } : {}),
      questions: this.database.questions(runId),
      revisions: this.database.revisions(runId),
      events: this.database.events(runId),
      ...(stepPlan ? { stepPlan, stepGates: this.stepPlans.gates(runId) } : {})
    };
  }

  list(): AgentRun[] {
    return this.database.listRuns();
  }

  async advance(
    runId: string,
    state: AgentRun["state"],
    message: string,
    evidence?: Record<string, unknown>
  ): Promise<RunView> {
    const run = this.requireRun(runId);
    await this.transition(run, state, message, evidence);
    return this.get(runId);
  }

  async initializeStepPlan(plan: ApprovedStepPlan): Promise<RunView> {
    const run = this.requireRun(plan.runId);
    if (!run.approvedRevision || !run.approvedAt) {
      throw new Error("A frozen prompt revision is required before initializing a step plan");
    }
    if (plan.approvedRevision !== run.approvedRevision) {
      throw new Error("Step plan revision must match the frozen prompt revision");
    }
    await this.stepPlans.initialize(plan, run.workspacePath);
    this.recordStepEvent(run, "Step plan initialized; only the first step is ready", {
      state: "STEP_READY",
      stepId: plan.steps[0]!.id
    });
    return this.get(run.id);
  }

  advanceStep(
    runId: string,
    stepId: string,
    expectedState: StepState,
    targetState: StepState
  ): RunView {
    const run = this.requireRun(runId);
    this.stepGates.transition(runId, stepId, expectedState, targetState);
    this.recordStepEvent(run, `Step ${stepId} transitioned to ${targetState}`, {
      stepId,
      state: targetState
    });
    return this.get(runId);
  }

  recoverStepExecution(runId: string): StepExecutionSnapshot {
    const run = this.requireRun(runId);
    const before = this.stepGates.snapshot(runId);
    const recovered = this.stepGates.recover(runId);
    const beforeState = before.activeStep
      ? before.gates.find((gate) => gate.stepId === before.activeStep?.id)?.state
      : null;
    const afterState = recovered.activeStep
      ? recovered.gates.find((gate) => gate.stepId === recovered.activeStep?.id)?.state
      : null;
    if (beforeState !== afterState) {
      this.recordStepEvent(run, "Recovered the next ready step from durable state", {
        stepId: recovered.activeStep?.id ?? null,
        state: afterState
      });
    }
    return recovered;
  }

  async finish(
    runId: string,
    status: NonNullable<AgentRun["finalStatus"]>,
    message: string
  ): Promise<RunView> {
    const run = this.requireRun(runId);
    const target: AgentRun["state"] =
      status === "success"
        ? "SUCCESS"
        : status === "cancelled"
          ? "CANCELLED"
          : status === "failed"
            ? "FAILED"
            : "BLOCKED";
    if (run.state !== target) await this.transition(run, target, message);
    run.finalStatus = status;
    run.completedAt = new Date().toISOString();
    this.database.updateRun(run);
    return this.get(runId);
  }

  reportDirectory(runId: string): string {
    return this.requireReportDirectory(runId);
  }

  restore(workspaceAnalyses: Map<string, WorkspaceAnalysis> = new Map()): AgentRun[] {
    for (const [runId, analysis] of workspaceAnalyses) this.analyses.set(runId, analysis);
    const activeRuns = this.database
      .listRuns()
      .filter((run) => !["SUCCESS", "FAILED", "CANCELLED"].includes(run.state));
    for (const run of activeRuns) {
      if (this.stepPlans.plan(run.id)) this.recoverStepExecution(run.id);
    }
    return activeRuns;
  }

  private async createRevision(run: AgentRun, analysis: WorkspaceAnalysis): Promise<void> {
    await this.transition(run, "PROMPT_REVISION", "Generating improved specification");
    const revision = this.reviewer.revise(
      run.originalPrompt,
      analysis,
      this.database.questions(run.id),
      this.database.revisions(run.id).length + 1
    );
    this.database.saveRevision(run.id, revision);
    await this.transition(run, "AWAITING_APPROVAL", "Improved specification ready for approval");
  }

  private async transition(
    run: AgentRun,
    state: AgentRun["state"],
    message: string,
    evidence?: Record<string, unknown>
  ): Promise<void> {
    run.state = WorkflowStateMachine.transition(run.state, state);
    this.database.updateRun(run);
    const event: TimelineEvent = {
      runId: run.id,
      operationId: randomUUID(),
      timestamp: new Date().toISOString(),
      state,
      status:
        state === "FAILED" || state === "BLOCKED"
          ? (state.toLowerCase() as "failed" | "blocked")
          : state === "CANCELLED"
            ? "failed"
            : "passed",
      message,
      ...(evidence ? { evidence } : {})
    };
    this.database.addEvent(event);
  }

  private recordStepEvent(run: AgentRun, message: string, evidence: Record<string, unknown>): void {
    this.database.addEvent({
      runId: run.id,
      operationId: randomUUID(),
      timestamp: new Date().toISOString(),
      state: run.state,
      status: "passed",
      message,
      evidence
    });
  }

  private requireRun(runId: string): AgentRun {
    const run = this.database.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }

  private requireAnalysis(runId: string): WorkspaceAnalysis {
    const analysis = this.analyses.get(runId);
    if (!analysis) throw new Error("Workspace analysis unavailable; refresh the workspace");
    return analysis;
  }

  private requireReportDirectory(runId: string): string {
    const directory = this.reportDirectories.get(runId);
    if (!directory) throw new Error("Run report directory unavailable");
    return directory;
  }
}
