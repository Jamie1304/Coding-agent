# Windows setup and first run

## Install

Download `Personal-Codex-Agent-Setup-<version>-x64.exe` from a verified release and confirm its SHA-256 against the published checksum file. Run the installer as the signed-in user. It is per-user by default, supports upgrades, creates a Start-menu shortcut, and can create a desktop shortcut. No Node.js, npm, repository checkout, or terminal is required.

The installer leaves `%LOCALAPPDATA%\\PersonalCodexAgent` in place during an upgrade. During uninstall, it asks whether to remove local settings, history, and logs. Project `.agent-runs` evidence and project worktrees are never part of application uninstall.

## First run

The desktop app displays an explicit startup state while it launches its own local daemon. It uses a random loopback port, a fresh per-launch token, an authenticated health check, and a compatibility check before the renderer connects. If startup fails, use **Retry runtime**, **Start safe mode**, **Open logs**, or **Export diagnostics**; do not edit `daemon.json`.

Open **Setup & Connections** after startup. The bundled Electron runtime and writable local data are core requirements. Git, Codex CLI, VS Code and its extension, GitHub CLI, and Ollama are optional integrations. The page records versioned setup state and explains what each integration enables. Installation requires confirmation and uses fixed package identifiers only; the app does not accept a command string from the UI.

GitHub and Codex authentication are deliberately user-controlled. Follow the official sign-in UI after installation; a failed sign-in leaves local/offline features usable.

## Use the agent

1. Choose the exact project folder in **New Run**.
2. Describe the change and select **Review prompt**.
3. Answer material questions, then review the revised prompt, acceptance criteria, risks, and tests.
4. Approve only the frozen revision you intend to execute.
5. Follow verification evidence. Runtime errors block the active implementation step until correction and regression evidence are recorded.

## Updates and portable use

The application prepares update metadata and reports whether an update source is configured. It does not claim automatic update until signed update hosting and release credentials are configured. Install a newer verified installer to upgrade the standard installation.

The portable executable is useful when installation is not permitted. It has the same daemon lifecycle and safety boundaries, but receives no automatic update channel.

## Developer-only setup

Repository development uses Node.js 22.5+, npm, and the scripts in the [developer guide](developer-guide.md). Those requirements do not apply to installed users.
