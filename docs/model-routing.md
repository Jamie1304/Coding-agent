# Model routing

Routing is deterministic and observable. It first classifies the task as trivial, small, medium, large, or critical, then rejects ineligible models before scoring the remainder.

Hard rejection covers disabled or unavailable models, missing role/tool/vision support, inadequate context, privacy violations, missing cloud approval, provider outages or rate limits, and task/run/daily budget violations. Capability always outranks price.

Eligible models are scored using capability, reliability, latency, configured price, cache benefit, and privacy. Ties are resolved by provider ID and model ID, making simulations reproducible. Historical reliability is ignored until the configured minimum sample count is reached.

Profiles:

- **Maximum savings** prefers local/economy routes and strict caps.
- **Balanced** optimizes expected cost per verified result and is the default.
- **Maximum quality** raises capability and independent-verification preference.
- **Maximum privacy** rejects cloud routes for sensitive work and supports local-only operation.
- **Custom** allows policy editing through the daemon contract.

Every decision records selected provider/model, reason codes, rejected candidates, estimated tokens/cost, fallback chain, verification policy, and parallel eligibility. The simulator performs no paid call. A live call requires an explicit confirmation flag.

Coding tasks that modify a repository are not executed through a stateless provider. They remain in the approved Codex workflow with workspace validation, worktree isolation, diff review, tests, Git lifecycle, and audit logs.
