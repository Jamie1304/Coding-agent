# Puter repository-writing provider

Personal Codex Agent can use Puter.js instead of a locally installed Codex CLI for approved repository-writing runs. The provider implements the existing `CodexProvider` contract, so prompt approval, isolated Git worktrees, run history, quality gates, reports, and optional GitHub/deployment stages continue to use the existing orchestration path.

## Install

From the repository root:

```powershell
npm install
Copy-Item .env.example .env
```

Set the provider in `.env`:

```dotenv
AGENT_CODEX_PROVIDER=puter
PUTER_MODEL=openai/gpt-5.3-codex
```

Start the application:

```powershell
npm run dev
```

The first Puter run opens a browser sign-in when `PUTER_AUTH_TOKEN` is empty. On Windows, the returned token is stored in Windows Credential Manager under `PersonalCodexAgent:Puter`. For CI or a headless session, provide `PUTER_AUTH_TOKEN` through the process environment; do not commit it to the repository.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_CODEX_PROVIDER` | `app-server` in code | Select `puter`, `app-server`, or `fake`. |
| `PUTER_MODEL` | `openai/gpt-5.3-codex` | Puter model identifier. |
| `PUTER_AUTH_TOKEN` | empty | Optional non-interactive Puter token. |
| `PUTER_MAX_AGENT_STEPS` | `40` | Maximum model/tool iterations in one turn. |
| `PUTER_COMMAND_TIMEOUT_MS` | `120000` | Per-command timeout in milliseconds. |
| `PUTER_ALLOWED_COMMANDS` | `npm,pnpm,yarn,bun,node,git` | Top-level command allowlist. Code applies a second subcommand allowlist. |

If Puter changes a model identifier, update `PUTER_MODEL` without changing application code.

## Agent tools

The Puter model receives explicit tools rather than unrestricted host access:

- list, read, and literal-search text files;
- atomically write files and perform exact replacements;
- delete regular files;
- run restricted verification commands without a shell;
- mark the task complete with a concrete summary.

All paths are workspace-relative. Absolute paths, path traversal, symlink escapes, `.git`, and `.agent-runs` are blocked. Common secret-bearing files such as `.env`, private keys, `.npmrc`, and credential files cannot be read, searched, changed, or deleted; `.env.example` remains available. Dependency/build output directories are skipped during recursive inspection. File and tool-output size limits prevent accidental context blowups.

Command execution uses `shell: false`, a reduced environment, a top-level allowlist, and subcommand restrictions. Direct package installation, global flags, workspace-changing flags, network utilities, deployment commands, Git mutation, commits, pushes, resets, and cleans are not exposed. Repository-defined package scripts remain part of the repository trust boundary.

## Security boundary

The Puter provider preserves the application's approval gate and isolated Git worktree, but it does not reproduce the operating-system sandbox supplied by the Codex app-server. Approved repository test scripts still execute as the current user, just as the application's later quality-gate scripts do. Review prompts and repository trust carefully before approving execution.

Use `AGENT_CODEX_PROVIDER=app-server` when the Codex CLI sandbox is required.

## Troubleshooting

### `Puter.js is not installed`

Run `npm install` from the repository root so `@heyputer/puter.js` is installed and the lockfile is updated.

### Browser login does not open

Set `PUTER_AUTH_TOKEN` for the daemon process and restart the app. Keep the token outside source control.

### Model not found or unsupported tool call

Choose another model exposed by Puter and set it in `PUTER_MODEL`. The selected model must support function calling.

### A command is rejected

Use an existing package script such as `npm test` or `npm run typecheck`. To expose another package manager, add only its command name to `PUTER_ALLOWED_COMMANDS`; a code change is still required to define safe subcommands for a new command family.

### A run cannot resume after restarting the daemon

Puter conversation state is currently held in daemon memory. Start a new approved run after a daemon restart. Existing evidence and repository changes remain on disk through the normal run lifecycle.
