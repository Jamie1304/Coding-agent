# Troubleshooting

## Daemon offline

Run `npm run doctor`, then `npm run dev:daemon`. Inspect
`%LOCALAPPDATA%\PersonalCodexAgent\daemon.json`. Do not edit its token. Ensure no security product is
blocking loopback traffic.

## Codex unavailable or unauthenticated

```powershell
npm install -g @openai/codex
codex --version
codex login
codex login status
```

Set `CODEX_EXECUTABLE` to an absolute executable path if it is not on `PATH`.

## GitHub stages skipped

Install `gh` with `winget install --id GitHub.cli -e`, run `gh auth login`, verify `origin`, and set
`github.enabled: true`. Protected branches and missing permissions are reported as blockers.

## Workspace not detected

Reload VS Code after installing the VSIX, open a folder, confirm Workspace Trust, and use
**Personal Codex Agent: Set Active Project** for multi-root workspaces. The desktop folder picker is
the safe fallback.

## Git/worktree failures

Commit or intentionally preserve source changes, remove stale worktrees with `git worktree list` and
`git worktree prune`, and ensure the sibling directory is writable. Branch collisions are blocked
instead of overwritten.

## SQLite installation

SQLite uses the built-in `node:sqlite` module and requires Node 22.5 or newer. No native compiler is
needed. Delete only `node_modules` in this repository, then run `npm ci`; do not delete local
application data unless you intend to reset history.

## Packaging and Windows warning

The development package is unsigned. SmartScreen may warn; verify `artifacts\SHA256SUMS.txt`.
Production signing requires an organization-controlled code-signing certificate and an
`electron-builder` signing configuration.

## Electron does not start

Run:

```powershell
npm run doctor
npm run electron:install
npm run package
```

Doctor validates `node_modules\electron\path.txt`, the raw executable, its version, and the packaged
application fallback. It also reports whether `ELECTRON_RUN_AS_NODE` or an override was inherited.
If Windows Application Control or antivirus blocks the exact raw executable, do not disable the
policy. Ask the administrator to allow the reported file, or use the packaged application fallback
created by `npm run package` when that executable is permitted. If doctor reports that both files
are blocked, the administrator must allow either reported executable under the active Code
Integrity policy; `Unblock-File` cannot override enterprise signing requirements. `Zone.Identifier`
is reported separately from enterprise execution policy.

## Port occupied or stale development process

The supervisor lets Vite choose an available loopback port and passes the actual URL to Electron.
Press `Ctrl+C` to close the complete owned process tree. If a prior terminal was forcibly closed,
run `npm run dev` again: a dead PID lock is removed automatically. A live lock reports the owning PID
instead of silently starting a competing instance.

For a supervised validation runtime, use its recorded terminal-operation evidence rather than a raw
terminal capture. It records redacted output, exit status, readiness, and shutdown details. If its
configured port remains held after graceful shutdown, the supervisor attempts a forced owned-tree
cleanup and reports the unreleased port as a failure; do not kill an unowned process merely because it
uses the same port.

## CLI installed but doctor cannot find it

Run `npm run doctor -- --json` and inspect `resolvedPath` and `discoveredBy`. On Windows, the resolver
checks `.exe`, `.cmd`, and `.bat` through `PATHEXT`, `where.exe`, npm's global directory, the Node
directory, and safe known application locations. Restart the terminal after editing `PATH`.

## Logs and extension confirmation

Daemon connection state is in `%LOCALAPPDATA%\PersonalCodexAgent\daemon.json`. The Setup &
Connections page can retest individual environment states without restarting. Confirm the extension
with `code --list-extensions | Select-String personal-codex-agent`, then use **Developer: Reload
Window** in VS Code.

## Reset or uninstall

First back up reports. Stop the daemon, then remove
`%LOCALAPPDATA%\PersonalCodexAgent` to reset local state. Uninstall the extension with:

```powershell
code --uninstall-extension personal-codex-agent.personal-codex-agent-vscode
```

Repository `.agent-runs` directories are separate and are not removed automatically.
