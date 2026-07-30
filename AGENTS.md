# Personal Codex Agent repository guidance

- Use Node.js 22 or newer and npm workspaces.
- Keep privileged operations in the daemon or core packages; never expose Node APIs to the renderer.
- Preserve approval gating: repository writes and Codex implementation turns may start only after a prompt revision is frozen.
- All shell commands must use argument arrays, explicit working directories, timeouts, output limits, and real exit codes.
- Add or update tests for behavior changes.
- Before completion run `npm run validate`.
