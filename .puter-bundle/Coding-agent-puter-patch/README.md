# Puter coding-agent patch for Personal Codex Agent

This bundle adds Puter.js as a repository-writing implementation provider for Jamie1304/Coding-agent. It keeps the existing prompt-approval, isolated-worktree, quality-gate, reporting, GitHub, and deployment orchestration, while replacing the Codex app-server implementation turn when `AGENT_CODEX_PROVIDER=puter`.

## Apply on Windows

From PowerShell, after extracting this bundle:

```powershell
.\apply-puter.ps1 -RepositoryPath "C:\path\to\Coding-agent"
```

The script checks and applies `puter-agent.patch`, runs `npm install` to update `package-lock.json`, copies `.env.example` to `.env` only when `.env` is absent, type-checks the repository, runs the Puter provider unit tests, and builds the daemon.

## Apply on macOS or Linux

```sh
./apply-puter.sh /path/to/Coding-agent
```

The upstream application is Windows-first, but the provider itself uses cross-platform Node APIs. Windows Credential Manager token persistence is Windows-only; use `PUTER_AUTH_TOKEN` for headless or non-Windows runs.

## Start

```powershell
npm run dev
```

The patched `.env.example` selects Puter and defaults to:

```dotenv
AGENT_CODEX_PROVIDER=puter
PUTER_MODEL=openai/gpt-5.3-codex
```

When `PUTER_AUTH_TOKEN` is empty, the first provider authentication attempts Puter's browser login. On Windows, the token is stored through the project's existing `@napi-rs/keyring` dependency.

## Included changes

- New `PuterCodexProvider` implementing the repository-writing `CodexProvider` interface.
- Puter function-calling loop with file inspection, exact search, writes, replacements, deletion, restricted verification commands, and explicit completion.
- Provider selection in the daemon through `AGENT_CODEX_PROVIDER`.
- Puter.js 2.6.0 dependency and environment configuration.
- Path containment, symlink checks, protected Git metadata, secret-file blocking, output limits, command allowlists, timeouts, and cancellation.
- Unit tests and integration documentation.

## Important boundaries

Puter's user-pays design means the application developer does not supply an OpenAI API key or directly pay each user's model bill. It does not guarantee unlimited free usage for every end user; account allowances or charges can still apply.

The Puter provider does not reproduce the Codex app-server's operating-system sandbox. It limits the tools it exposes, preserves the application's isolated worktree, and sanitizes command execution, but approved repository scripts still execute as the current operating-system user. Review unfamiliar repositories before approving runs.

Puter thread history is in daemon memory in this patch. A daemon restart requires a new run.

## Validation performed before packaging

- Strict TypeScript compilation with `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- Mocked end-to-end tool loop that wrote a file and completed successfully.
- Security harnesses for path traversal, secret-file access, read-only tool exposure, and destructive Git commands.
- `git apply --check` against reconstructed upstream versions of every modified file.

A live Puter request was not made because this environment has no user Puter account or authentication token. The complete upstream test suite was not run because the GitHub repository could not be cloned into the execution container; the included apply script runs checks in the user's actual checkout after dependencies are installed.
