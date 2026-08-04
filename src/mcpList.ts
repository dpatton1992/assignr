import { relative } from "node:path";
import type { Status } from "./constants.js";
import { STATUSES } from "./constants.js";
import type { LoadTaskTier, TaskTier } from "./specs/loadTasks.js";
import { loadTasks } from "./specs/loadTasks.js";

const TASK_TIER_FILTERS = ["active", "completed", "archived", "all"] as const;

export interface McpListFilters {
  status?: string;
  tier?: string;
  domain?: string;
}

export interface McpTaskSummary {
  id: string;
  title: string;
  status: Status;
  domain: string;
  priority: string;
  tier: TaskTier;
  dep_count: number;
}

function isTaskTierFilter(value: string): value is LoadTaskTier {
  return TASK_TIER_FILTERS.includes(value as LoadTaskTier);
}

function isTaskStatus(value: string): value is Status {
  return STATUSES.includes(value as Status);
}

export function listTasksForMcp(
  specsTasksDir: string,
  cwd: string,
  filters: McpListFilters = {},
): McpTaskSummary[] {
  const tier: LoadTaskTier =
    filters.tier && isTaskTierFilter(filters.tier)
      ? filters.tier
      : filters.status && isTaskTierFilter(filters.status)
        ? filters.status
        : filters.status && isTaskStatus(filters.status)
          ? "all"
          : "active";
  const status = filters.status && isTaskStatus(filters.status) ? filters.status : undefined;
  const { tasks, errors } = loadTasks(specsTasksDir, tier);

  if (errors.length > 0) {
    const message = errors
      .map((error) => `${relative(cwd, error.filePath)}: ${error.error}`)
      .join("; ");
    throw new Error(`Cannot load tasks: ${message}`);
  }

  return tasks
    .filter((task) => (status ? task.spec.status === status : true))
    .filter((task) => (filters.domain ? task.spec.domain === filters.domain : true))
    .map(({ spec, tier: taskTier }) => ({
      id: spec.id,
      title: spec.title,
      status: spec.status,
      domain: spec.domain,
      priority: spec.priority,
      tier: taskTier,
      dep_count: spec.depends_on?.length ?? 0,
    }));
}
