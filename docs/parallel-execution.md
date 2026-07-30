# Parallel execution

The scheduler accepts a validated task DAG and enforces global and per-provider concurrency limits. A task starts only when all dependencies pass and provider capacity is available.

Repository-writing workers must declare file ownership. Case-insensitive overlaps are rejected before work begins. Code workers are expected to use separate Git worktrees; integration and complete validation remain serial. Deployment and other production actions must not be parallelized.

Worker failure blocks dependents. Cancellation immediately aborts active workers and marks queued work cancelled. Cycles, unknown dependencies, and ownership collisions are hard errors rather than guessed schedules.

Parallel workers share the run budget. Results are not considered integrated until changes are merged, conflicts are resolved, and the complete quality suite passes.
