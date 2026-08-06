# Troubleshooting

## Runtime will not start

The startup screen names the failure and offers **Retry runtime**, **Start safe mode**, **Open logs**, **Export diagnostics**, and **Exit**. Safe mode starts the bundled daemon without the Codex provider, allowing Setup, repair, and diagnostic collection to remain available.

Do not manually start a daemon, reuse an old `daemon.json`, or copy its token. The installed app owns connection metadata for its session and removes only metadata it created.

## Application Control or SmartScreen

An unsigned build may be blocked by Windows SmartScreen or enterprise Application Control. Verify the published SHA-256 and ask the administrator to allow the exact release artifact. Do not disable Code Integrity, bypass policy, or rely on `Unblock-File` to override an enterprise rule. A signing certificate and release-signing secrets are required before an official signed release can be claimed.

## Optional integration unavailable

Use **Setup & Connections** to refresh component state. Git is needed for repository lifecycle operations; Codex is needed only for Codex-backed execution; VS Code, GitHub CLI, and Ollama are optional. The app can run local prompt review and offline configuration without any of them.

Authentication is user-controlled. Complete it using the integration's own UI, then refresh setup state. Never paste credentials into diagnostic export or support tickets.

## Repair and local data

**Repair runtime** rechecks fixed integrations and restarts only the app-owned daemon. It does not delete run history, credentials, or project evidence. Back up `%LOCALAPPDATA%\\PersonalCodexAgent` before choosing data removal during uninstall or a deliberate reset.

## Developer diagnostics

For a repository checkout, run `npm run doctor` and `npm run validate`. Development mode may report Node/npm requirements because they are build tools, not installed-app prerequisites. If Electron starts as Node, remove inherited `ELECTRON_RUN_AS_NODE` before launching the desktop executable.
