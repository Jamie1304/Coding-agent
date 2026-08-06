---
agent: "agent"
description: "Audit and safely repair the Personal Codex Agent repository with evidence, regression tests, and focused commits"
---

# Personal Codex Agent — Repository Audit and Repair

## Invocation inputs

- **Audit scope:** ${input:scope:Enter "full" or name a subsystem such as startup, approval, Codex, Git, database, packaging, or security. Default: full}
- **Environment limitations:** ${input:environment:Optional known limits such as non-Windows host, no credentials, or unavailable signing certificate.}
- **Additional acceptance criteria:** ${input:criteria:Optional extra requirements.}

## Role and objective

Act as a senior Windows-first full-stack engineer, QA engineer, security reviewer, and release engineer.

Audit the existing **Personal Codex Agent** repository, identify reproducible defects and inconsistencies, repair every safe in-scope Blocker, Critical, and Major finding, add regression coverage, and verify the result.

This is an audit-and-repair task. Do not expand product scope, add new providers, replace the architecture, redesign the UI, or introduce unrelated features.

## Product invariants

The following are release-blocking requirements:

1. No repository write or Codex/provider implementation turn may start before the user approves the frozen prompt revision.
2. A material prompt revision invalidates prior approval.
3. Write execution remains isolated in the documented Git worktree or stricter repository mechanism.
4. The Electron renderer remains sandboxed and cannot spawn processes, read arbitrary files, or access secrets.
5. Privileged operations remain daemon-owned, authenticated, and loopback-only.
6. GitHub and deployment remain optional and are reported as `not configured` or `skipped`, never successful, when unavailable.
7. Missing optional tools do not prevent application startup.
8. Secrets are not exposed through source, logs, errors, child-process arguments, renderer state, SQLite, reports, fixtures, or package resources.
9. Dangerous Git, GitHub, deployment, installation, and permission actions remain explicitly confirmation-gated.
10. The packaged Windows application remains the normal end-user path and must not require Node.js, npm, or terminal use after installation.

Any finding that violates an invariant is at least Critical unless it is already prevented by another independently verified control.

## Evidence and authority

Use this order of authority:

1. Executable source, configuration, migrations, and scripts.
2. Automated tests and fixtures.
3. Current repository documentation.
4. Generated repository indexes or supplied knowledge bundles.
5. Assumptions in this prompt.

Do not assume the README or generated knowledge is correct. If a supplied knowledge bundle names another project or stack, treat it as unrelated evidence and continue from the actual repository.

Do not claim runtime behavior from static inspection alone when it can be tested safely. Do not claim an optional integration works when its credentials, provider, operating system, or network dependency is unavailable.

## Mandatory repository-safety workflow

### Before editing

1. Run `git status --short`.
2. Record the current branch, HEAD commit, and recent relevant history.
3. Identify and protect all pre-existing uncommitted user changes.
4. Inspect the repository tree before assuming the architecture described in documentation.
5. Inspect package/workspace manifests, TypeScript and Electron configuration, database/migration configuration, test configuration, build/packaging scripts, and CI workflows.
6. Map the renderer, preload, Electron main process, daemon, typed API, database, adapters, VS Code bridge, setup/doctor flow, quality gates, evidence reports, and release packaging to actual files.
7. Determine which validation commands truly exist. Do not blindly run or document scripts absent from the repository; record missing expected scripts as findings.
8. Establish a baseline before modifying files.

Never use destructive Git commands. Never discard, revert, overwrite, stage, or commit unrelated user changes. Never amend, squash, force-push, or rewrite commits unless explicitly authorized.

### Baseline execution

Run the broadest practical declared checks from the repository root, starting with low-cost static checks and targeted tests. Typical candidates include:

- Formatting or format-check.
- Lint.
- Type checking.
- Unit tests.
- Integration tests.
- End-to-end tests.
- Security tests.
- Production build.
- Packaging and package verification.
- Doctor/diagnostic command, including structured output when supported.

Use the actual script names found in the repository. For every command, record:

- Exact command.
- Start state and relevant environment.
- Exit code.
- Pass, fail, or blocked.
- Failure classification: product defect, test defect, missing optional dependency, environment limitation, documentation mismatch, or unknown pending investigation.

Do not hide, suppress, weaken, or delete valid failures.

## Findings ledger

Create and maintain a ledger throughout the task. Each finding must contain:

- Stable ID.
- Severity: Blocker, Critical, Major, Minor, or Cosmetic.
- Subsystem.
- Reproduction steps or static evidence.
- Expected behavior.
- Actual behavior.
- User/security/release impact.
- Root cause.
- Proposed smallest safe fix.
- Regression-test plan.
- Status: open, fixed, blocked, accepted limitation, or false positive.
- Commit that resolves it, when fixed.

Severity guidance:

- **Blocker:** prevents startup, core execution, data safety, or release artifact creation.
- **Critical:** approval bypass, authorization failure, secret exposure, data corruption, destructive behavior, or renderer/daemon trust-boundary break.
- **Major:** primary workflow failure, serious integration breakage, persistent incorrect state, or packaging failure with a repository-owned cause.
- **Minor:** localized correctness, reliability, accessibility, diagnostic, or documentation issue.
- **Cosmetic:** wording or presentation with negligible behavioral impact.

Fix all safe in-scope Blocker, Critical, and Major findings. Fix low-risk Minor and Cosmetic findings when they do not distract from higher-severity work.

## Repair workflow

For every finding selected for repair:

1. Confirm the root cause; do not patch only the visible symptom.
2. Implement the smallest complete correction consistent with existing architecture and conventions.
3. Add or update behavior-focused regression tests.
4. Run the new or directly affected tests.
5. Run the relevant package or subsystem suite.
6. Run applicable formatting, linting, type checking, compilation, migration, security, and build checks.
7. Review the full diff and `git diff --check`.
8. Confirm only relevant files are staged.
9. Commit the logical fix.
10. Update the findings ledger and continue.

Each commit must leave the repository in a working state and use this format:

```text
<type>: <concise imperative title>

What changed:
- ...

Why:
- ...

Implementation:
- ...

Tests:
- Added or updated: ...
- Ran: ...
- Result: ...

Notes:
- ...
```

Do not combine unrelated findings in one commit. Do not create speculative refactors. Do not add dependencies unless the defect cannot be fixed safely with existing facilities.

## Audit matrix

Audit the requested scope. For a full audit, cover all sections below.

### A. Startup, lifecycle, and process cleanup

Verify development and packaged startup, including paths containing spaces and non-ASCII characters.

Check:

- Electron starts the daemon once, waits for readiness, authenticates requests, and handles startup failure.
- Port selection is race-safe, loopback-only, and released on shutdown.
- Multiple launches do not create conflicting daemons.
- Shutdown removes timers, listeners, sockets, child processes, and temporary files.
- Provider, Git, and helper child-process trees are terminated on cancellation and exit.
- Restart and interrupted-run recovery preserve consistent state.
- Uncaught exceptions and unhandled rejections are logged safely and surfaced appropriately.
- Errors are actionable rather than swallowed.

### B. Electron, preload, IPC, and daemon security

Verify:

- `contextIsolation` is enabled.
- Renderer Node integration and unsafe sandbox bypasses are disabled in production.
- Preload exposes a minimal typed API.
- IPC and daemon endpoints validate channel, method, body, enum, path, and response shape.
- Renderer input cannot construct arbitrary commands or access arbitrary files.
- Navigation, new windows, downloads, permissions, and external URLs are handled safely.
- Windows paths are normalized and confined.
- Renderer-to-daemon tokens are required, compared safely, rotated or scoped according to the design, and never logged.
- The daemon binds only to loopback and rejects invalid/missing authentication.
- Development-only exceptions do not leak into packaged builds.

### C. Renderer correctness and accessibility

Exercise every reachable screen and state in scope:

- First launch and Setup & Connections.
- Project/workspace selection and verification.
- Prompt submission, material questions, revision, freeze, approval, and execution.
- Active run, cancellation, failure, completion, history, details, diff, and evidence.
- GitHub and deployment configured, missing, skipped, failed, and retry states.
- Empty, loading, degraded, offline, and error states.

Look for ineffective buttons, stale data, race conditions, duplicate mutations, form data loss, invalid disabled states, broken navigation, misleading labels, inconsistent status/date formatting, missing retry actions, duplicate notifications, keyboard/focus problems, inaccessible names, text overflow, and development/packaged divergence.

Preserve the existing design language; fix correctness rather than redesigning.

### D. Prompt review and approval state machine

Test the complete lifecycle:

1. Incomplete request is submitted.
2. Material questions are generated and answered.
3. A revision is created and frozen.
4. The user explicitly approves the exact frozen revision.
5. Only then may worktree creation and write-capable provider execution begin.
6. Tests, diffs, status transitions, and evidence are recorded.

Verify:

- No endpoint, retry, resume, keyboard shortcut, double-click, stale browser state, recovered run, or direct daemon call bypasses approval.
- Material revisions invalidate approval.
- Frozen content is immutable or integrity-checked.
- Approval is idempotent and cannot start duplicate runs.
- Refresh/restart preserves the correct state.
- Cancellation and failure reach consistent terminal states.
- Run history, worktree, provider session, database, and evidence IDs agree.
- Resume/retry cannot duplicate repository writes.

Add explicit regression coverage for every bypass or race discovered.

### E. Typed API and error contracts

Compare renderer calls, preload types, shared types, daemon routes, validators, database models, tests, and docs.

Check for mismatched property names, enum values, optionality, date/path serialization, status codes, error shapes, success/failure response divergence, missing auth, malformed-input handling, dead endpoints, duplicate constants, and UI calls to removed endpoints.

Prefer one canonical schema and typed error model. Preserve backward compatibility or add a documented migration when a public contract must change.

### F. Codex integration

Verify against the existing architecture:

- Installation and authentication diagnostics are accurate.
- Executable resolution and Windows paths are safe.
- Child-process arguments do not use unsafe shell construction.
- App-server or structured output framing handles partial, malformed, oversized, and out-of-order messages.
- Stderr cannot corrupt protocol stdout.
- Exit codes, startup failures, timeouts, cancellation, and process-tree cleanup are correct.
- Permission and user-input requests obey the application approval model.
- Logs and evidence redact credentials and sensitive prompt/provider data according to policy.
- Run/session/worktree identifiers remain consistent.
- Missing or unauthenticated Codex degrades gracefully.

Do not replace the integration architecture unless a confirmed defect cannot be corrected locally.

### G. Git and worktrees

Use disposable repositories to test:

- Repository detection and clear non-repository behavior.
- Paths with spaces and non-ASCII characters.
- Dirty-tree policy.
- Deterministic, collision-resistant branch and worktree names.
- Concurrent-run isolation.
- Diff/staged diff/untracked/commit accuracy.
- Safe cleanup and visible cleanup failures.
- Stash, rollback, merge, rebase, cherry-pick, reset, clean, branch delete, remote removal, worktree removal, and force-push confirmations where implemented.
- Argument separation and path confinement.
- Credentials never appearing in arguments or logs.

Do not run destructive tests against the user's repository; use temporary fixtures.

### H. SQLite and persistence

Verify:

- Clean initialization and ordered migration.
- Upgrade from every supported prior schema or representative fixtures.
- Idempotency according to the repository convention.
- Correct development and packaged data paths.
- Transactions around atomic state transitions.
- Concurrency and busy/locking behavior.
- No contradictory run status or partial records after failure.
- Consistent UTC timestamps and serialization.
- Bounded long output and database growth handling.
- Actionable corruption, permission, disk-full, or inaccessible-file diagnostics.
- Restart persistence for history, approval, worktree, session, and evidence state.

Never store raw credentials in SQLite.

### I. GitHub and deployment adapters

Audit only existing functionality.

Verify:

- Both integrations are optional.
- Missing configuration/authentication is accurate and non-fatal.
- `skipped`, `not configured`, `failed`, and `completed` remain distinct.
- Remote errors do not corrupt local run, Git, approval, or evidence state.
- Retry is idempotent or visibly guarded.
- Repository, branch, commit, pull request, workflow, deployment, and environment identifiers are not mixed.
- Every write or destructive operation is confirmation-gated.
- Evidence reports match actual adapter outcomes.

### J. VS Code workspace bridge

Verify:

- Extension build/package behavior.
- Freshness and expiry of active-workspace data.
- Path normalization and project confinement.
- Closed/unavailable VS Code behavior.
- Snapshot and workspace identity consistency between UI, daemon, and provider worktree.
- Errors are visible and actionable.

### K. Setup, diagnostics, build, and packaging

Inspect all declared scripts and artifacts.

Verify:

- Commands run from the repository root and from paths containing spaces.
- Scripts do not rely on an accidental current working directory.
- PowerShell uses safe quoting and error propagation.
- Required and optional dependencies are distinguished correctly.
- Doctor output matches reality and structured output is valid when supported.
- Version numbers are consistent across manifests, UI, extension, artifacts, checksums, and docs.
- Packaged output contains Electron, renderer, daemon, migrations, assets, and required runtime files.
- Development-only files and secrets are excluded.
- Daemon lifecycle and data paths work in packaged mode.
- Installer and portable names/paths match documentation.
- Checksums are generated and verified.
- Unsigned artifacts are labeled honestly; signing checks are not bypassed.

A non-Windows environment may validate configuration, build logic, and archive contents, but must not be reported as a successful Windows install smoke test.

### L. Security, privacy, and redaction

Check source, configuration, fixtures, logs, evidence, package contents, error responses, temporary files, and child-process handling for:

- Hard-coded secrets and credentials.
- Token/key leakage.
- Unsafe environment inheritance.
- Shell/command injection.
- Path traversal and symlink/junction escape.
- Unsafe temporary-file creation or permissions.
- Missing daemon authorization.
- Excessive renderer or provider access.
- Sensitive data retention beyond policy.
- Incomplete redaction, including split/chunked secrets.
- Unsafe URL opening, download, installer, and catalog behavior.

Add focused security tests for every corrected trust-boundary defect.

### M. Code quality, reliability, and test integrity

Inspect for unsafe `any`, incorrect types, duplicate business rules, dead code, unused configuration, inconsistent errors, unchecked return values, unhandled async work, race conditions, memory/event/timer/process leaks, brittle helpers, machine-specific paths, and optional-software tests without a clear skip reason.

Do not delete suspicious code based only on static analysis. Confirm reachability and behavior first.

## Failure handling

When a command fails:

1. Read the complete error.
2. Reproduce at the narrowest level.
3. Identify the root cause.
4. Apply the smallest correct fix.
5. Add regression coverage.
6. Re-run the failed command.
7. Re-run related checks.
8. Commit the logical correction.
9. Continue with remaining in-scope work.

Do not make repeated speculative edits without testing between them.

A task is blocked only by something outside the repository such as unavailable credentials, services, permissions, hardware, supported operating system, signing certificate, or required destructive approval. Complete all unblocked work first and record the exact command, error, missing dependency, and required user action.

## Audit report

Create or update:

`docs/overall-audit-report.md`

The report must include:

- Audit date and environment.
- Starting branch, commit, and protected working-tree state.
- Scope and exclusions.
- Baseline commands and results.
- Findings ledger grouped by severity.
- Root cause and repair for every fixed finding.
- Commit hash for every repair.
- Files changed.
- Tests added or updated.
- Final validation commands and results.
- Known limitations and blocked external integrations.
- Remaining risks.
- Approval-gate verification.
- Honest GitHub/deployment skip verification.
- Packaged Windows artifact status and exact path, or the reason it could not be verified.

Do not write `all issues fixed` unless every discovered in-scope issue is fixed or explicitly documented as blocked or accepted with a reason.

## Final verification

After repairs, run the broadest practical repository-declared validation sequence. At minimum, cover relevant formatting, linting, type checking, tests, security checks, production build, diagnostics, and packaging/package verification when supported.

Perform manual or automated smoke coverage for:

1. Development startup.
2. Packaged startup on Windows when the environment supports it.
3. Project/workspace selection.
4. Prompt submit, revise, freeze, and approval.
5. Proof that execution is blocked before approval.
6. Safe approved execution in an isolated worktree.
7. Diff, history, and evidence review.
8. Missing Codex.
9. Missing GitHub.
10. Missing deployment.
11. Cancellation.
12. Restart and persisted-state recovery.

Do not substitute a mocked test for a real smoke test when the real test is safe and available. Do not claim a Windows package was verified on a non-Windows host.

Before the final response:

- Re-read the requested scope and acceptance criteria.
- Review every created commit.
- Review the full diff from the starting commit.
- Confirm no debug output, secrets, temporary artifacts, caches, or accidental files remain.
- Confirm documentation matches behavior.
- Confirm the working tree is clean except for protected pre-existing changes.

## Required final response

Provide:

1. Overall result: `pass`, `pass with limitations`, or `blocked`.
2. Finding count by severity.
3. Number fixed, blocked, accepted, and remaining open.
4. Implementation steps completed.
5. Commit hashes and titles.
6. Main files changed.
7. Tests added or updated.
8. Every validation command and result.
9. Failed checks and root causes.
10. Environment-blocked checks and precise requirements to unblock them.
11. Remaining risks and limitations.
12. Exact audit report path.
13. Packaged `.exe` verification status and exact artifact path when verified.
14. Explicit confirmation that the approval gate, worktree isolation, renderer boundary, secret handling, and honest optional-stage reporting remain enforced.

Never claim a defect is fixed, a check passed, or an artifact works unless the corresponding implementation and validation succeeded.
