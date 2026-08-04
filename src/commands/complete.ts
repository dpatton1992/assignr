import picocolors from "picocolors";
import { loadConfig } from "../config.js";
import { completeTask } from "../lifecycle/taskLifecycleService.js";
import { getPaths } from "../utils/paths.js";
import { colorForStatus } from "../utils/styling.js";

export interface CompleteCommandOptions {
  specsTasksDir: string;
  completedDir: string;
  cwd: string;
}

export function completeCommand(taskId: string, options: CompleteCommandOptions): void {
  const { specsTasksDir, completedDir, cwd } = options;
  let paths: ReturnType<typeof getPaths>;
  try {
    const config = loadConfig(cwd);
    paths = getPaths(cwd, config.root);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
    return;
  }

  const result = completeTask(taskId, {
    specsTasksDir,
    completedDir,
    controlRepo: cwd,
    worktreesDir: paths?.worktrees,
  });
  if (!result.ok) {
    console.error(result.message ?? "Task completion failed.");
    process.exit(1);
    return;
  }

  console.log(
    `${picocolors.green("Completed:")} ${taskId} ${picocolors.yellow("→")} ${colorForStatus("complete")(result.updatedPath.replace(`${cwd}/`, ""))}`,
  );
}
