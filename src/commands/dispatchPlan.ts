import { relative } from "node:path";
import { loadConfig } from "../config.js";
import type { DispatchPlan } from "../coordination/reviewQueue.js";
import { buildDispatchPlan } from "../coordination/reviewQueue.js";
import { loadTasks } from "../specs/loadTasks.js";
import { getPaths } from "../utils/paths.js";
import { isGitRepository, listManagedWorktrees } from "../worktrees/manager.js";

export function createDispatchPlan(
  specsTasksDir: string,
  cwd: string,
  options: { useWorktrees?: boolean } = {},
): DispatchPlan {
  const { tasks, errors } = loadTasks(specsTasksDir, "all");
  if (errors.length > 0) {
    const message = errors
      .map((error) => `${relative(cwd, error.filePath)}: ${error.error}`)
      .join("; ");
    throw new Error(`Cannot load tasks: ${message}`);
  }

  const config = loadConfig(cwd);
  const useWorktrees = options.useWorktrees ?? config.worktrees.enabled;
  const paths = getPaths(cwd, config.root);
  const records = isGitRepository(cwd)
    ? listManagedWorktrees({ controlRepo: cwd, worktreesDir: paths.worktrees, specsTasksDir })
    : [];
  if (!useWorktrees) {
    const activeIds = new Set(
      tasks.filter((task) => task.tier === "active").map((task) => task.spec.id),
    );
    const conflicts = records.filter((record) => activeIds.has(record.taskId));
    if (conflicts.length > 0) {
      throw new Error(
        `Cannot dispatch in-place while active tasks have managed worktrees: ${conflicts.map((record) => record.taskId).join(", ")}. ` +
          "Remove those worktrees before using --no-worktrees.",
      );
    }
  }
  return buildDispatchPlan(tasks, {
    executionMode: useWorktrees ? "worktree" : "in_place",
    dependenciesRequireComplete: useWorktrees,
    controlRepo: cwd,
    worktreesDir: paths.worktrees,
    preparedWorktrees: new Map(
      (useWorktrees ? records : []).map((record) => [
        record.taskId,
        {
          workspacePath: record.workspacePath,
          branch: record.branch,
          baseSha: record.baseSha,
          claimState: record.claimState,
        },
      ]),
    ),
  });
}

export function dispatchPlanCommand(
  specsTasksDir: string,
  cwd: string,
  options: { useWorktrees?: boolean } = {},
): void {
  try {
    console.log(JSON.stringify(createDispatchPlan(specsTasksDir, cwd, options), null, 2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
