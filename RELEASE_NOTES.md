# Personal Codex Agent 0.2.0

This initial development release provides the complete local prompt-alignment and approved Codex
execution architecture for one Windows user. It includes deterministic offline tests and unsigned
development packaging.

Live GitHub lifecycle validation requires installing/authenticating GitHub CLI. Live Codex execution
requires `codex login`. Deployment remains intentionally disabled until each target repository
defines staging, production smoke tests, and rollback commands. Back up local SQLite state and
project run reports before upgrading or uninstalling.
