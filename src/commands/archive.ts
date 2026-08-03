import { colorForStatus } from "../utils/styling.js";
import picocolors from "picocolors";
import { archiveTask } from "../lifecycle/taskLifecycleService.js";

export interface ArchiveCommandOptions {
  specsTasksDir: string;
  archivedDir: string;
  cwd: string;
}

export function archiveCommand(taskId: string, options: ArchiveCommandOptions): void {
  const { specsTasksDir, archivedDir, cwd } = options;
  const result = archiveTask(taskId, { specsTasksDir, archivedDir });
  if (!result.ok) {
    console.error(result.message ?? "Task archival failed.");
    process.exit(1);
  }

  console.log(`${picocolors.dim("Archived:")} ${taskId} ${picocolors.yellow("→")} ${colorForStatus("archived")(result.updatedPath.replace(cwd + "/", ""))}`);
}
