import { approveTask, ReviewActionError } from "../review/reviewActions.js";
import picocolors from "picocolors";

export interface ReviewOutcomeCommandOptions {
  specsTasksDir: string;
  completedDir?: string;
  runsDir: string;
  cwd: string;
}

export function approveCommand(taskId: string, options: ReviewOutcomeCommandOptions): void {
  try {
    const result = approveTask(taskId, options);

    console.log(`Recorded review outcome: ${result.outcomePath}`);
    console.log(`${picocolors.green("Approved:")} ${result.taskId} ${picocolors.yellow("→")} ${result.taskPath}`);
  } catch (error) {
    if (error instanceof ReviewActionError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
