# Codex integration

Research was refreshed from the official Codex manual on 2026-07-30 and checked against the locally
installed `codex-cli 0.146.0-alpha.3.1`.

## Selected interface

The default provider uses `codex app-server` over its stable stdio JSONL transport. The
[official app-server documentation](https://developers.openai.com/codex/app-server/) describes it as
the interface for rich clients needing authentication, conversation history, approvals, and
streamed events. It provides the capabilities this desktop client needs:

- `initialize` / `initialized` connection handshake.
- `thread/start` and `thread/resume`.
- `turn/start`, streamed `item/*` and `turn/*` notifications.
- structured agent-message, command-execution, and file-change items.
- server-initiated approval requests.
- `turn/interrupt` cancellation.
- per-thread/turn cwd, sandbox policy, and approval policy.
- JSON-RPC errors and process-exit detection.

The provider starts `codex app-server --listen stdio://`, identifies itself as
`personal_codex_agent`, correlates responses by request ID, applies request timeouts, and maps
version-specific wire events into a small stable `CodexEvent` union.

## Alternatives evaluated

- The [Codex SDK](https://developers.openai.com/codex/sdk/) is simpler for CI and one-shot automation,
  but app-server exposes richer client lifecycle and approval events.
- [Non-interactive `codex exec`](https://developers.openai.com/codex/noninteractive/) is useful for
  pipelines and emits JSONL with `--json`, but thread ownership and interactive approvals are less
  natural for this desktop client.
- Automating the graphical app or scraping an interactive terminal was rejected as unsupported and
  brittle.

Change the provider by implementing `CodexProvider` and injecting it into `createDaemon`. The fake
provider is deterministic and covers availability, authentication, thread creation/resume, messages,
commands, file changes, errors, cancellation, and completion without claiming live execution.

## Authentication

Run `codex login` for ChatGPT sign-in or provide an API key through the supported CLI login flow.
Check with `codex login status`. Codex CLI and the official IDE extension share the local credential
cache. Prefer OS keyring storage:

```toml
# %USERPROFILE%\.codex\config.toml
cli_auth_credentials_store = "keyring"
```

Never copy `auth.json` into this repository. The daemon does not read or transmit credential files;
the Codex executable owns authentication.

## Security and errors

Review is read-only. Approved implementation uses `sandboxPolicy: workspace-write` and
`approvalPolicy: on-request`, scoped to the isolated worktree. Approval requests block the automated
run and are reported instead of silently widening permissions. Interruptions, malformed JSON,
request timeouts, app-server exit, non-completed turns, and provider unavailability are explicit
errors. The executable path is configurable with `CODEX_EXECUTABLE`.

App-server schemas are version-specific. For a provider upgrade, generate and diff the installed
schema:

```powershell
codex app-server generate-ts --out .\tmp\codex-schema
codex app-server generate-json-schema --out .\tmp\codex-json-schema
```
