# Architecture

## Process and trust boundaries

The Electron renderer is an unprivileged React application. It has context isolation and renderer
sandboxing enabled, Node integration disabled, a restrictive Content Security Policy, navigation
blocked, and only three preload calls: load the local daemon connection, select a folder, and open a
local path. It cannot execute commands, read arbitrary files, reach secrets, start Codex, invoke Git,
or deploy.

The Node daemon owns privileged work. It binds only to `127.0.0.1`, uses a random port by default,
generates a 256-bit bearer token, writes connection metadata to the local application data folder,
validates every request with Zod, canonicalizes workspace paths, serializes conflicting repository
runs, redacts logs, and persists durable state in SQLite.

The VS Code extension is a bridge. It chooses the deepest workspace folder containing the active
file, supports explicit multi-root selection, reports trust state, and does not execute project code.

## Package boundaries

- `packages/shared`: runtime schemas and IPC/API domain types.
- `packages/database`: migrations and repositories for runs, revisions, questions, operations,
  tests, GitHub data, deployments, timelines, frozen step plans, completion gates, amendments, and
  per-step evidence.
- `packages/core`: state machine, prompt review, workspace/security inspection, process/Git/GitHub
  adapters, quality gates, deployment, orchestration, and reporting.
- `packages/codex-provider`: stable provider contract, app-server client, and deterministic fake.
- `apps/daemon`, `apps/desktop`, `apps/vscode-extension`: the three runtime processes.

This is intentionally more cohesive than a package-per-class tree: security-sensitive orchestration
is kept in one audited core boundary while provider, persistence, and shared contracts remain
replaceable.

## State machine and recovery

All required states are declared in `packages/shared`. `WorkflowStateMachine` contains the explicit
transition graph; invalid jumps throw. Alignment cycles between `QUESTIONING`, `PROMPT_REVISION`, and
`AWAITING_APPROVAL`. Approval freezes the selected revision before `PREFLIGHT`. Execution then moves
through issue, worktree, implementation, validation, GitHub, deployment, versioning, and reporting
in order. Every execution state may become blocked, failed, or cancelled. A production smoke-test
failure can only enter `ROLLING_BACK`.

SQLite records the last durable state. Startup lists interrupted runs for recovery. Safe stages may
be resumed after a fresh preflight; a partially running shell or Codex turn is never assumed to have
succeeded.

`StepGatedWorkflowStateMachine` adds the explicit Phase 3 top-level sequence from plan generation
through final reporting without weakening the legacy orchestrator path while its end-to-end migration
is completed. `StepGateEngine` enforces the per-step sequence. It permits only the first incomplete
step to enter a writable state, uses a compare-and-swap update on the durable gate row, requires the
full completion gate before `STEP_COMPLETE`, and unlocks only the immediate next step. A restart
reloads the existing active per-step state; it does not infer completion or skip validation.

## Approved plans and step evidence

An approved implementation plan is a versioned, Zod-validated contract bound to a run and frozen
prompt revision. Step IDs and orders are unique and contiguous; every step has acceptance criteria,
dependencies must exist, and dependency cycles are rejected. The database persists the plan, ordered
step state, completion gates, amendments, terminal operations, runtime errors, and evidence. A gate
can complete only when every applicable criterion has passed with evidence; a later step cannot start
while any earlier step is incomplete.

`RunService` exposes the gated-run boundary: a frozen-revision-matching plan may be initialized,
then callers must provide both the expected and target per-step state to advance it. Direct gate
writes can update evidence but cannot change a step state, preventing an untrusted caller from
unlocking a later step outside the gate engine.

`TerminalSession` writes bounded, redacted runtime diagnostics; a `RuntimeCorrectionController` can
receive its completed operation, persist normalized errors and attempts, and pause the active step at
runtime-error analysis. Corrections are bounded. A repeated non-improving error becomes an explicit
independent-diagnosis blocker, while a resolved error must reference persisted focused regression
evidence before the gate can return to automated-test creation.

Run reports retain their existing flat artifacts and add a non-destructive per-step layout under
`.agent-runs/<run-id>/steps/<order>-<step-id>`. The frozen plan is recorded as both
`approved-step-plan.json` and a human-readable `approved-step-plan.md`. Initialization never
overwrites evidence already written by an interrupted or restarted run. Evidence payloads are
validated as JSON-serializable and reject token-like or credential-like content before persistence.

## Local API

The daemon exposes `GET /health` without credentials. Every `/api` route requires
`X-Agent-Token` or a Bearer token. Implemented routes cover setup status, active workspace,
run listing/detail/creation, answers, approval, rejection, cancellation, and WebSocket timelines.
Bodies are capped at 1 MB and validated.

## Data flow

1. VS Code or the folder picker publishes a trusted workspace snapshot.
2. The daemon performs bounded, read-only inspection and stores repository evidence.
3. The reviewer asks material questions and generates a repository-aware revision.
4. Rejections produce a new question keyed to the rejected interpretation; confirmed answers remain.
5. Approval timestamps and freezes the exact revision.
6. Git creates a sibling worktree and branch from the recorded commit.
7. Codex app-server receives the frozen specification with worktree cwd, workspace-write sandbox,
   and on-request approvals.
8. Structured command/file/message events become evidence; configured commands use real exit codes.
9. GitHub and deployment adapters run only when configured; reports state skipped stages explicitly.
