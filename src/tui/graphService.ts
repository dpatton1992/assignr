import type { TaskGraphOptions, TaskGraphPacket } from "../graph/taskGraphPacket.js";
import { getTaskGraphPacket } from "../graph/taskGraphPacket.js";
import type { ManciplePaths } from "../utils/paths.js";

/**
 * GraphService is the TUI's data boundary for task graph presentation.
 *
 * The graph view consumes TaskGraphPacket exclusively: it never reads task
 * YAML, run logs, readiness reports, or path-ownership state directly. Filter
 * options (focus task, depth, tier, status, domain, edge types, all-tasks
 * mode) are passed through to the shared packet assembler, and the returned
 * packet is the only thing the component renders.
 */
export interface GraphService {
  getGraph(options: TaskGraphOptions): TaskGraphPacket;
}

export function createGraphService(p: ManciplePaths, cwd: string): GraphService {
  return {
    getGraph: (options: TaskGraphOptions) =>
      getTaskGraphPacket(options, {
        specsTasksDir: p.specsTasks,
        cwd,
        generatedDir: p.promptsGenerated,
        activeDir: p.tasksActive,
        completedDir: p.tasksCompleted,
        archivedDir: p.tasksArchived,
      }),
  };
}
