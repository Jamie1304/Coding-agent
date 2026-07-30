# Security model

## Assets and threats

Protected assets are source code, Git history, local credentials, deployment environments, run
evidence, and the user's machine. Threats include a malicious webpage reaching the daemon, renderer
compromise, path traversal or symlink escape, command injection, secret leakage in logs, untrusted
workspace code, conflicting repository runs, and accidental production deployment.

## Controls

- The daemon listens only on `127.0.0.1`; a 256-bit random token protects every privileged route.
- Request bodies have a size limit and Zod validation.
- Workspace roots must be absolute existing directories. Candidate paths resolve existing ancestors
  canonically, preventing `..` and symlink escapes.
- Command execution uses executable and argument arrays with `shell: false`, explicit cwd, timeout,
  output limit, cancellation, and real exit code.
- Secret-like API keys, GitHub tokens, passwords, and Authorization headers are redacted.
- The renderer has CSP, context isolation, sandboxing, Node disabled, navigation blocked, remote
  windows denied, and a minimal frozen preload bridge.
- VS Code Workspace Trust is propagated. Untrusted workspaces are not executed.
- Repository locks prevent two active implementations against the same path.
- Work happens in a sibling Git worktree; the starting commit is recorded.
- Prompt approval is a hard state-machine gate. Deployment is disabled unless a project explicitly
  configures commands; production requires rollback.
- Credentials stay with Codex CLI, GitHub CLI, or the OS keyring and are never persisted in SQLite.

## Known limitations

The local token is stored in `daemon.json` so the same Windows user and VS Code extension can connect;
another process running as that user may read it. This is a personal local-user security boundary,
not a multi-user isolation mechanism. The development desktop package is unsigned. Custom deployment
commands are trusted project configuration and must be code-reviewed. The lightweight secret
detector supplements, but does not replace, a configured dedicated scanner.
