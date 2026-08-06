---
agent: 'agent'
description: 'Implement Personal Codex Agent integrations through a phased, security-gated provider architecture'
---

# Personal Codex Agent — Integration Implementation

## Invocation inputs

- **Target phase:** ${input:phase:Enter one phase number (0-10), a phase range, or "all". Default: 0}
- **Priority providers:** ${input:providers:Optional comma-separated provider IDs. Leave blank to follow the phase order.}
- **Additional constraints:** ${input:constraints:Optional repository- or environment-specific constraints.}

## Mission

Extend the existing **Personal Codex Agent** repository into a Windows-first desktop application that can install, authenticate, configure, diagnose, update, use, and remove supported AI coding providers and Git/GitHub integrations through the GUI.

Normal end users must not need PowerShell, Command Prompt, Git Bash, npm, GitHub CLI, or another terminal for setup and operation. The packaged application must remain distributable as a Windows `.exe` and must start its bundled daemon automatically.

This is a phased implementation task. Do not try to deliver the entire roadmap as one speculative patch.

- By default, execute exactly the requested phase.
- If `all` is requested, complete phases sequentially.
- Do not begin a later phase until the current phase is implemented, tested, reviewed, documented, and committed.
- When an external dependency blocks a phase, complete all unblocked work, leave the repository healthy, document the blocker precisely, and stop claiming progress at the blocked boundary.

## Non-negotiable product invariants

Preserve these behaviors throughout every phase:

1. A user request becomes a reviewed specification.
2. Repository writes and provider implementation turns remain blocked until the user explicitly approves the frozen prompt revision.
3. A material revision invalidates the previous approval.
4. Write-capable provider work runs in an isolated Git worktree unless the existing architecture documents a stricter mechanism.
5. Tests, diffs, quality gates, run history, and evidence reports remain active.
6. GitHub and deployment stages are reported as `not configured` or `skipped`, never as successful, when unavailable.
7. No provider, fallback, retry path, or UI action may bypass the approval lifecycle.
8. The Electron renderer remains sandboxed and cannot spawn processes, access arbitrary files, or read secrets.
9. Privileged work remains daemon-owned and loopback-only, using the repository's existing renderer-to-daemon authentication model.
10. Dangerous Git, GitHub, installation, provider, and permission operations require explicit confirmation.
11. Missing optional integrations must not prevent application startup.
12. Raw credentials must never be stored in SQLite, project `.env` files, command arguments, logs, reports, renderer state, or packaged resources.

## Source-of-truth hierarchy

Use evidence in this order:

1. Actual source code, configuration, migrations, and executable scripts.
2. Automated tests and test fixtures.
3. Current repository documentation.
4. Generated repository indexes or knowledge files.
5. This prompt's examples and assumptions.

Generated knowledge is a navigation aid, not authority. If a supplied knowledge bundle describes another project, stack, or repository identity, do not use it as implementation evidence. Report the mismatch and continue from the actual repository.

Provider commands, flags, protocols, authentication methods, installer sources, and capability claims change over time. Before implementing a provider:

- Verify the current behavior against official provider documentation or runtime discovery.
- Record the source and verification date in the provider metadata or compatibility documentation.
- Treat undocumented or untested behavior as `unknown`, not supported.
- Never infer support merely because an executable exists or a help string contains a keyword.

## Required engineering workflow

### Before editing

1. Run `git status --short` and record all pre-existing changes.
2. Identify the current branch, HEAD commit, and recent relevant history.
3. Inspect the repository tree and the actual files for:
   - Electron main and preload code.
   - React renderer routes and state management.
   - Loopback daemon and typed API contracts.
   - SQLite initialization and migrations.
   - Existing Codex, Git, GitHub, deployment, worktree, quality-gate, and evidence adapters.
   - Setup, diagnostics, packaging, and release scripts.
   - Unit, integration, end-to-end, security, and packaging tests.
4. Inspect `package.json` and workspace manifests before assuming a command exists.
5. Establish a baseline by running the narrowest declared validation commands relevant to the target phase.
6. Produce a file-mapped implementation plan with acceptance criteria, dependencies, risks, and rollback considerations.
7. Do not edit code until the current architecture and test patterns are understood.

### For each implementation step

1. Implement the smallest complete change.
2. Add or update behavior-focused tests.
3. Run the new or directly affected tests.
4. Run relevant formatting, linting, type checking, compilation, schema, and build checks.
5. Review the complete diff and `git diff --check`.
6. Confirm that only task-related files are staged.
7. Commit the completed step using the required commit format below.
8. Only then continue.

Do not discard, overwrite, stage, or commit unrelated user changes. Do not use destructive Git commands. Do not amend, squash, force-push, or rewrite commits unless explicitly authorized.

### Commit format

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

## Honest provider support model

Do not represent capabilities as an unqualified list of booleans. Preserve machine-friendly capability flags if the existing architecture requires them, but expose an evidence-bearing status model at the registry and UI boundaries.

```ts
type CapabilityState = 'supported' | 'unsupported' | 'degraded' | 'unknown';
type CapabilityEvidenceSource =
  | 'runtime-negotiation'
  | 'integration-test'
  | 'official-documentation'
  | 'static-definition'
  | 'inferred';

type ProviderCapabilityStatus = {
  state: CapabilityState;
  source: CapabilityEvidenceSource;
  lastVerifiedAt?: string;
  providerVersion?: string;
  notes?: string;
};

type ProviderCapabilities = {
  interactive: ProviderCapabilityStatus;
  headless: ProviderCapabilityStatus;
  streaming: ProviderCapabilityStatus;
  structuredOutput: ProviderCapabilityStatus;
  acp: ProviderCapabilityStatus;
  appServer: ProviderCapabilityStatus;
  modelListing: ProviderCapabilityStatus;
  sessionResume: ProviderCapabilityStatus;
  sessionFork: ProviderCapabilityStatus;
  cancellation: ProviderCapabilityStatus;
  worktrees: ProviderCapabilityStatus;
  mcp: ProviderCapabilityStatus;
  permissionRequests: ProviderCapabilityStatus;
  fileChanges: ProviderCapabilityStatus;
  shellExecution: ProviderCapabilityStatus;
  usageReporting: ProviderCapabilityStatus;
  browserAuthentication: ProviderCapabilityStatus;
  deviceAuthentication: ProviderCapabilityStatus;
  apiKeyAuthentication: ProviderCapabilityStatus;
};
```

Track provider maturity separately:

```ts
type ProviderIntegrationStatus =
  | 'catalog-only'
  | 'detected'
  | 'verified'
  | 'implemented'
  | 'integration-tested'
  | 'end-to-end-tested'
  | 'degraded'
  | 'unsupported';
```

The UI and evidence reports must distinguish installation, authentication, health, capability, and integration maturity. Examples:

- Installed but unauthenticated.
- Detected, but machine-readable mode is unverified.
- Streaming unsupported by this provider version.
- Write mode blocked because permission mediation is unavailable.
- Read-only review available.
- Authentication requires an API account and may incur usage charges.

## Provider adapter architecture

Preserve existing abstractions where possible. Do not create a parallel provider subsystem if the repository already has a suitable adapter boundary.

### 1. Codex app-server adapter

Use the repository's existing Codex integration as the starting point. Prefer supported app-server methods over parsing an interactive terminal UI.

Required behavior, subject to current protocol verification:

- Safe local app-server lifecycle.
- JSON/JSONL protocol transport over stdio, plus localhost transport only when officially supported and required.
- Initialization and account-status operations.
- Supported browser, device-code, or API-key authentication through provider-owned flows.
- Thread/session start, resume, fork, steering, interruption, history, and cancellation when advertised.
- Streaming assistant, command, permission, user-input, file-change, diff, usage, warning, and error events.
- Model and MCP discovery when supported.
- Clean shutdown and process-tree cleanup.
- Fallback to supported non-interactive JSON execution only for operations that do not require interactive permissions or session features.

Never read, copy, or parse provider token files directly when supported account APIs exist.

### 2. Agent Client Protocol adapter

Implement a version-negotiated ACP-over-stdio adapter only for providers whose current official behavior or runtime handshake confirms ACP compatibility.

Required behavior:

- Child-process launch with protocol stdout separated from stderr.
- JSON-RPC framing and newline-delimited message handling where required by the negotiated version.
- Initialization, capability negotiation, authentication, session lifecycle, prompt delivery, updates, permissions, resume, close, and cancellation when advertised.
- Strict schema validation and rejection of malformed messages.
- Sequence ordering, bounded buffering, backpressure, inactivity timeout, maximum runtime, crash detection, and complete process-tree termination.
- Normalization into the shared event schema without discarding the redacted raw payload.
- Feature detection for newer protocol versions; never silently assume forward compatibility.

### 3. Structured CLI adapter

Use this adapter for providers with reliable JSON, JSONL, or documented machine-readable output but without a deeper protocol.

Required behavior:

- Executable and version discovery.
- Safe argument arrays; no `shell: true` by default.
- Correct Windows handling for executables and `.cmd` launchers without command injection.
- Hidden background windows.
- Explicit working directory and allowlisted environment variables.
- Prompt delivery through documented stdin or arguments.
- Incremental JSONL parsing, complete JSON parsing, and bounded plain-text fallback.
- Exit-code mapping, timeout, cancellation, process-tree cleanup, and session ID extraction.
- Resume support only when verified.
- Provider-specific permission restrictions translated from application policy.
- Secret and sensitive-path redaction before persistence or UI delivery.

### 4. One-shot text adapter

Use this only for providers that can perform useful non-interactive work but lack a stable event protocol.

Required behavior:

- Run in an isolated worktree.
- Capture bounded stdout and stderr.
- Detect file changes and provider-created commits through Git.
- Apply application approval before write access.
- Report tool-level visibility and per-action approval as unavailable.
- Never imply that unobserved provider actions were individually approved.

### 5. Local model backend adapter

Treat Ollama, LM Studio, OpenAI-compatible local servers, and similar systems as inference backends, not coding agents, unless they independently expose verified file, shell, session, cancellation, and approval capabilities.

A local backend may be consumed by Aider, OpenCode, Cline, or another agent adapter without inheriting that agent's capabilities.

## Initial provider registry

Create or update registry entries for the following identities. Command names and flags below are discovery hints, not unconditional facts. Verify each entry before enabling it.

| Provider ID | Display name | Preferred adapter | Discovery hints | Mandatory restrictions |
|---|---|---|---|---|
| `openai-codex` | OpenAI Codex | App-server, structured CLI fallback | `codex` | Use supported account APIs; preserve approvals. |
| `anthropic-claude-code` | Claude Code | Structured CLI | `claude` | Never enable unrestricted permission modes by default. |
| `google-gemini-cli` | Gemini CLI | Structured CLI | `gemini` | Never write API keys into project files by default. |
| `xai-grok-build` | Grok Build | ACP when negotiated, otherwise structured CLI | `grok` | Capability-gate sessions, tools, and permissions. |
| `github-copilot-cli` | GitHub Copilot CLI | ACP or structured CLI when verified | `copilot` | Translate policy to the narrowest tool/path/URL permissions; never enable allow-all modes automatically. |
| `cursor-agent` | Cursor Agent | ACP when negotiated, otherwise structured CLI | `agent` | Do not require the desktop IDE unless the verified feature does. |
| `opencode` | OpenCode | ACP, server, or structured CLI | `opencode` | Preserve existing user configuration unless explicitly changed. |
| `qwen-code` | Qwen Code | ACP when negotiated, otherwise structured CLI | `qwen` | Bound large outputs and verify resume behavior. |
| `cline-cli` | Cline CLI | ACP when negotiated, otherwise structured CLI | `cline` | Respect provider allow/deny policy and redact credentials. |
| `kiro-cli` | Kiro CLI (formerly Amazon Q CLI) | Structured CLI | `kiro-cli` | Never enable trust-all behavior by default; preserve migration labels. |
| `aider` | Aider | One-shot text | `aider` | Control auto-commit behavior; do not claim tool-event visibility. |

For every provider entry, record:

- Publisher and official documentation URL.
- Installation sources and supported Windows architectures.
- Executable candidates and version command.
- Verified provider versions.
- Authentication modes and billing explanation.
- Capability evidence.
- Integration maturity.
- Known limitations.
- Last verified date.

## Shared contracts and normalized events

Use the existing typed contracts if they can be safely extended. Otherwise introduce a compatible provider interface similar to:

```ts
interface AgentProvider {
  readonly id: string;
  metadata(): ProviderMetadata;
  detect(): Promise<InstallationStatus>;
  install(options: InstallOptions): Promise<InstallResult>;
  update(options: UpdateOptions): Promise<UpdateResult>;
  uninstall(options: UninstallOptions): Promise<UninstallResult>;
  diagnose(): Promise<DiagnosticResult>;
  authenticate(options: AuthOptions): Promise<AuthResult>;
  logout(): Promise<void>;
  getAuthStatus(): Promise<AuthStatus>;
  listModels(): Promise<ModelInfo[]>;
  getCapabilities(): Promise<ProviderCapabilities>;
  startSession(options: StartSessionOptions): Promise<AgentSession>;
  resumeSession(options: ResumeSessionOptions): Promise<AgentSession>;
  sendPrompt(session: AgentSession, prompt: string): Promise<void>;
  cancel(session: AgentSession): Promise<void>;
  dispose(session: AgentSession): Promise<void>;
}
```

Normalize provider output into explicit events such as:

```ts
type AgentEvent =
  | SessionStartedEvent
  | SessionReadyEvent
  | AssistantDeltaEvent
  | AssistantMessageEvent
  | ReasoningSummaryEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | UserInputRequestEvent
  | FileChangeEvent
  | DiffUpdatedEvent
  | TestResultEvent
  | UsageEvent
  | WarningEvent
  | ErrorEvent
  | SessionCompletedEvent
  | SessionCancelledEvent;
```

Every event must include:

- Application run ID.
- Provider ID.
- Provider session ID when available.
- UTC timestamp.
- Monotonic sequence number.
- Workspace and worktree identity.
- Redacted provider payload reference.
- Provenance: `raw`, `normalized`, or `inferred`.

Store raw output separately from normalized events, apply output-size bounds, and redact before persistence. Reasoning content must be represented only to the extent the provider exposes a supported, safe summary; do not invent or expose hidden chain-of-thought.

## Daemon-owned process supervisor

The renderer must never receive raw process handles or arbitrary command execution.

The supervisor must:

- Launch hidden Windows processes with safe executable/argument separation.
- Resolve executable paths deterministically.
- Use explicit working directories.
- Pass only allowlisted environment variables.
- Track process IDs and descendant process trees.
- Capture stdout and stderr independently.
- Bound line length, total output, queue size, and persisted output.
- Apply startup, inactivity, and maximum runtime timeouts.
- Detect unsupported interactive prompts and fail with an actionable error rather than hanging.
- Support graceful cancellation followed by forced process-tree termination.
- Remove timers, listeners, streams, and temporary files on every terminal path.
- Emit health and diagnostic events.
- Redact tokens, keys, cookies, authorization headers, credentials, and sensitive paths.

## Installation and authentication

### Installation manager

Implement only from allowlisted provider definitions and trusted package sources.

- Prefer per-user installation.
- Show publisher, source, target version, architecture, download size, privileges, exact redacted command, and rollback behavior before confirmation.
- Verify Authenticode signature, checksum, or another provider-supported integrity mechanism.
- Never execute an arbitrary remote PowerShell script.
- Save an installation receipt without secrets.
- Support progress, cancellation, retry, repair, update, uninstall, and safe rollback.
- Clean temporary installers after verified success.
- A failed optional provider installation must not block application startup.

### Authentication manager

Use provider-native browser OAuth, device flow, or secure API-key entry.

- Store recoverable secrets in Windows Credential Manager or DPAPI-protected storage.
- Store only opaque credential references and non-secret status in SQLite.
- Never send raw secrets to the renderer.
- Never place keys in command arguments.
- Inject credentials only into the intended child process.
- Support login progress, cancellation, reauthentication, logout, health checks, account identity, scopes, and billing explanation where available.
- For GitHub, use an approved native-app/device flow or equivalent secure flow; do not require `gh auth login` for core GitHub functionality.
- Never embed a reusable OAuth client secret in the desktop executable.

## Git and GitHub integration

### Local Git

Preserve and extend the existing daemon-owned Git adapter rather than creating a renderer-side wrapper.

Support the current product scope for repository detection, clone/init, remotes, fetch/pull/push, branches, tags, history, stage/unstage, commit, diff, stash, worktrees, merge/rebase/cherry-pick/revert, LFS, submodules, signing, and conflicts.

All destructive or history-rewriting operations require a confirmation that shows the repository, branch, exact operation, reversibility, and consequences. Never expose credentials in arguments or logs.

### GitHub

Implement GitHub as a typed application service, using official APIs where appropriate. The GitHub CLI may remain optional but must not be required for core functionality.

Required functional areas:

- Multiple GitHub hosts and accounts.
- Secure login, token storage, scope display, validation, logout, and reauthorization.
- Repository listing, search, clone, fork, and explicit-confirmation administrative changes.
- Pull requests, reviews, comments, labels, milestones, checks, merge state, and confirmation-gated creation/merge.
- Issues, comments, assignment, labels, and run linkage.
- Actions workflows, runs, jobs, logs, artifacts, and confirmation-gated dispatch/cancel/rerun.
- Issue-to-approved-specification-to-worktree-to-provider-to-tests-to-diff-to-commit-to-push-to-pull-request workflow.

At every remote write step, show the exact host, repository, branch, files or object affected, required permission, operation, and reversibility.

## Custom provider definitions

Support future providers without allowing arbitrary shell execution.

A custom definition may include display name, stable ID, executable path, version arguments, authentication method, prompt/resume/model argument templates, output mode, parser, working-directory behavior, permission flags, environment mappings, documentation URL, installation guidance, ACP eligibility, and trust state.

Security requirements:

- Use explicit executable paths and argument arrays.
- Reject shell metacharacter templates and ambiguous executable definitions.
- Validate schemas and migrations.
- Show a redacted command preview.
- Require confirmation before saving or enabling.
- Run a harmless diagnostic before activation.
- Do not permit approval or worktree bypasses.
- Store definitions in SQLite; store credentials outside SQLite.
- Remote catalogs must use allowlisted HTTPS origins, signed manifests or verifiable checksums, explicit versioning, user confirmation, no silent replacement, and rollback.

## UI requirements

Extend existing routes and components rather than duplicating navigation. Add only pages required by the completed phase.

The roadmap may include:

- Setup & Connections.
- AI Providers and Provider Details.
- Authentication and Model Picker.
- Active Sessions, Transcript, and Permission Requests.
- Worktrees and Git Repository.
- GitHub repositories, pull requests, issues, and Actions.
- Installation History, Diagnostics, Security & Credentials, Provider Compatibility, Settings, and Troubleshooting.

Every view must represent these states accurately: installed, missing, unauthenticated, authenticated, degraded, unsupported, blocked by policy, update available, administrator required, subscription required, API key required, and external application required.

Avoid redesigning the application. Follow existing terminology, visual patterns, accessibility conventions, loading/error states, and renderer security boundaries.

## Database and migration requirements

Add only the tables and columns needed by the active phase. Potential entities include provider definitions, installations, versions, capability evidence, authentication status, configuration, credential references, sessions, provider session IDs, normalized events, raw-output references, receipts, GitHub hosts/accounts, repository metadata, pull requests, issues, workflow runs, Git operations, permission decisions, audit events, and provider errors.

Every migration must:

- Have an ordered, stable identifier.
- Upgrade existing databases safely.
- Be idempotent according to the repository's migration convention.
- Preserve data on failure through transactions where supported.
- Include upgrade tests from the previous schema and clean-database tests.
- Avoid raw credentials.

## Phase plan

### Phase 0 — Repository audit and executable plan

- Map the actual architecture, files, APIs, routes, schema, adapters, scripts, tests, and packaging.
- Compare implementation with README and docs.
- Identify protected user changes and baseline failures.
- Produce a phase-by-phase file map, dependency graph, risk register, and acceptance criteria.
- Do not create a replacement architecture.
- Do not claim provider facts that have not been verified.

**Exit criteria:** a repository-grounded plan, baseline command results, identified conflicts, and no unreviewed source changes.

### Phase 1 — Shared contracts and persistence

- Add compatible provider metadata, capability evidence, session, event, validation, and API contracts.
- Add the minimum migrations and fake-provider fixtures.
- Add redaction and schema tests.

**Exit criteria:** contracts compile, migrations pass clean/upgrade tests, API validation is consistent, and existing behavior remains green.

### Phase 2 — Process supervisor

- Implement safe Windows process launch, streaming, bounds, timeouts, cancellation, and process-tree cleanup.
- Add fake processes for success, malformed output, crash, timeout, secret emission, and cancellation.

**Exit criteria:** supervisor tests prove cleanup, redaction, bounded output, and injection-resistant command construction.

### Phase 3 — Provider registry and diagnostics

- Implement metadata validation, detection, version parsing, capability evidence, health status, and custom-provider validation.
- Add registry UI/API only as needed.

**Exit criteria:** catalog-only entries are not displayed as supported; version/capability evidence is visible and tested.

### Phase 4 — Codex integration

- Deepen the existing Codex app-server integration.
- Implement supported authentication, session lifecycle, event normalization, permission mediation, cancellation, model/MCP discovery, and structured fallback.

**Exit criteria:** fake-server integration tests pass; unavailable or unauthenticated Codex is handled honestly; approval and worktree gates remain enforced.

### Phase 5 — ACP

- Implement version-negotiated ACP transport and connect only verified ACP providers.

**Exit criteria:** handshake, session, permission, malformed message, crash, timeout, cancellation, and resume tests pass.

### Phase 6 — Structured and one-shot providers

- Implement priority providers in small provider-specific commits.
- Reuse shared adapters; keep provider quirks in isolated definitions or adapters.

**Exit criteria per provider:** official behavior verified, detection/auth/model/session behavior implemented as applicable, fake/integration tests pass, compatibility matrix updated, unsupported features shown honestly.

### Phase 7 — Setup, installation, authentication, and diagnostics UI

- Implement prerequisite detection, installation receipts, install/update/repair/uninstall, authentication, and diagnostic flows.

**Exit criteria:** GUI-only happy path and failure states are tested; elevation and external browser/device flows remain confirmation-gated.

### Phase 8 — Git and GitHub

- Complete local Git operations needed by the approved workflow.
- Implement first-class GitHub authentication and APIs for repositories, issues, pull requests, and Actions.

**Exit criteria:** local workflow passes against temporary repositories; GitHub behavior passes against deterministic mocks; remote writes remain explicitly confirmed.

### Phase 9 — Unified desktop workflow and recovery

- Connect provider/model selection, approved prompt, worktree, session streaming, permissions, tests, diff review, evidence, Git/GitHub actions, and restart recovery.

**Exit criteria:** end-to-end tests cover approval blocking, cancellation, crash recovery, missing integrations, and persisted state.

### Phase 10 — Packaging, clean-machine validation, and documentation

- Bundle Electron, renderer, daemon, migrations, and required runtime assets.
- Produce installer, portable build where supported, checksums, and package verification.
- Update user and developer documentation and provider compatibility evidence.

**Exit criteria:** packaged app starts without Node/npm, daemon lifecycle works, optional providers may be absent, artifacts are verified, and environmental limitations are documented.

## Required tests

Select tests based on the phase, but do not omit regression coverage for behavioral changes.

### Unit

- Registry and metadata validation.
- Capability evidence and negotiation.
- Command construction and Windows quoting.
- Executable resolution and version parsing.
- JSON, JSONL, and ACP parsing.
- Event normalization and ordering.
- Secret/path redaction.
- Worktree/path confinement.
- Timeout and cancellation state machines.
- GitHub error/scope mapping.
- Manifest, signature, and checksum validation.
- Database migrations and renderer-daemon authorization.

### Fake-provider

- Successful JSON.
- Streaming JSONL.
- ACP startup/session/permission/cancellation.
- Malformed frames.
- Provider crash and hang.
- Unsupported interactive input.
- Secret emission.
- File modification and out-of-worktree write attempts.
- Descendant process cleanup.

### Integration

- SQLite persistence and migrations.
- Temporary Git repositories, bare remotes, worktrees, diffs, and commits.
- GitHub API mocks and device-flow polling.
- Installation-manager mocks and receipts.
- Provider login state, resume, cancellation, restart recovery, and evidence generation.

### End-to-end and security

- First launch and setup wizard.
- Provider installation/authentication failure and success paths where safely testable.
- Prompt review, revision, approval, worktree, execution, permission, tests, diff, commit, and pull-request flow.
- Restart during a run and recovery.
- Missing Codex, GitHub, deployment, and optional providers.
- Renderer sandbox, loopback authentication, secret isolation, command injection, path traversal, output redaction, remote catalog integrity, and confirmation gates.

Live external-provider tests must be opt-in and must not be represented as passed when credentials, network access, billing accounts, or supported operating systems are unavailable.

## Documentation requirements

Update only documentation made inaccurate by the implemented phase. Keep the README's end-user path GUI-first. Keep terminal commands in developer and troubleshooting material.

Maintain a provider compatibility document containing:

- Provider and verified version.
- Adapter class.
- Installation source.
- Authentication methods.
- Windows requirements.
- Headless, streaming, resume, worktree, permissions, model-listing, and MCP status.
- Integration maturity.
- Known limitations.
- Official source and last verified date.

Do not label a provider `supported` until the relevant integration tests pass.

## Final verification

Before finishing the requested phase:

1. Re-read this prompt and the phase exit criteria.
2. Review all commits created for focus and independence.
3. Review the complete diff from the starting commit.
4. Run the broadest practical declared validation suite.
5. Run packaging only when relevant and supported by the environment.
6. Remove debug output, temporary files, caches, accidental generated files, and secrets.
7. Confirm documentation matches behavior.
8. Confirm the working tree contains only protected pre-existing changes, if any.

## Required final response

Report:

1. Overall result: `pass`, `pass with limitations`, or `blocked`.
2. Target phase and exit criteria status.
3. Implementation steps completed.
4. Commit hashes and titles.
5. Main files changed.
6. Migrations added or changed.
7. Providers implemented, verified, detected-only, degraded, or unsupported.
8. Tests added or updated.
9. Every validation command run and its result.
10. Packaging artifacts and exact paths, when produced.
11. Important design decisions.
12. Remaining risks, limitations, and exact blockers.
13. Confirmation that approval, worktree, secret, renderer, GitHub, and deployment invariants remain enforced.

Never claim a feature, provider, test, package, or integration works unless it was implemented and successfully validated.
