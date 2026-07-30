import { DatabaseSync } from "node:sqlite";
import type { AgentRun, PromptRevision, Question, TimelineEvent } from "@agent/shared";
import type {
  BudgetConfig,
  DiscoveredModel,
  ProviderConfiguration,
  RoutingConfig,
  RoutingDecision
} from "@agent/ai";

const migrations = [
  `CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS runs(
     id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, repository_identity TEXT, starting_commit TEXT,
     state TEXT NOT NULL, final_status TEXT, original_prompt TEXT NOT NULL, approved_prompt TEXT,
     approved_revision INTEGER, created_at TEXT NOT NULL, approved_at TEXT, completed_at TEXT,
     retry_count INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE IF NOT EXISTS prompt_revisions(
     run_id TEXT NOT NULL, revision INTEGER NOT NULL, payload_json TEXT NOT NULL,
     PRIMARY KEY(run_id, revision), FOREIGN KEY(run_id) REFERENCES runs(id)
   );
   CREATE TABLE IF NOT EXISTS questions(
     run_id TEXT NOT NULL, id TEXT NOT NULL, payload_json TEXT NOT NULL,
     PRIMARY KEY(run_id, id), FOREIGN KEY(run_id) REFERENCES runs(id)
   );
   CREATE TABLE IF NOT EXISTS operations(
     operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, state TEXT NOT NULL, tool TEXT NOT NULL,
     input_summary TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, exit_code INTEGER,
     status TEXT NOT NULL, log_path TEXT, artifact_path TEXT, error_signature TEXT
   );
   CREATE TABLE IF NOT EXISTS tests(
     id TEXT PRIMARY KEY, run_id TEXT NOT NULL, criterion TEXT NOT NULL, type TEXT NOT NULL,
     command TEXT NOT NULL, result TEXT NOT NULL, duration_ms INTEGER NOT NULL,
     artifact TEXT, coverage_json TEXT
   );
   CREATE TABLE IF NOT EXISTS github_runs(
     run_id TEXT PRIMARY KEY, issue_number INTEGER, branch TEXT, pull_request INTEGER,
     workflow_runs_json TEXT, merge_commit TEXT, release_id TEXT, release_tag TEXT
   );
   CREATE TABLE IF NOT EXISTS deployments(
     id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, environment TEXT NOT NULL,
     artifact TEXT, commit_sha TEXT, started_at TEXT, ended_at TEXT, result TEXT,
     health_result TEXT, rollback_status TEXT
   );
   CREATE TABLE IF NOT EXISTS timeline(
     operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, payload_json TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS providers(
     id TEXT PRIMARY KEY, type TEXT NOT NULL, display_name TEXT NOT NULL, enabled INTEGER NOT NULL,
     base_url TEXT NOT NULL, non_secret_json TEXT NOT NULL, secret_reference_json TEXT,
     health_state TEXT NOT NULL DEFAULT 'not_configured', last_test_at TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS provider_models(
     provider_id TEXT NOT NULL, model_id TEXT NOT NULL, payload_json TEXT NOT NULL,
     PRIMARY KEY(provider_id, model_id), FOREIGN KEY(provider_id) REFERENCES providers(id) ON DELETE CASCADE
   );
   CREATE TABLE IF NOT EXISTS routing_policies(
     id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS budget_policies(
     id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS model_usage(
     id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, provider_id TEXT NOT NULL,
     model_id TEXT NOT NULL, input_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER,
     reasoning_tokens INTEGER, estimated_cost REAL, actual_cost REAL, latency_ms INTEGER NOT NULL,
     occurred_at TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS model_performance(
     id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
     task_category TEXT NOT NULL, success INTEGER NOT NULL, failure_type TEXT, cost REAL,
     latency_ms INTEGER NOT NULL, retry_count INTEGER NOT NULL, occurred_at TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS parallel_tasks(
     task_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_task TEXT, dependencies_json TEXT NOT NULL,
     worker TEXT, provider_id TEXT, model_id TEXT, worktree TEXT, file_ownership_json TEXT NOT NULL,
     state TEXT NOT NULL, result_json TEXT
   );
   CREATE TABLE IF NOT EXISTS evidence(
     id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, claim TEXT NOT NULL,
     evidence_type TEXT NOT NULL, locator TEXT NOT NULL, content_hash TEXT,
     verification_state TEXT NOT NULL, payload_json TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS routing_decisions(
     task_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, payload_json TEXT NOT NULL
   );`
];

export class AgentDatabase {
  readonly raw: DatabaseSync;

  constructor(path = ":memory:") {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
    );
    const applied = this.raw
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    for (const [index, sql] of migrations.entries()) {
      const version = index + 1;
      if (!applied.some((entry) => entry.version === version)) {
        this.transaction(() => {
          this.raw.exec(sql);
          this.raw
            .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
            .run(version, new Date().toISOString());
        });
      }
    }
  }

  createRun(run: AgentRun): void {
    this.raw
      .prepare(
        `INSERT INTO runs VALUES(
          @id,@workspacePath,@repositoryIdentity,@startingCommit,@state,@finalStatus,@originalPrompt,
          @approvedPrompt,@approvedRevision,@createdAt,@approvedAt,@completedAt,@retryCount)`
      )
      .run(run);
  }

  updateRun(run: AgentRun): void {
    this.raw
      .prepare(
        `UPDATE runs SET state=@state, final_status=@finalStatus, approved_prompt=@approvedPrompt,
         approved_revision=@approvedRevision, approved_at=@approvedAt, completed_at=@completedAt,
         retry_count=@retryCount, repository_identity=@repositoryIdentity,
         starting_commit=@startingCommit WHERE id=@id`
      )
      .run({
        id: run.id,
        state: run.state,
        finalStatus: run.finalStatus,
        approvedPrompt: run.approvedPrompt,
        approvedRevision: run.approvedRevision,
        approvedAt: run.approvedAt,
        completedAt: run.completedAt,
        retryCount: run.retryCount,
        repositoryIdentity: run.repositoryIdentity,
        startingCommit: run.startingCommit
      });
  }

  getRun(id: string): AgentRun | null {
    const row = this.raw.prepare("SELECT * FROM runs WHERE id=?").get(id) as
      Record<string, unknown> | undefined;
    return row ? mapRun(row) : null;
  }

  listRuns(): AgentRun[] {
    return (
      this.raw.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as Array<
        Record<string, unknown>
      >
    ).map(mapRun);
  }

  saveRevision(runId: string, revision: PromptRevision): void {
    this.raw
      .prepare("INSERT OR REPLACE INTO prompt_revisions VALUES(?,?,?)")
      .run(runId, revision.revision, JSON.stringify(revision));
  }

  revisions(runId: string): PromptRevision[] {
    return (
      this.raw
        .prepare("SELECT payload_json FROM prompt_revisions WHERE run_id=? ORDER BY revision")
        .all(runId) as Array<{ payload_json: string }>
    ).map((row) => JSON.parse(row.payload_json) as PromptRevision);
  }

  saveQuestion(runId: string, question: Question): void {
    this.raw
      .prepare("INSERT OR REPLACE INTO questions VALUES(?,?,?)")
      .run(runId, question.id, JSON.stringify(question));
  }

  questions(runId: string): Question[] {
    return (
      this.raw.prepare("SELECT payload_json FROM questions WHERE run_id=?").all(runId) as Array<{
        payload_json: string;
      }>
    ).map((row) => JSON.parse(row.payload_json) as Question);
  }

  addEvent(event: TimelineEvent): void {
    this.raw
      .prepare("INSERT OR REPLACE INTO timeline VALUES(?,?,?)")
      .run(event.operationId, event.runId, JSON.stringify(event));
  }

  events(runId: string): TimelineEvent[] {
    return (
      this.raw.prepare("SELECT payload_json FROM timeline WHERE run_id=?").all(runId) as Array<{
        payload_json: string;
      }>
    ).map((row) => JSON.parse(row.payload_json) as TimelineEvent);
  }

  saveProvider(configuration: ProviderConfiguration, healthState = "not_configured"): void {
    const { secretReference, ...nonSecret } = configuration;
    this.raw
      .prepare(
        `INSERT INTO providers(
          id,type,display_name,enabled,base_url,non_secret_json,secret_reference_json,
          health_state,last_test_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET type=excluded.type,display_name=excluded.display_name,
          enabled=excluded.enabled,base_url=excluded.base_url,non_secret_json=excluded.non_secret_json,
          secret_reference_json=excluded.secret_reference_json,health_state=excluded.health_state,
          updated_at=excluded.updated_at`
      )
      .run(
        configuration.id,
        configuration.type,
        configuration.displayName,
        configuration.enabled ? 1 : 0,
        configuration.baseUrl,
        JSON.stringify(nonSecret),
        secretReference ? JSON.stringify(secretReference) : null,
        healthState,
        null,
        configuration.createdAt,
        configuration.updatedAt
      );
  }

  provider(id: string): ProviderConfiguration | null {
    const row = this.raw.prepare("SELECT * FROM providers WHERE id=?").get(id) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return providerFromRow(row);
  }

  providers(): ProviderConfiguration[] {
    return (
      this.raw.prepare("SELECT * FROM providers ORDER BY display_name").all() as Array<
        Record<string, unknown>
      >
    ).map(providerFromRow);
  }

  deleteProvider(id: string): boolean {
    return this.raw.prepare("DELETE FROM providers WHERE id=?").run(id).changes > 0;
  }

  saveModels(providerId: string, models: DiscoveredModel[]): void {
    this.transaction(() => {
      for (const model of models) {
        this.raw
          .prepare("INSERT OR REPLACE INTO provider_models VALUES(?,?,?)")
          .run(providerId, model.modelId, JSON.stringify(model));
      }
      this.raw
        .prepare(
          `UPDATE provider_models SET payload_json=json_set(payload_json,'$.available',json('false'))
           WHERE provider_id=? AND model_id NOT IN (${models.map(() => "?").join(",") || "''"})`
        )
        .run(providerId, ...models.map((model) => model.modelId));
    });
  }

  models(providerId?: string): DiscoveredModel[] {
    const rows = providerId
      ? (this.raw
          .prepare("SELECT payload_json FROM provider_models WHERE provider_id=? ORDER BY model_id")
          .all(providerId) as Array<{ payload_json: string }>)
      : (this.raw
          .prepare("SELECT payload_json FROM provider_models ORDER BY provider_id,model_id")
          .all() as Array<{ payload_json: string }>);
    return rows.map((row) => JSON.parse(row.payload_json) as DiscoveredModel);
  }

  saveModel(model: DiscoveredModel): void {
    this.raw
      .prepare("INSERT OR REPLACE INTO provider_models VALUES(?,?,?)")
      .run(model.providerId, model.modelId, JSON.stringify(model));
  }

  saveRoutingConfig(config: RoutingConfig): void {
    this.savePolicy("routing_policies", "default", config);
  }

  routingConfig(): RoutingConfig | null {
    return this.readPolicy("routing_policies", "default") as RoutingConfig | null;
  }

  saveBudgetConfig(config: BudgetConfig): void {
    this.savePolicy("budget_policies", "default", config);
  }

  budgetConfig(): BudgetConfig | null {
    return this.readPolicy("budget_policies", "default") as BudgetConfig | null;
  }

  saveRoutingDecision(runId: string, taskId: string, decision: RoutingDecision): void {
    this.raw
      .prepare("INSERT OR REPLACE INTO routing_decisions VALUES(?,?,?)")
      .run(taskId, runId, JSON.stringify(decision));
  }

  routingDecision(taskId: string): RoutingDecision | null {
    const row = this.raw
      .prepare("SELECT payload_json FROM routing_decisions WHERE task_id=?")
      .get(taskId) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as RoutingDecision) : null;
  }

  saveEvidence(input: {
    id: string;
    runId: string;
    taskId: string;
    claim: string;
    evidenceType: string;
    locator: string;
    contentHash: string | null;
    verificationState: string;
    payload: unknown;
  }): void {
    this.raw
      .prepare(
        "INSERT OR REPLACE INTO evidence VALUES(@id,@runId,@taskId,@claim,@evidenceType,@locator,@contentHash,@verificationState,@payloadJson)"
      )
      .run({
        id: input.id,
        runId: input.runId,
        taskId: input.taskId,
        claim: input.claim,
        evidenceType: input.evidenceType,
        locator: input.locator,
        contentHash: input.contentHash,
        verificationState: input.verificationState,
        payloadJson: JSON.stringify(input.payload)
      });
  }

  evidence(taskId: string): Array<Record<string, unknown>> {
    return this.raw.prepare("SELECT * FROM evidence WHERE task_id=? ORDER BY id").all(taskId);
  }

  recordUsage(input: {
    id: string;
    runId: string;
    taskId: string;
    providerId: string;
    modelId: string;
    inputTokens: number | null;
    cachedTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    estimatedCost: number | null;
    actualCost: number | null;
    latencyMs: number;
    occurredAt: string;
  }): void {
    this.raw
      .prepare(
        "INSERT INTO model_usage VALUES(@id,@runId,@taskId,@providerId,@modelId,@inputTokens,@cachedTokens,@outputTokens,@reasoningTokens,@estimatedCost,@actualCost,@latencyMs,@occurredAt)"
      )
      .run(input);
  }

  recordModelPerformance(input: {
    providerId: string;
    modelId: string;
    taskCategory: string;
    success: boolean;
    failureType: string | null;
    cost: number | null;
    latencyMs: number;
    retryCount: number;
    occurredAt?: string;
  }): void {
    this.raw
      .prepare(
        `INSERT INTO model_performance(
          provider_id,model_id,task_category,success,failure_type,cost,latency_ms,retry_count,occurred_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`
      )
      .run(
        input.providerId,
        input.modelId,
        input.taskCategory,
        Number(input.success),
        input.failureType,
        input.cost,
        input.latencyMs,
        input.retryCount,
        input.occurredAt ?? new Date().toISOString()
      );
  }

  performanceSummary(): Record<
    string,
    { samples: number; successRate: number; averageLatencyMs: number }
  > {
    const rows = this.raw
      .prepare(
        `SELECT provider_id,model_id,COUNT(*) samples,AVG(success) success_rate,
                AVG(latency_ms) average_latency
         FROM model_performance GROUP BY provider_id,model_id`
      )
      .all();
    return Object.fromEntries(
      rows.map((row) => [
        `${String(row.provider_id)}:${String(row.model_id)}`,
        {
          samples: Number(row.samples),
          successRate: Number(row.success_rate),
          averageLatencyMs: Number(row.average_latency)
        }
      ])
    );
  }

  usage(runId?: string): Array<Record<string, unknown>> {
    return runId
      ? this.raw.prepare("SELECT * FROM model_usage WHERE run_id=?").all(runId)
      : this.raw.prepare("SELECT * FROM model_usage").all();
  }

  private savePolicy(
    table: "routing_policies" | "budget_policies",
    id: string,
    value: unknown
  ): void {
    this.raw
      .prepare(`INSERT OR REPLACE INTO ${table} VALUES(?,?,?)`)
      .run(id, JSON.stringify(value), new Date().toISOString());
  }

  private readPolicy(table: "routing_policies" | "budget_policies", id: string): unknown {
    const row = this.raw.prepare(`SELECT payload_json FROM ${table} WHERE id=?`).get(id) as
      { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as unknown) : null;
  }

  private transaction(operation: () => void): void {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }
}

function mapRun(row: Record<string, unknown>): AgentRun {
  return {
    id: String(row.id),
    workspacePath: String(row.workspace_path),
    repositoryIdentity: row.repository_identity ? String(row.repository_identity) : null,
    startingCommit: row.starting_commit ? String(row.starting_commit) : null,
    state: String(row.state) as AgentRun["state"],
    finalStatus: row.final_status ? (String(row.final_status) as AgentRun["finalStatus"]) : null,
    originalPrompt: String(row.original_prompt),
    approvedPrompt: row.approved_prompt ? String(row.approved_prompt) : null,
    approvedRevision: row.approved_revision === null ? null : Number(row.approved_revision),
    createdAt: String(row.created_at),
    approvedAt: row.approved_at ? String(row.approved_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    retryCount: Number(row.retry_count)
  };
}

function providerFromRow(row: Record<string, unknown>): ProviderConfiguration {
  const nonSecret = JSON.parse(String(row.non_secret_json)) as Omit<
    ProviderConfiguration,
    "secretReference"
  >;
  return {
    ...nonSecret,
    secretReference: row.secret_reference_json
      ? (JSON.parse(String(row.secret_reference_json)) as ProviderConfiguration["secretReference"])
      : null
  };
}
