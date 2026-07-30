# Provider troubleshooting

**Authentication failed:** replace the stored key, test again, and verify the account/project has API access. Authentication errors are not repeatedly retried.

**No models available:** refresh discovery and confirm the key can list models. Access is account-specific; model examples in documentation do not imply entitlement.

**Rate limited or quota exhausted:** inspect the provider account limits. The router records the failure and may use an eligible fallback within budget.

**Model unavailable:** refresh discovery. Removed models remain named in historical reports and are never silently replaced.

**Context limit:** reduce selected context or enable a larger-context model. The application does not truncate repository evidence silently.

**Custom endpoint failure:** use HTTPS for remote endpoints. Loopback HTTP is accepted for local servers. Confirm `/v1/models` and `/v1/chat/completions` compatibility.

**Ollama unavailable:** start the Ollama service and verify `http://127.0.0.1:11434/api/version`. No model is downloaded automatically.

**Credential repair:** delete and replace the stored key in the provider card. Exported configuration cannot restore credentials by design.

Database migration is transactional. Before replacing/importing configuration, stop the daemon and copy the SQLite database plus its `-wal` and `-shm` companions. To recover, restore all three while the daemon is stopped.
