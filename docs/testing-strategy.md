# Testing strategy

Vitest provides deterministic unit, integration, security, and API workflow tests. Fixture
repositories are created in the Windows temp directory, including a path containing spaces, and
initialized with real Git commits.

- Unit: every state transition family, invalid transitions, prompt questions/revisions/rejections,
  structured fake Codex events, command success/failure/timeout, parsing, and deployment rollback.
- Integration: SQLite migrations and frozen revisions, technology/test detection, clean/dirty Git,
  worktree/branch/commit behavior, multi-root selection, fake GitHub lifecycle, complete report set.
- E2E/API: daemon authentication, workspace publication, prompt submission, answers, revision,
  recovery listing, and cancellation.
- Security: missing/invalid tokens, traversal and canonical workspace boundaries, secret redaction,
  and Electron privilege isolation.
- Build/package: Vite renderer, Electron main/preload, daemon bundle, VS Code extension bundle/VSIX,
  unsigned Windows directory, and SHA-256 manifest.

Run all:

```powershell
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:security
npm run test:coverage
```

The fake Codex, GitHub, and deployment providers never report a real external success. Live
credential-dependent validation must be performed after `codex login` and `gh auth login`.
