# Developer guide

Use Node.js 22+ and npm workspaces. Run `npm ci`, then `npm run validate`. TypeScript is strict and
runtime input must be validated at trust boundaries. Keep renderer changes browser-only and put
privileged behavior in the daemon/core packages.

Provider changes must preserve `CodexProvider`; generate app-server schemas from the installed Codex
version and add event-mapping tests. State changes require an explicit graph transition and tests for
the valid, invalid, cancellation, recovery, blocked, and rollback paths. Process changes must retain
argument arrays, cwd, timeout, output bound, cancellation, and exit-code evidence.

Plan changes must use the shared step-plan schemas and the `StepPlanService`; do not bypass the
database repositories or write ad hoc evidence. A frozen plan requires contiguous ordered steps,
non-cyclic dependencies, and at least one acceptance criterion per step. Completion gates require
evidence for every applicable criterion. Keep terminal-operation arguments redacted and evidence
payloads secret-free. Per-step evidence is initialized under the run's `.agent-runs` directory and
must be preserved on recovery rather than overwritten. Frozen plans have both JSON and Markdown
artifacts so the same approved execution contract is machine-readable and user-inspectable.

Advance a persisted plan through `RunService.advanceStep`, never by writing a gate record directly.
The caller supplies the current and requested step state; `StepGateEngine` rejects stale writers,
skipped stages, later locked steps, and a completion transition without persisted applicable
evidence. Use `RunService.recoverStepExecution` during restart handling to reload the active step
without advancing it. Test both the strict Phase 3 top-level graph and the per-step graph whenever
state behavior changes.

Build outputs:

```powershell
npm run build:daemon
npm run build:desktop
npm run build:extension
npm run package:extension
npm run package
```

Configuration is parsed only from `.agent/project.yml`; examples live in `examples`. Environment
variables are documented in `.env.example`. Never commit `.env`, local SQLite files, run artifacts,
Codex auth caches, or GitHub credentials.
