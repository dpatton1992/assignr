import picocolors from "picocolors";
import { ReviewActionError, reopenTask } from "../lifecycle/taskLifecycleService.js";
import { colorForStatus } from "../utils/styling.js";

export interface ReopenCommandOptions {
  specsTasksDir: string;
  activeDir: string;
  cwd: string;
}

export function reopenCommand(taskId: string, options: ReopenCommandOptions): void {
  try {
    const result = reopenTask(taskId, options);

    console.log(
      `${picocolors.blue("Reopened:")} ${result.taskId} ${picocolors.yellow("→")} ${colorForStatus("in_progress")(result.taskPath)}`,
    );
  } catch (error) {
    if (error instanceof ReviewActionError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
