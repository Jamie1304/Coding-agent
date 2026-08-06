# Personal Codex Agent

Personal Codex Agent is a Windows desktop application for frozen, testable software specifications and approved Codex execution. It keeps the Electron renderer sandboxed, runs privileged work in a loopback-only daemon, stores local history in SQLite, and preserves Phase 3 runtime gates.

## Install and start

For normal use, download `Personal-Codex-Agent-Setup-<version>-x64.exe` from a verified release and run it. The per-user installer creates Start-menu and optional desktop shortcuts. The installed app needs no Node.js, npm, repository checkout, or terminal, and starts/stops its bundled daemon automatically.

On first run, **Setup & Connections** separates the core runtime from optional Git, Codex, VS Code, GitHub CLI, and Ollama integrations. Each install action requires confirmation and uses a fixed approved command; GitHub and Codex authentication remain user-controlled.

Installed releases use `%LOCALAPPDATA%\\PersonalCodexAgent`. A portable executable is also supplied for supported no-install scenarios.

## Developer commands

Developer prerequisites are Node.js 22.5+ and npm. From this repository:

```powershell
Set-Location "C:\Users\Jamie Kanbier\Documents\Coding agent"
npm run dev
```

| Command                     | Purpose                                                                  |
| --------------------------- | ------------------------------------------------------------------------ |
| `npm run build`             | Bundle the daemon, desktop, and VS Code extension.                       |
| `npm run package`           | Create installer and portable artifacts, then verify contents/checksums. |
| `npm run package:installer` | Create the NSIS installer only.                                          |
| `npm run package:portable`  | Create the portable executable only.                                     |
| `npm run package:verify`    | Verify emitted release artifacts.                                        |
| `npm run doctor`            | Development-environment diagnostics.                                     |
| `npm run validate`          | Formatting, lint, types, tests, build, and packaging.                    |

Artifacts are emitted below `artifacts/installers/`:

- `Personal-Codex-Agent-Setup-0.3.0-x64.exe`
- `Personal-Codex-Agent-Portable-0.3.0-x64.exe`
- `artifacts/SHA256SUMS.txt`

The release is unsigned until an organization-controlled Windows code-signing certificate is available. The build has signing hooks, but it never bypasses SmartScreen or enterprise Application Control policies.

## Documentation

- [Windows setup and first run](docs/user-setup-guide.md)
- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
- [Developer guide](docs/developer-guide.md)
- [Puter integration](docs/puter-integration.md)
- [Testing strategy](docs/testing-strategy.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Desktop production plan](docs/desktop-production-plan.md)
