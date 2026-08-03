import picocolors from "picocolors";
import type { ReviewActionOptions } from "../lifecycle/taskLifecycleService.js";
import {
  blockReview as blockReviewAction,
  ReviewActionError,
} from "../lifecycle/taskLifecycleService.js";
import { colorForStatus } from "../utils/styling.js";

export function blockReviewCommand(
  taskId: string,
  reason: string,
  options: ReviewActionOptions,
): void {
  try {
    const result = blockReviewAction(taskId, reason, options);

    console.log(`Recorded review outcome: ${result.outcomePath}`);
    console.log(
      `Updated: ${result.taskPath}\n` +
        `  ${colorForStatus(result.previousStatus)(result.previousStatus)} ${picocolors.yellow("→")} ${colorForStatus(result.nextStatus)(result.nextStatus)}`,
    );
  } catch (error) {
    if (error instanceof ReviewActionError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
