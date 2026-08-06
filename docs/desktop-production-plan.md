# Windows desktop production plan

This document tracks issue #3. It is deliberately stacked on the Phase 3 branch so that
the mandatory approval, runtime-validation, and correction gates remain the release baseline.

## Goal

Ship Personal Codex Agent as an installed, self-contained Windows application. A normal user
must be able to install, start, set up, repair, update, diagnose, and uninstall it without a
repository checkout, Node.js, npm, a terminal, or a manually started daemon.

The renderer remains unprivileged. Desktop lifecycle, filesystem access, managed downloads, and
process execution remain in the Electron main process or the daemon behind narrow, validated IPC.

## Delivery sequence

1. Record the baseline audit and centralize product version, application paths, compatibility
   data, structured logging, and production/developer diagnostics.
2. Add a single-instance production daemon manager which starts the bundled daemon on a random
   loopback port with a per-launch bearer token, waits for an authenticated health response, and
   owns bounded restart, retry, shutdown, safe mode, and diagnostic export.
3. Replace the connection-file-only desktop startup with explicit renderer startup states,
   recovery actions, and preload APIs that expose no Node or broad filesystem capability.
4. Make the daemon distributable: bundle its runtime dependencies, preserve required native
   binaries outside ASAR where necessary, and test the production entry point without system
   Node/npm/npx/tsx.
5. Replace the development packager flow with reproducible Windows installer and portable
   artifacts, per-user NSIS installation, upgrade-safe application-data handling, uninstall
   behavior, signing hooks, and package verification.
6. Add first-run setup state, consent-first managed dependency installation, secure download
   verification, optional GitHub/Ollama/VS Code integrations, repair, migration, logs, and
   update-readiness checks.
7. Add Windows release CI, packaged smoke coverage, documentation, user-facing troubleshooting,
   and final validation evidence.

## Acceptance evidence

- An installer named `Personal-Codex-Agent-Setup-<version>-x64.exe` and a portable artifact are
  emitted below `artifacts/`.
- The packaged app starts its own loopback-only daemon with a dynamic port and high-entropy token,
  and the renderer receives those values only after a successful readiness check.
- No repository source, development `node_modules`, system Node/npm, `npx`, or `tsx` is required
  by the installed application.
- Installer upgrades preserve user data; uninstall removes application files and gives a clear
  user choice for application data. Code signing is either verified or explicitly reported as
  unavailable rather than bypassed.
- Setup, repair, and diagnostics are executable from the UI; optional integrations are opt-in and
  their failures do not prevent core offline operation.
- Unit, integration, and Windows packaging checks pass. A clean-machine test is either executed
  and recorded, or explicitly recorded as an external limitation with reproducible steps.

## Scope boundaries

This release does not claim to install or authenticate paid/cloud services without user consent,
does not silently elevate privileges, does not expose daemon tokens or stored secrets in logs or
diagnostic exports, and does not claim auto-update until a signed update feed and hosting are
provided.
