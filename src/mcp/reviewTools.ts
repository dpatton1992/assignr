import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getReviewQueue,
  getTaskReviewPacket,
  ReviewPacketError,
} from "../review/reviewPacket.js";
import type { ReviewPacketContext } from "../review/reviewPacket.js";
import {
  approveTask,
  blockReview,
  rejectTask,
  reopenTask,
  requestChanges,
  ReviewActionError,
} from "../review/reviewActions.js";
import type { ReviewActionOptions } from "../review/reviewActions.js";
import { getRepoContext, repoInputSchema } from "./context.js";
import type { McpRepoContext } from "./context.js";
import { errorResult, jsonResult, toolResult } from "./results.js";

/**
 * Machine-readable review MCP adapters are thin layers over the assembled
 * ReviewPacket and shared review action services. They must not read task
 * YAML, run logs, generated prompts, git state, or lifecycle folders
 * directly; all evidence reads and lifecycle mutations happen inside
 * src/review/* services.
 *
 * Field names and enum values in the JSON results intentionally match the
 * CLI-facing application layer so web clients can consume one ReviewPacket
 * contract.
 */

export const REVIEW_DECISION_ACTIONS = [
  "approve",
  "request_changes",
  "reject",
  "block",
  "reopen",
] as const;

export type ReviewDecisionAction = (typeof REVIEW_DECISION_ACTIONS)[number];

const REVIEW_DECISION_ACTION_SCHEMA = z.enum(REVIEW_DECISION_ACTIONS);

const ACTIONS_REQUIRING_REASON: ReadonlySet<ReviewDecisionAction> = new Set([
  "request_changes",
  "reject",
  "block",
]);

function reviewPacketContext(ctx: McpRepoContext): ReviewPacketContext {
  return {
    specsTasksDir: ctx.paths.specsTasks,
    cwd: ctx.cwd,
    generatedDir: ctx.paths.promptsGenerated,
    activeDir: ctx.paths.tasksActive,
    completedDir: ctx.paths.tasksCompleted,
    archivedDir: ctx.paths.tasksArchived,
  };
}

function reviewActionOptions(ctx: McpRepoContext): ReviewActionOptions {
  return {
    specsTasksDir: ctx.paths.specsTasks,
    cwd: ctx.cwd,
    runsDir: ctx.paths.runs,
    completedDir: ctx.paths.tasksCompleted,
    activeDir: ctx.paths.tasksActive,
    archivedDir: ctx.paths.tasksArchived,
  };
}

export function applyReviewDecision(
  taskId: string,
  action: ReviewDecisionAction,
  reason: string | undefined,
  ctx: McpRepoContext
): ReturnType<typeof approveTask> {
  const options = reviewActionOptions(ctx);

  switch (action) {
    case "approve":
      return approveTask(taskId, options);
    case "request_changes":
      return requestChanges(taskId, reason ?? "", options);
    case "reject":
      return rejectTask(taskId, reason ?? "", options);
    case "block":
      return blockReview(taskId, reason ?? "", options);
    case "reopen":
      return reopenTask(taskId, options);
  }
}

export function registerReviewTools(server: McpServer): void {
  server.registerTool(
    "manciple_list_review_queue",
    {
      title: "List Manciple Review Queue",
      description:
        "Return the assembled review queue summary (needsReview, blocked, completed buckets) as the same JSON-safe service result as the CLI-facing application layer.",
      inputSchema: {
        ...repoInputSchema,
      },
    },
    ({ repo }) =>
      toolResult(() => {
        const ctx = getRepoContext(repo);
        return jsonResult(getReviewQueue(reviewPacketContext(ctx)));
      })
  );

  server.registerTool(
    "manciple_get_review_packet",
    {
      title: "Get Manciple Review Packet",
      description:
        "Return the assembled ReviewPacket for one task as the same JSON-safe service result as the CLI-facing application layer.",
      inputSchema: {
        ...repoInputSchema,
        task_id: z.string(),
      },
    },
    ({ repo, task_id }) =>
      toolResult(() => {
        const ctx = getRepoContext(repo);
        try {
          return jsonResult(getTaskReviewPacket(task_id, reviewPacketContext(ctx)));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof ReviewPacketError) return errorResult(message);
          throw err;
        }
      })
  );

  server.registerTool(
    "manciple_review_decision",
    {
      title: "Record Manciple Review Decision",
      description:
        "Record one review decision for a task using the shared review action service. Actions: approve, request_changes, reject, block, reopen. reason is required for request_changes, reject, and block.",
      inputSchema: {
        ...repoInputSchema,
        task_id: z.string(),
        action: REVIEW_DECISION_ACTION_SCHEMA.describe(
          "Review decision action: approve, request_changes, reject, block, or reopen."
        ),
        reason: z
          .string()
          .optional()
          .describe("Required for request_changes, reject, and block."),
      },
    },
    ({ repo, task_id, action, reason }) =>
      toolResult(() => {
        const ctx = getRepoContext(repo);
        if (ACTIONS_REQUIRING_REASON.has(action) && !reason?.trim()) {
          return errorResult(`reason is required for action '${action}'.`);
        }
        try {
          return jsonResult(applyReviewDecision(task_id, action, reason, ctx));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof ReviewActionError) return errorResult(message);
          if (err instanceof ReviewPacketError) return errorResult(message);
          throw err;
        }
      })
  );
}
