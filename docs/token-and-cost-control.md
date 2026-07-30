# Token and cost control

The application records normalized input, cached-input, output, and reasoning tokens; latency; and estimated or actual cost by run, task, provider, and model. Unknown provider values remain `null` rather than being invented.

Before routing, context minimization ranks changed and relevant files first and omits files beyond the token ceiling. Stable cache keys include provider, model, role, task description, and sorted relevant paths. Provider caching is requested only when supported.

Budgets can be set per task, per run, per day, and per month. Reservations include concurrent work so parallel workers cannot each spend the same remaining allowance. A route over any configured ceiling is rejected before execution.

Actual cost is preferred when returned; otherwise configured per-million-token prices produce an estimate. Local work is reported separately. A low-priced model is not economical if missing capabilities cause repeated retries, so bounded fallback and verification are part of cost control.
