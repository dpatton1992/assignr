import { relative } from "node:path";
import type { LoadedTaskWithTier } from "../specs/loadTasks.js";
import { loadTasks } from "../specs/loadTasks.js";
import type { LoadedTask } from "../specs/schema.js";
import type { McpRepoContext } from "./context.js";

export function findTask(taskId: string, ctx: McpRepoContext): LoadedTask | undefined {
  return loadTasks(ctx.paths.specsTasks, "all").tasks.find((task) => task.spec.id === taskId);
}

export function loadTasksOrError(ctx: McpRepoContext): LoadedTaskWithTier[] {
  const { tasks, errors } = loadTasks(ctx.paths.specsTasks, "all");
  if (errors.length > 0) {
    const message = errors
      .map((error) => `${relative(ctx.cwd, error.filePath)}: ${error.error}`)
      .join("; ");
    throw new Error(`Cannot load tasks: ${message}`);
  }
  return tasks;
}
