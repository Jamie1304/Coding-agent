# Changelog

## 0.2.0 - 2026-07-30

- Added secure in-app setup for OpenAI, Anthropic, Gemini, xAI, Ollama, and OpenAI-compatible providers.
- Added dynamic model discovery, role assignment, deterministic routing, budgets, normalized usage, bounded fallback, and a no-call simulator.
- Added task-DAG scheduling with provider limits, cancellation, dependency handling, and file-ownership conflict prevention.
- Added evidence verification, structured-output validation, abstention, and independent-verification policies.
- Added the Phase 2 SQLite migration, non-secret configuration export/import preview, provider dashboards, and extensive mock-backed tests.

All notable changes follow Keep a Changelog and Semantic Versioning.

## [0.1.0] - 2026-07-30

### Added

- Approval-gated prompt alignment with repository-aware questions, rejection realignment, preserved
  answers, frozen specifications, and explicit acceptance criteria.
- Loopback authenticated daemon, SQLite migrations, deterministic workflow, Codex app-server and
  fake providers, Git worktrees, GitHub/quality/deployment adapters, rollback, and evidence reports.
- Sandboxed Electron/React desktop client and trust-aware VS Code workspace bridge.
- Windows setup/doctor/build/test/package scripts, CI, tests, unsigned desktop build, VSIX packaging,
  checksums, examples, and complete operator/developer documentation.
