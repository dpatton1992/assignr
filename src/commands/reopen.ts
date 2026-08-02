import { reopenTask, ReviewActionError } from "../review/reviewActions.js";
import { colorForStatus } from "../utils/styling.js";
import picocolors from "picocolors";

export interface ReopenCommandOptions {
  specsTasksDir: string;
  activeDir: string;
  cwd: string;
}

export function reopenCommand(taskId: string, options: ReopenCommandOptions): void {
  try {
    const result = reopenTask(taskId, options);

    console.log(`${picocolors.blue("Reopened:")} ${result.taskId} ${picocolors.yellow("→")} ${colorForStatus("in_progress")(result.taskPath)}`);
  } catch (error) {
    if (error instanceof ReviewActionError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
