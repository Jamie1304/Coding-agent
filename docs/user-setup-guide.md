# Windows setup and first run

## 1. Install prerequisites

Open PowerShell (not necessarily as Administrator):

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Git.Git -e
```

VS Code, Codex, and GitHub CLI are optional integrations. Install only those you intend to use:

```powershell
winget install --id Microsoft.VisualStudioCode -e
npm install -g @openai/codex
codex --version
codex login
codex login status
winget install --id GitHub.cli -e
gh auth login
gh auth status
```

Codex may use ChatGPT sign-in or its supported API-key flow. Prefer OS keyring credential storage.
GitHub is optional until you want live issue/PR/CI/release stages.

## 2. Bootstrap and package

Runnable command for this computer:

```powershell
Set-Location "C:\Users\Jamie Kanbier\Documents\Coding agent"
.\scripts\bootstrap.ps1
.\scripts\install-vscode-extension.ps1
```

Generic example — replace the placeholder:

```powershell
Set-Location "<YOUR-AGENT-REPOSITORY-PATH>"
.\scripts\bootstrap.ps1
```

The bootstrap script derives the root from its own location, distinguishes blocking and optional
checks, installs or refreshes dependencies, builds, tests, and packages the desktop and extension.
It is safe to rerun and may be invoked from any current directory.

## 3. Start and connect

```powershell
.\scripts\dev.ps1
```

Open a test Git project in VS Code. Reload the window after VSIX installation. The status bar should
show `Codex Agent: <project>`. In a multi-root workspace, run **Personal Codex Agent: Set Active
Project**. If needed, select the folder manually in the desktop app.

Open **Setup & Connections**, run `npm run doctor`, and confirm Node, Git, Codex, authentication,
database/report access, extension connection, and exact workspace. The UI must show the intended
absolute path, branch, commit, remote, dirty state, technologies, and detected tests.

## 4. First prompt

1. Enter a development request in **New Run** and select **Review prompt**.
2. Answer only the critical questions. Each states why it matters and which decision it affects.
3. Review original versus improved prompt, changes, assumptions, criteria, tests, risks, version
   bump, and implementation sequence.
4. Select **Reject & revise** with a concrete reason to test realignment. Confirm the next question
   addresses that rejection and prior answers remain.
5. Select **Approve & execute** only when the exact workspace and specification are correct.
6. Follow the live timeline. Approval freezes the revision; Codex then runs in an isolated worktree.
7. Open Markdown/JSON evidence in `<project>\.agent-runs\<run-id>\`.

## 5. Configure a project

Copy an example to `<project>\.agent\project.yml`. Set real project-native quality commands. Enable
GitHub only after `gh auth status` passes. Leave deployment disabled until staging, production smoke,
rollback, and any migration backup commands have been tested manually. See
[deployment configuration](deployment-configuration.md).

## 6. Blocked runs, updates, and removal

A blocked run is not success. Read its final event and report, fix the external condition, refresh
the workspace, and resume from a fresh preflight. To update, pull the repository and rerun
`.\scripts\bootstrap.ps1`.

Uninstall the VSIX:

```powershell
code --uninstall-extension personal-codex-agent.personal-codex-agent-vscode
```

To reset local state, stop the app, back up reports, and remove
`%LOCALAPPDATA%\PersonalCodexAgent`. This does not remove project `.agent-runs` or worktrees. See
[troubleshooting](troubleshooting.md) for Windows, Git, Codex, GitHub, SQLite, worktree, CI, and
packaging failures.

## 7. Development process behavior

Use PowerShell 7 or Windows PowerShell. `npm run dev` validates the Electron runtime first, starts
the daemon, then starts a programmatic Vite server and obtains its actual dynamic loopback URL
before launching Electron. The chosen daemon and renderer URLs are printed and passed explicitly to
Electron.

Press `Ctrl+C` once to stop the owned Electron process tree, Vite server, and daemon. A repository
lock prevents two development supervisors from interfering. Stale locks are removed only after the
recorded PID is confirmed dead.

If port 5173 is occupied, Vite selects another port and Electron receives that exact URL. If a CLI
is installed but not on `PATH`, `npm run doctor` reports its resolved fallback path and a PATH repair
action. Detailed daemon state is under `%LOCALAPPDATA%\PersonalCodexAgent`; development lock state is
in `.agent\dev-run.lock.json`.

To confirm the extension:

```powershell
code --list-extensions | Select-String personal-codex-agent
```

Reload VS Code with **Developer: Reload Window** after installation.
