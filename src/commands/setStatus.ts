import picocolors from "picocolors";
import { loadConfig } from "../config.js";
import type { Status } from "../constants.js";
import {
  setTaskStatus as setTaskStatusService,
  setTaskStatusWithLifecycle,
} from "../lifecycle/taskLifecycleService.js";
import { getPaths } from "../utils/paths.js";
import { colorForStatus } from "../utils/styling.js";

export function setStatusCommand(
  taskId: string,
  newStatus: Status,
  specsTasksDir: string,
  cwd: string,
): void {
  let paths: ReturnType<typeof getPaths>;
  try {
    const config = loadConfig(cwd);
    paths = getPaths(cwd, config.root);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
    return;
  }

  const result = setTaskStatusWithLifecycle(taskId, newStatus, {
    specsTasksDir,
    controlRepo: cwd,
    worktreesDir: paths?.worktrees,
  });
  if (!result.ok) {
    console.error(result.message ?? "Task status update failed.");
    process.exit(1);
    return;
  }
  console.log(
    `Updated: ${result.updatedPath.replace(`${cwd}/`, "")}\n` +
      `  ${colorForStatus(result.previousStatus)(result.previousStatus)} ${picocolors.yellow("→")} ${colorForStatus(result.newStatus)(result.newStatus)}`,
  );
}

export interface SetTaskStatusResult {
  taskId: string;
  previousStatus: string;
  newStatus: Status;
  updatedPath: string;
}

/**
 * Bare status transition used by worktree tooling. Claim-state synchronization
 * and direct-completion guards are owned by the lifecycle service.
 */
export function setTaskStatus(
  taskId: string,
  newStatus: Status,
  specsTasksDir: string,
): SetTaskStatusResult {
  const result = setTaskStatusService(taskId, newStatus, specsTasksDir);
  if (!result.ok) {
    throw new Error(result.message ?? "Task status update failed.");
  }
  return {
    taskId: result.taskId,
    previousStatus: result.previousStatus,
    newStatus: result.newStatus,
    updatedPath: result.updatedPath,
  };
}
