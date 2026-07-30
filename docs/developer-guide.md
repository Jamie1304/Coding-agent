# Developer guide

Use Node.js 22+ and npm workspaces. Run `npm ci`, then `npm run validate`. TypeScript is strict and
runtime input must be validated at trust boundaries. Keep renderer changes browser-only and put
privileged behavior in the daemon/core packages.

Provider changes must preserve `CodexProvider`; generate app-server schemas from the installed Codex
version and add event-mapping tests. State changes require an explicit graph transition and tests for
the valid, invalid, cancellation, recovery, blocked, and rollback paths. Process changes must retain
argument arrays, cwd, timeout, output bound, cancellation, and exit-code evidence.

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
