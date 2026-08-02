import type { ManciplePaths } from "../utils/paths.js";
import {
  getReviewQueue,
  getTaskReviewPacket,
} from "../review/reviewPacket.js";
import type {
  ReviewDecisionId,
  ReviewPacket,
  ReviewPacketContext,
  ReviewQueueSummary,
} from "../review/reviewPacket.js";
import {
  approveTask,
  blockReview,
  rejectTask,
  reopenTask,
  requestChanges,
} from "../review/reviewActions.js";
import type { ReviewActionOptions, ReviewActionResult } from "../review/reviewActions.js";

/**
 * ReviewService is the only data boundary the TUI depends on. Components must
 * never read task YAML, run logs, git state, generated prompts, or Manciple
 * directories directly; queue rows and selected-task evidence arrive through
 * getReviewQueue()/getTaskReviewPacket() and lifecycle mutations go through
 * the shared review action service.
 *
 * Tests inject a fake implementation of this interface.
 */
export interface ReviewService {
  getQueue(): ReviewQueueSummary;
  getPacket(taskId: string): ReviewPacket;
  applyDecision(
    action: ReviewDecisionId,
    taskId: string,
    reason?: string
  ): ReviewActionResult;
}

export function createReviewService(p: ManciplePaths, cwd: string): ReviewService {
  const packetContext: ReviewPacketContext = {
    specsTasksDir: p.specsTasks,
    cwd,
    generatedDir: p.promptsGenerated,
    activeDir: p.tasksActive,
    completedDir: p.tasksCompleted,
    archivedDir: p.tasksArchived,
  };
  const actionOptions: ReviewActionOptions = {
    specsTasksDir: p.specsTasks,
    cwd,
    runsDir: p.runs,
    completedDir: p.tasksCompleted,
    activeDir: p.tasksActive,
    archivedDir: p.tasksArchived,
  };

  return {
    getQueue: () => getReviewQueue(packetContext),
    getPacket: (taskId: string) => getTaskReviewPacket(taskId, packetContext),
    applyDecision: (action: ReviewDecisionId, taskId: string, reason?: string) => {
      switch (action) {
        case "approve":
          return approveTask(taskId, actionOptions);
        case "request_changes":
          return requestChanges(taskId, reason ?? "", actionOptions);
        case "reject":
          return rejectTask(taskId, reason ?? "", actionOptions);
        case "block":
          return blockReview(taskId, reason ?? "", actionOptions);
        case "reopen":
          return reopenTask(taskId, actionOptions);
      }
    },
  };
}
