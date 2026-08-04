import picocolors from "picocolors";
import { approveTask, ReviewActionError } from "../lifecycle/taskLifecycleService.js";

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
    console.log(
      `${picocolors.green("Approved:")} ${result.taskId} ${picocolors.yellow("→")} ${result.taskPath}`,
    );
    if (result.integration) {
      console.log(`Integrated: ${result.integration.branch} → ${result.integration.integratedSha}`);
    }
    for (const warning of result.cleanupWarnings ?? []) {
      console.warn(`Cleanup warning: ${warning}`);
    }
  } catch (error) {
    if (error instanceof ReviewActionError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
