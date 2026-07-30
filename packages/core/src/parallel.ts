import type { TaskDescriptor } from "@agent/ai";

export interface ParallelTaskResult<T = unknown> {
  taskId: string;
  state: "passed" | "failed" | "cancelled" | "blocked";
  value?: T;
  error?: string;
}

export class ParallelTaskScheduler {
  private cancelled = false;
  private activeControllers = new Set<AbortController>();

  constructor(
    private readonly maximumConcurrency: number,
    private readonly providerLimits: Record<string, number> = {}
  ) {
    if (maximumConcurrency < 1) throw new Error("Maximum concurrency must be positive");
  }

  cancel(): void {
    this.cancelled = true;
    for (const controller of this.activeControllers) controller.abort();
  }

  async run<T>(
    tasks: TaskDescriptor[],
    providerForTask: (task: TaskDescriptor) => string,
    worker: (task: TaskDescriptor, signal: AbortSignal) => Promise<T>
  ): Promise<ParallelTaskResult<T>[]> {
    validateGraph(tasks);
    validateOwnership(tasks);
    const results = new Map<string, ParallelTaskResult<T>>();
    const running = new Map<
      string,
      { promise: Promise<void>; provider: string; controller: AbortController }
    >();

    while (results.size < tasks.length) {
      if (this.cancelled) {
        for (const item of running.values()) item.controller.abort();
        for (const task of tasks) {
          if (!results.has(task.id) && !running.has(task.id)) {
            results.set(task.id, { taskId: task.id, state: "cancelled" });
          }
        }
      }
      for (const task of tasks) {
        if (results.has(task.id) || running.has(task.id) || running.size >= this.maximumConcurrency)
          continue;
        const dependencyResults = task.dependencies.map((id) => results.get(id));
        if (
          dependencyResults.some(
            (result) => result?.state === "failed" || result?.state === "blocked"
          )
        ) {
          results.set(task.id, { taskId: task.id, state: "blocked", error: "Dependency failed" });
          continue;
        }
        if (dependencyResults.some((result) => !result)) continue;
        const provider = providerForTask(task);
        const activeForProvider = [...running.values()].filter(
          (item) => item.provider === provider
        ).length;
        if (activeForProvider >= (this.providerLimits[provider] ?? this.maximumConcurrency))
          continue;
        const controller = new AbortController();
        this.activeControllers.add(controller);
        const promise = worker(task, controller.signal)
          .then((value) => {
            results.set(task.id, { taskId: task.id, state: "passed", value });
          })
          .catch((error: unknown) => {
            results.set(task.id, {
              taskId: task.id,
              state: controller.signal.aborted ? "cancelled" : "failed",
              error: error instanceof Error ? error.message : String(error)
            });
          })
          .finally(() => {
            running.delete(task.id);
            this.activeControllers.delete(controller);
          });
        running.set(task.id, { promise, provider, controller });
      }
      if (running.size === 0) {
        if (results.size < tasks.length) throw new Error("Task DAG cannot make progress");
        break;
      }
      await Promise.race([...running.values()].map((item) => item.promise));
    }
    await Promise.all([...running.values()].map((item) => item.promise));
    return tasks.map((task) => results.get(task.id) ?? { taskId: task.id, state: "blocked" });
  }
}

export function validateOwnership(tasks: TaskDescriptor[]): void {
  const owners = new Map<string, string>();
  for (const task of tasks.filter((item) => item.repositoryWrite)) {
    for (const file of task.likelyFiles.map((value) => value.toLowerCase())) {
      const owner = owners.get(file);
      if (owner && owner !== task.id) {
        throw new Error(`Overlapping file ownership: ${file} (${owner}, ${task.id})`);
      }
      owners.set(file, task.id);
    }
  }
}

function validateGraph(tasks: TaskDescriptor[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) throw new Error(`Unknown task dependency: ${dependency}`);
    }
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (id: string): void => {
    if (active.has(id)) throw new Error("Task dependency cycle detected");
    if (visited.has(id)) return;
    active.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    active.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}
