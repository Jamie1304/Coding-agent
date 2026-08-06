import type { RoutingStrategy, TaskDescriptor } from "@agent/shared";
import type { DiscoveredModel } from "@agent/ai";

export interface TaskGraphNode {
  taskId: string;
  role: string;
  title: string;
  dependencies: string[];
  assignedModel?: DiscoveredModel;
  estimatedCost: number;
  owner?: string;
  risk: "low" | "medium" | "high";
}

export interface TaskGraph {
  runId: string;
  strategyId: string;
  nodes: Map<string, TaskGraphNode>;
  edges: Array<{ from: string; to: string }>;
  criticalPath: string[];
}

export interface PlanContext {
  strategy: RoutingStrategy;
  tasks: TaskDescriptor[];
  availableModels: DiscoveredModel[];
  runId: string;
}

/**
 * Task graph integration system that connects strategy to planning and scheduling.
 *
 * Workflow:
 * 1. Build dependency graph from task descriptors
 * 2. Assign roles based on strategy routing policies
 * 3. Select models for each task using strategy constraints
 * 4. Calculate critical path and identify parallelization opportunities
 * 5. Track ownership and risk levels
 */
export class TaskGraphPlanner {
  buildGraph(context: PlanContext): TaskGraph {
    const graph: TaskGraph = {
      runId: context.runId,
      strategyId: context.strategy.id,
      nodes: new Map(),
      edges: [],
      criticalPath: []
    };

    // Create nodes from tasks
    for (const task of context.tasks) {
      const node: TaskGraphNode = {
        taskId: task.id,
        role: task.role,
        title: task.title,
        dependencies: task.dependencies || [],
        estimatedCost: 0,
        risk: task.risk,
        owner: this.assignOwner(task, context.strategy)
      };

      graph.nodes.set(task.id, node);
    }

    // Build edges
    for (const task of context.tasks) {
      for (const dep of task.dependencies || []) {
        graph.edges.push({ from: dep, to: task.id });
      }
    }

    // Calculate critical path
    graph.criticalPath = this.calculateCriticalPath(graph);

    return graph;
  }

  assignModelsToGraph(
    graph: TaskGraph,
    strategy: RoutingStrategy,
    availableModels: DiscoveredModel[],
    taskMap: Map<string, TaskDescriptor>
  ): void {
    for (const node of graph.nodes.values()) {
      const task = taskMap.get(node.taskId);
      if (!task) continue;

      // Find routing policy for this role
      const rolePolicy = strategy.roles[node.role];
      if (!rolePolicy) {
        // Fall back to any available model
        node.assignedModel = this.selectDefaultModel(availableModels);
        node.estimatedCost = this.estimateTaskCost(node.assignedModel, task);
        continue;
      }

      // Apply role-specific constraints
      const filteredModels = this.filterByRolePolicy(availableModels, rolePolicy, task);
      if (filteredModels.length > 0) {
        node.assignedModel = this.selectBestModel(filteredModels, strategy.objective);
        node.estimatedCost = this.estimateTaskCost(node.assignedModel, task);
      }
    }
  }

  calculateTotalCost(graph: TaskGraph): number {
    return Array.from(graph.nodes.values()).reduce((sum, node) => sum + node.estimatedCost, 0);
  }

  calculateParallelizableGroups(graph: TaskGraph): string[][] {
    const groups: string[][] = [];
    const visited = new Set<string>();

    for (const nodeId of graph.nodes.keys()) {
      if (visited.has(nodeId)) continue;

      const group = this.getParallelizableSet(nodeId, graph, visited);
      if (group.length > 0) {
        groups.push(group);
        group.forEach((id) => visited.add(id));
      }
    }

    return groups;
  }

  identifyContextMinimization(
    graph: TaskGraph,
    strategy: RoutingStrategy
  ): Map<string, string[]> {
    const contextMap = new Map<string, string[]>();

    for (const node of graph.nodes.values()) {
      const role = node.role;
      const rolePolicy = strategy.roles[role];

      if (rolePolicy?.contextPolicy?.excludePatterns) {
        contextMap.set(node.taskId, rolePolicy.contextPolicy.excludePatterns);
      }
    }

    return contextMap;
  }

  private assignOwner(task: TaskDescriptor, strategy: RoutingStrategy): string | undefined {
    const rolePolicy = strategy.roles[task.role];
    return rolePolicy?.ownerName;
  }

  private calculateCriticalPath(graph: TaskGraph): string[] {
    const pathLengths = new Map<string, number>();

    // Topological sort
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const dfs = (nodeId: string): number => {
      if (pathLengths.has(nodeId)) {
        return pathLengths.get(nodeId)!;
      }

      if (visiting.has(nodeId)) {
        return 0; // Cycle detected
      }

      visiting.add(nodeId);

      const node = graph.nodes.get(nodeId);
      if (!node) return 0;

      let maxDep = 0;
      for (const dep of node.dependencies) {
        maxDep = Math.max(maxDep, dfs(dep));
      }

      visiting.delete(nodeId);
      const length = maxDep + 1;
      pathLengths.set(nodeId, length);
      visited.add(nodeId);

      return length;
    };

    // Calculate lengths for all nodes
    for (const nodeId of graph.nodes.keys()) {
      dfs(nodeId);
    }

    // Find longest path
    let longest = 0;
    let endNode = "";
    for (const [nodeId, length] of pathLengths) {
      if (length > longest) {
        longest = length;
        endNode = nodeId;
      }
    }

    // Reconstruct path
    const path: string[] = [];
    let current = endNode;
    const visited2 = new Set<string>();

    while (current && !visited2.has(current)) {
      path.unshift(current);
      visited2.add(current);

      const node = graph.nodes.get(current);
      const deps = node?.dependencies || [];
      if (deps.length === 0) break;

      // Find dependency with longest path
      let longestDep = "";
      let longestDepLength = 0;
      for (const dep of deps) {
        const depLength = pathLengths.get(dep) || 0;
        if (depLength > longestDepLength) {
          longestDepLength = depLength;
          longestDep = dep;
        }
      }

      current = longestDep;
    }

    return path;
  }

  private filterByRolePolicy(
    models: DiscoveredModel[],
    rolePolicy: any,
    task: TaskDescriptor
  ): DiscoveredModel[] {
    return models.filter((model) => {
      // Check role membership
      if (rolePolicy.availableProviderIds && !rolePolicy.availableProviderIds.includes(model.providerId)) {
        return false;
      }

      // Check capability requirements
      if (rolePolicy.requiredCapabilities) {
        if (rolePolicy.requiredCapabilities.includes("tools") && !model.supportsTools) {
          return false;
        }
        if (rolePolicy.requiredCapabilities.includes("vision") && !model.supportsVision) {
          return false;
        }
        if (rolePolicy.requiredCapabilities.includes("repository-write") && !model.supportsRepositoryWrite) {
          return false;
        }
      }

      return true;
    });
  }

  private selectBestModel(
    models: DiscoveredModel[],
    objective: any
  ): DiscoveredModel {
    // Simple selection: prefer by reliability then latency
    return models.sort((a, b) => {
      const scoreA = (a.historicalSuccessRate || 0.5) * 100 - (a.averageLatencyMs || 5000) / 1000;
      const scoreB = (b.historicalSuccessRate || 0.5) * 100 - (b.averageLatencyMs || 5000) / 1000;
      return scoreB - scoreA;
    })[0] || models[0];
  }

  private selectDefaultModel(models: DiscoveredModel[]): DiscoveredModel {
    return models[0];
  }

  private estimateTaskCost(model: DiscoveredModel | undefined, task: TaskDescriptor): number {
    if (!model || !model.inputPricePerMillion || !model.outputPricePerMillion) {
      return 0;
    }

    const inputCost = (task.expectedInputTokens / 1_000_000) * model.inputPricePerMillion;
    const outputCost = (task.expectedOutputTokens / 1_000_000) * model.outputPricePerMillion;

    return inputCost + outputCost;
  }

  private getParallelizableSet(
    startId: string,
    graph: TaskGraph,
    visited: Set<string>
  ): string[] {
    const set: string[] = [startId];
    const queue = [startId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = graph.nodes.get(current)!;

      // Find tasks that can run in parallel with current
      for (const other of graph.nodes.keys()) {
        if (visited.has(other) || set.includes(other)) continue;

        const otherNode = graph.nodes.get(other)!;

        // Check if tasks are independent
        const canRunInParallel =
          !node.dependencies.includes(other) && !otherNode.dependencies.includes(current);

        if (canRunInParallel) {
          set.push(other);
          queue.push(other);
        }
      }
    }

    return set;
  }
}
