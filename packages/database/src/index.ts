import { DatabaseSync } from "node:sqlite";
import type { AgentRun, PromptRevision, Question, TimelineEvent, RoutingStrategy, RoutingDecision, StrategySimulation } from "@agent/shared";
import type {
  BudgetConfig,
  DiscoveredModel,
  ProviderConfiguration,
  RoutingConfig
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
   );`,
  `CREATE TABLE IF NOT EXISTS clarification_questions(
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, text TEXT NOT NULL,
    question_type TEXT NOT NULL, priority TEXT NOT NULL,
    repository_evidence_json TEXT, assumptions_json TEXT,
    rejected_interpretations_json TEXT, remaining_uncertainty TEXT,
    answered_at TEXT, answer TEXT, payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES runs(id)
   );
   CREATE TABLE IF NOT EXISTS prompt_revision_hashes(
    run_id TEXT NOT NULL, revision INTEGER NOT NULL, revision_id TEXT NOT NULL,
    prompt_hash TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(run_id, revision), FOREIGN KEY(run_id) REFERENCES runs(id)
   );
   CREATE TABLE IF NOT EXISTS approval_events(
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, revision INTEGER NOT NULL,
    revision_id TEXT NOT NULL, prompt_hash TEXT NOT NULL,
    approved_by TEXT NOT NULL DEFAULT 'user', occurred_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES runs(id)
   );
   CREATE TABLE IF NOT EXISTS change_analyses(
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, suggestion_id TEXT NOT NULL,
    suggestion TEXT NOT NULL, current_content TEXT NOT NULL,
    classification TEXT NOT NULL, action TEXT NOT NULL,
    explanation TEXT NOT NULL, proposed_alternative TEXT,
    invalidates_approval INTEGER NOT NULL DEFAULT 0,
    new_questions_json TEXT, effects_json TEXT, created_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES runs(id)
   );`,
  `CREATE TABLE IF NOT EXISTS strategies(
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
    version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
    scope TEXT NOT NULL DEFAULT 'global', project_path_reference TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, activated_at TEXT,
    archived_at TEXT, created_by TEXT NOT NULL DEFAULT 'user',
    based_on_strategy_id TEXT, generation_metadata_json TEXT,
    objective_json TEXT NOT NULL, budgets_json TEXT NOT NULL,
    context_policy_json TEXT NOT NULL, retry_policy_json TEXT NOT NULL,
    parallel_policy_json TEXT NOT NULL, privacy_policy_json TEXT NOT NULL,
    verification_policy_json TEXT NOT NULL, release_policy_json TEXT NOT NULL,
    roles_json TEXT NOT NULL DEFAULT '{}',
    escalation_rules_json TEXT NOT NULL DEFAULT '[]',
    CHECK(status IN ('draft', 'active', 'archived')),
    CHECK(scope IN ('global', 'project')),
    CHECK(created_by IN ('user', 'ai', 'migration', 'system'))
   );
   CREATE TABLE IF NOT EXISTS strategy_versions(
    strategy_id TEXT NOT NULL, version INTEGER NOT NULL, payload_json TEXT NOT NULL,
    PRIMARY KEY(strategy_id, version), FOREIGN KEY(strategy_id) REFERENCES strategies(id)
   );
   CREATE TABLE IF NOT EXISTS strategy_activations(
    id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, version INTEGER NOT NULL,
    activated_at TEXT NOT NULL, activated_by TEXT NOT NULL DEFAULT 'user',
    previous_strategy_id TEXT, previous_version INTEGER,
    reason TEXT, FOREIGN KEY(strategy_id) REFERENCES strategies(id)
   );
   CREATE INDEX IF NOT EXISTS idx_strategy_status ON strategies(status);
   CREATE INDEX IF NOT EXISTS idx_strategy_scope ON strategies(scope);
   CREATE INDEX IF NOT EXISTS idx_strategy_created ON strategies(created_at DESC);
   CREATE INDEX IF NOT EXISTS idx_strategy_activations_strategy ON strategy_activations(strategy_id);`,
  `CREATE TABLE IF NOT EXISTS strategy_simulations(
    id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, created_at TEXT NOT NULL,
    task_samples_json TEXT NOT NULL, results_json TEXT NOT NULL,
    average_estimated_cost REAL, total_estimated_cost REAL,
    average_latency_ms INTEGER, warnings_json TEXT NOT NULL DEFAULT '[]',
    FOREIGN KEY(strategy_id) REFERENCES strategies(id)
   );
   CREATE TABLE IF NOT EXISTS routing_decision_evidence(
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL, strategy_version INTEGER NOT NULL,
    decision_json TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(strategy_id) REFERENCES strategies(id),
    FOREIGN KEY(run_id) REFERENCES runs(id)
   );
   CREATE TABLE IF NOT EXISTS budget_ledger(
    id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, run_id TEXT,
    ledger_type TEXT NOT NULL, amount_usd REAL NOT NULL, reason TEXT,
    provider_id TEXT, model_id TEXT, occurred_at TEXT NOT NULL,
    FOREIGN KEY(strategy_id) REFERENCES strategies(id),
    FOREIGN KEY(run_id) REFERENCES runs(id),
    CHECK(ledger_type IN ('reserve', 'charge', 'refund', 'adjustment'))
   );
   CREATE TABLE IF NOT EXISTS cost_reservations(
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, strategy_id TEXT NOT NULL,
    amount_usd REAL NOT NULL, reason TEXT, reserved_at TEXT NOT NULL,
    released_at TEXT, status TEXT NOT NULL DEFAULT 'active',
    FOREIGN KEY(run_id) REFERENCES runs(id),
    FOREIGN KEY(strategy_id) REFERENCES strategies(id),
   CHECK(status IN ('active', 'released', 'consumed'))
   );
   CREATE INDEX IF NOT EXISTS idx_budget_ledger_strategy ON budget_ledger(strategy_id);
   CREATE INDEX IF NOT EXISTS idx_cost_reservations_run ON cost_reservations(run_id);`,
  `ALTER TABLE provider_models ADD COLUMN supports_repository_write INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX IF NOT EXISTS idx_provider_models_repo_write ON provider_models(supports_repository_write);`
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
      .prepare("INSERT OR REPLACE INTO provider_models VALUES(?,?,?,?)")
      .run(
        model.providerId,
        model.modelId,
        JSON.stringify(model),
        model.supportsRepositoryWrite ? 1 : 0
      );
  }

  modelSupportsRepositoryWrite(providerId: string, modelId: string): boolean {
    const result = this.raw
      .prepare("SELECT supports_repository_write FROM provider_models WHERE provider_id=? AND model_id=?")
      .get(providerId, modelId) as { supports_repository_write: number } | undefined;
    return result ? result.supports_repository_write === 1 : false;
  }

  modelsWithRepositoryWriteSupport(providerId?: string): Array<{ providerId: string; modelId: string }> {
    const query = providerId
      ? "SELECT provider_id, model_id FROM provider_models WHERE supports_repository_write=1 AND provider_id=?"
      : "SELECT provider_id, model_id FROM provider_models WHERE supports_repository_write=1";
    
    const results = providerId
      ? (this.raw.prepare(query).all(providerId) as Array<Record<string, unknown>>)
      : (this.raw.prepare(query).all() as Array<Record<string, unknown>>);
    
    return results.map((row) => ({
      providerId: String(row.provider_id),
      modelId: String(row.model_id)
    }));
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

  // ============================================================================
  // Strategy operations
  // ============================================================================

  saveStrategy(strategy: RoutingStrategy): void {
    this.transaction(() => {
      // Save the main strategy record
      this.raw
        .prepare(
          `INSERT OR REPLACE INTO strategies(
            id,name,description,version,status,scope,project_path_reference,
            created_at,updated_at,activated_at,archived_at,created_by,
            based_on_strategy_id,generation_metadata_json,
            objective_json,budgets_json,context_policy_json,retry_policy_json,
            parallel_policy_json,privacy_policy_json,verification_policy_json,
            release_policy_json,roles_json,escalation_rules_json
          ) VALUES(
            ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
          )`
        )
        .run(
          strategy.id,
          strategy.name,
          strategy.description,
          strategy.version,
          strategy.status,
          strategy.scope,
          strategy.projectPathReference,
          strategy.createdAt,
          strategy.updatedAt,
          strategy.activatedAt,
          strategy.archivedAt,
          strategy.createdBy,
          strategy.basedOnStrategyId,
          strategy.generationMetadata ? JSON.stringify(strategy.generationMetadata) : null,
          JSON.stringify(strategy.objective),
          JSON.stringify(strategy.budgets),
          JSON.stringify(strategy.contextPolicy),
          JSON.stringify(strategy.retryPolicy),
          JSON.stringify(strategy.parallelPolicy),
          JSON.stringify(strategy.privacyPolicy),
          JSON.stringify(strategy.verificationPolicy),
          JSON.stringify(strategy.releasePolicy),
          JSON.stringify(strategy.roles),
          JSON.stringify(strategy.escalationRules)
        );

      // Save immutable version
      this.raw
        .prepare("INSERT OR REPLACE INTO strategy_versions VALUES(?,?,?)")
        .run(strategy.id, strategy.version, JSON.stringify(strategy));
    });
  }

  strategy(id: string): RoutingStrategy | null {
    const row = this.raw.prepare("SELECT * FROM strategies WHERE id=?").get(id) as
      Record<string, unknown> | undefined;
    return row ? this.strategyFromRow(row) : null;
  }

  strategyVersion(id: string, version: number): RoutingStrategy | null {
    const row = this.raw
      .prepare("SELECT payload_json FROM strategy_versions WHERE strategy_id=? AND version=?")
      .get(id, version) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as RoutingStrategy) : null;
  }

  listStrategies(scope?: "global" | "project"): RoutingStrategy[] {
    const query = scope
      ? "SELECT * FROM strategies WHERE scope=? ORDER BY created_at DESC"
      : "SELECT * FROM strategies ORDER BY created_at DESC";
    const rows = scope
      ? (this.raw.prepare(query).all(scope) as Array<Record<string, unknown>>)
      : (this.raw.prepare(query).all() as Array<Record<string, unknown>>);
    return rows.map((row) => this.strategyFromRow(row));
  }

  activeStrategy(scope: "global" | "project" = "global"): RoutingStrategy | null {
    const row = this.raw
      .prepare("SELECT * FROM strategies WHERE scope=? AND status='active' LIMIT 1")
      .get(scope) as Record<string, unknown> | undefined;
    return row ? this.strategyFromRow(row) : null;
  }

  activateStrategy(strategy: RoutingStrategy, previousStrategyId?: string, previousVersion?: number): void {
    this.transaction(() => {
      // Deactivate previous active strategy in same scope
      this.raw
        .prepare("UPDATE strategies SET status='draft' WHERE scope=? AND status='active'")
        .run(strategy.scope);

      // Activate new strategy
      this.raw
        .prepare("UPDATE strategies SET status='active', activated_at=? WHERE id=?")
        .run(new Date().toISOString(), strategy.id);

      // Record activation event
      this.raw
        .prepare(
          "INSERT INTO strategy_activations(id,strategy_id,version,activated_at,previous_strategy_id,previous_version) VALUES(?,?,?,?,?,?)"
        )
        .run(
          `${strategy.id}-${Date.now()}`,
          strategy.id,
          strategy.version,
          new Date().toISOString(),
          previousStrategyId ?? null,
          previousVersion ?? null
        );
    });
  }

  archiveStrategy(id: string): void {
    this.raw
      .prepare("UPDATE strategies SET status='archived', archived_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
  }

  deleteStrategy(id: string): boolean {
    let deleted = false;
    this.transaction(() => {
      // Delete dependent records first
      this.raw.prepare("DELETE FROM strategy_activations WHERE strategy_id=?").run(id);
      this.raw.prepare("DELETE FROM strategy_simulations WHERE strategy_id=?").run(id);
      this.raw.prepare("DELETE FROM routing_decision_evidence WHERE strategy_id=?").run(id);
      this.raw.prepare("DELETE FROM budget_ledger WHERE strategy_id=?").run(id);
      this.raw.prepare("DELETE FROM cost_reservations WHERE strategy_id=?").run(id);
      
      // Delete strategy versions
      this.raw.prepare("DELETE FROM strategy_versions WHERE strategy_id=?").run(id);
      
      // Delete the strategy itself
      deleted = this.raw.prepare("DELETE FROM strategies WHERE id=?").run(id).changes > 0;
    });
    return deleted;
  }

  saveSimulation(simulation: StrategySimulation): void {
    this.raw
      .prepare(
        `INSERT OR REPLACE INTO strategy_simulations(
          id,strategy_id,created_at,task_samples_json,results_json,
          average_estimated_cost,total_estimated_cost,average_latency_ms,warnings_json
        ) VALUES(?,?,?,?,?,?,?,?,?)`
      )
      .run(
        simulation.id,
        simulation.strategyId,
        simulation.createdAt,
        JSON.stringify(simulation.taskSamples),
        JSON.stringify(simulation.results),
        simulation.averageEstimatedCost ?? null,
        simulation.totalEstimatedCost ?? null,
        simulation.averageLatencyMs ?? null,
        JSON.stringify(simulation.warnings)
      );
  }

  simulation(id: string): StrategySimulation | null {
    const row = this.raw
      .prepare("SELECT * FROM strategy_simulations WHERE id=?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      strategyId: String(row.strategy_id),
      createdAt: String(row.created_at),
      taskSamples: JSON.parse(String(row.task_samples_json)),
      results: JSON.parse(String(row.results_json)),
      averageEstimatedCost: row.average_estimated_cost ? Number(row.average_estimated_cost) : null,
      totalEstimatedCost: row.total_estimated_cost ? Number(row.total_estimated_cost) : null,
      averageLatencyMs: row.average_latency_ms ? Number(row.average_latency_ms) : null,
      warnings: JSON.parse(String(row.warnings_json))
    };
  }

  saveRoutingDecisionEvidence(
    runId: string,
    taskId: string,
    strategyId: string,
    strategyVersion: number,
    decision: RoutingDecision
  ): void {
    this.raw
      .prepare(
        `INSERT OR REPLACE INTO routing_decision_evidence(
          id,run_id,task_id,strategy_id,strategy_version,decision_json,created_at
        ) VALUES(?,?,?,?,?,?,?)`
      )
      .run(
        `${runId}-${taskId}`,
        runId,
        taskId,
        strategyId,
        strategyVersion,
        JSON.stringify(decision),
        new Date().toISOString()
      );
  }

  routingDecisionEvidence(runId: string, taskId: string): RoutingDecision | null {
    const row = this.raw
      .prepare("SELECT decision_json FROM routing_decision_evidence WHERE run_id=? AND task_id=?")
      .get(runId, taskId) as { decision_json: string } | undefined;
    return row ? (JSON.parse(row.decision_json) as RoutingDecision) : null;
  }

  recordBudgetLedgerEntry(input: {
    strategyId: string;
    runId?: string;
    type: "reserve" | "charge" | "refund" | "adjustment";
    amountUsd: number;
    reason?: string;
    providerId?: string;
    modelId?: string;
  }): void {
    this.raw
      .prepare(
        `INSERT INTO budget_ledger(id,strategy_id,run_id,ledger_type,amount_usd,reason,provider_id,model_id,occurred_at)
         VALUES(?,?,?,?,?,?,?,?,?)`
      )
      .run(
        `ledger-${Date.now()}-${Math.random()}`,
        input.strategyId,
        input.runId ?? null,
        input.type,
        input.amountUsd,
        input.reason ?? null,
        input.providerId ?? null,
        input.modelId ?? null,
        new Date().toISOString()
      );
  }

  budgetLedger(strategyId: string): Array<{
    id: string;
    type: string;
    amountUsd: number;
    reason: string | null;
    occurredAt: string;
  }> {
    return (
      this.raw
        .prepare("SELECT id, ledger_type, amount_usd, reason, occurred_at FROM budget_ledger WHERE strategy_id=? ORDER BY occurred_at DESC")
        .all(strategyId) as Array<Record<string, unknown>>
    ).map((row) => ({
      id: String(row.id),
      type: String(row.ledger_type),
      amountUsd: Number(row.amount_usd),
      reason: row.reason ? String(row.reason) : null,
      occurredAt: String(row.occurred_at)
    }));
  }

  reserveBudget(input: { runId: string; strategyId: string; amountUsd: number; reason?: string }): string {
    const id = `reserve-${Date.now()}-${Math.random()}`;
    this.raw
      .prepare(
        `INSERT INTO cost_reservations(id,run_id,strategy_id,amount_usd,reason,reserved_at,status)
         VALUES(?,?,?,?,?,?,?)`
      )
      .run(id, input.runId, input.strategyId, input.amountUsd, input.reason ?? null, new Date().toISOString(), "active");
    return id;
  }

  releaseBudgetReservation(reservationId: string): void {
    this.raw
      .prepare("UPDATE cost_reservations SET released_at=?, status='released' WHERE id=?")
      .run(new Date().toISOString(), reservationId);
  }

  consumeBudgetReservation(reservationId: string): void {
    this.raw
      .prepare("UPDATE cost_reservations SET status='consumed' WHERE id=?")
      .run(reservationId);
  }

  activeBudgetReservations(runId: string): Array<{ id: string; amountUsd: number }> {
    return (
      this.raw
        .prepare("SELECT id, amount_usd FROM cost_reservations WHERE run_id=? AND status='active' ORDER BY reserved_at DESC")
        .all(runId) as Array<Record<string, unknown>>
    ).map((row) => ({
      id: String(row.id),
      amountUsd: Number(row.amount_usd)
    }));
  }

  private strategyFromRow(row: Record<string, unknown>): RoutingStrategy {
    return {
      id: String(row.id),
      name: String(row.name),
      description: row.description ? String(row.description) : "",
      version: Number(row.version),
      status: String(row.status) as RoutingStrategy["status"],
      scope: String(row.scope) as RoutingStrategy["scope"],
      projectPathReference: row.project_path_reference ? String(row.project_path_reference) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      activatedAt: row.activated_at ? String(row.activated_at) : null,
      archivedAt: row.archived_at ? String(row.archived_at) : null,
      createdBy: String(row.created_by) as RoutingStrategy["createdBy"],
      basedOnStrategyId: row.based_on_strategy_id ? String(row.based_on_strategy_id) : null,
      generationMetadata: row.generation_metadata_json
        ? (JSON.parse(String(row.generation_metadata_json)) as RoutingStrategy["generationMetadata"])
        : null,
      objective: JSON.parse(String(row.objective_json)),
      budgets: JSON.parse(String(row.budgets_json)),
      contextPolicy: JSON.parse(String(row.context_policy_json)),
      retryPolicy: JSON.parse(String(row.retry_policy_json)),
      parallelPolicy: JSON.parse(String(row.parallel_policy_json)),
      privacyPolicy: JSON.parse(String(row.privacy_policy_json)),
      verificationPolicy: JSON.parse(String(row.verification_policy_json)),
      releasePolicy: JSON.parse(String(row.release_policy_json)),
      roles: JSON.parse(String(row.roles_json)),
      escalationRules: JSON.parse(String(row.escalation_rules_json))
    };
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
