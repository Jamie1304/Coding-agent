# Personal Codex Agent 0.3.0

This release adds a production Windows packaging path: a per-user NSIS installer, a portable executable, a bundled Electron-owned daemon, authenticated startup compatibility checks, bounded recovery, safe mode, diagnostic export, repair, managed optional integrations, and release artifact verification.

The build is currently unsigned because no code-signing certificate is configured. Automatic updates remain unavailable until a signed update feed and publishing credentials are supplied. Clean-machine runtime execution was not completed on the build host because enterprise Application Control blocked the generated executable; installer and package verification completed successfully.
