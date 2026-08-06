import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentDatabase } from "@agent/database";

describe("Phase 1 to Phase 2 database migration", () => {
  it("preserves existing runs while adding provider orchestration tables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-migration-"));
    const path = join(directory, "phase1.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES(1, '2026-01-01T00:00:00.000Z');
      CREATE TABLE runs(
        id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, repository_identity TEXT, starting_commit TEXT,
        state TEXT NOT NULL, final_status TEXT, original_prompt TEXT NOT NULL, approved_prompt TEXT,
        approved_revision INTEGER, created_at TEXT NOT NULL, approved_at TEXT, completed_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE prompt_revisions(run_id TEXT NOT NULL, revision INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(run_id, revision));
      CREATE TABLE questions(run_id TEXT NOT NULL, id TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(run_id, id));
      CREATE TABLE operations(operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, state TEXT NOT NULL, tool TEXT NOT NULL, input_summary TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, exit_code INTEGER, status TEXT NOT NULL, log_path TEXT, artifact_path TEXT, error_signature TEXT);
      CREATE TABLE tests(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, criterion TEXT NOT NULL, type TEXT NOT NULL, command TEXT NOT NULL, result TEXT NOT NULL, duration_ms INTEGER NOT NULL, artifact TEXT, coverage_json TEXT);
      CREATE TABLE github_runs(run_id TEXT PRIMARY KEY, issue_number INTEGER, branch TEXT, pull_request INTEGER, workflow_runs_json TEXT, merge_commit TEXT, release_id TEXT, release_tag TEXT);
      CREATE TABLE deployments(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, environment TEXT NOT NULL, artifact TEXT, commit_sha TEXT, started_at TEXT, ended_at TEXT, result TEXT, health_result TEXT, rollback_status TEXT);
      CREATE TABLE timeline(operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, payload_json TEXT NOT NULL);
    `);
    old
      .prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        "legacy-run",
        "C:\\repo",
        null,
        null,
        "AWAITING_APPROVAL",
        null,
        "Legacy prompt",
        null,
        null,
        "2026-01-01T00:00:00.000Z",
        null,
        null,
        0
      );
    old.close();

    const migrated = new AgentDatabase(path);
    expect(migrated.getRun("legacy-run")).toMatchObject({
      id: "legacy-run",
      originalPrompt: "Legacy prompt",
      state: "AWAITING_APPROVAL"
    });
    const tables = migrated.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "providers",
        "provider_models",
        "model_usage",
        "parallel_tasks",
        "evidence",
        "routing_decisions"
      ])
    );
    expect(
      migrated.raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }]);
    migrated.close();
  });
});
