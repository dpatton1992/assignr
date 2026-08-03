/**
 * Shared task-lifecycle service.
 *
 * Owns task lookup, transition validation, tier placement/movement,
 * direct-completion safeguards, and managed-worktree claim-state
 * synchronization for lifecycle transitions (status changes, completion,
 * archival, and review-outcome transitions).
 *
 * The service never prints to stdout/stderr, never calls process.exit, and
 * never constructs MCP response payloads. It returns typed results so CLI and
 * MCP adapters can format their own human-readable or structured output.
 *
 * Review-outcome actions (approve/request-changes/block/reject/reopen) live in
 * the durable review-action layer under src/review/ (which also owns worktree
 * integration and receipts). They are re-exported here so every CLI lifecycle
 * command delegates through a single lifecycle-facing surface.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { parse } from "yaml";
import { STATUSES } from "../constants.js";
import type { Status } from "../constants.js";
import { loadTasks } from "../specs/loadTasks.js";
import type { TaskTier } from "../specs/loadTasks.js";
import { formatYamlDocument } from "../utils/yamlFormat.js";
import {
  assertDirectCompletionAllowed,
  isGitRepository,
  setManagedWorktreeState,
} from "../worktrees/manager.js";
import {
  approveTask,
  blockReview,
  rejectTask,
  reopenTask,
  requestChanges,
  ReviewActionError,
} from "../review/reviewActions.js";
import type {
  ReviewActionOptions,
  ReviewActionResult,
  ReviewActionOutcome,
  ReviewOutcome,
} from "../review/reviewActions.js";

export {
  approveTask,
  blockReview,
  rejectTask,
  reopenTask,
  requestChanges,
  ReviewActionError,
};
export type {
  ReviewActionOptions,
  ReviewActionResult,
  ReviewActionOutcome,
  ReviewOutcome,
};

export type LifecycleErrorCode =
  | "invalid_status"
  | "task_not_found"
  | "duplicate_in_destination_tier"
  | "not_in_active"
  | "direct_completion_blocked"
  | "claim_sync_failed";

export interface TaskLifecycleResult {
  ok: boolean;
  taskId: string;
  previousStatus: string;
  newStatus: Status;
  updatedPath: string;
  code?: LifecycleErrorCode;
  message?: string;
}

export interface TaskLifecycleSyncOptions {
  specsTasksDir: string;
  controlRepo: string;
  worktreesDir: string;
}

export interface CompleteTaskOptions extends TaskLifecycleSyncOptions {
  completedDir: string;
}

export interface ArchiveTaskOptions {
  specsTasksDir: string;
  archivedDir: string;
}

const ACTIVE_STATUSES = new Set<Status>([
  "pending",
  "in_progress",
  "needs_review",
  "partial",
  "blocked",
  "failed",
]);

function getTasksRoot(tasksDir: string): string {
  const last = basename(tasksDir);
  const parent = dirname(tasksDir);

  if ((last === "active" || last === "completed" || last === "archived") && basename(parent) === "tasks") {
    return parent;
  }

  if (last === "tasks" && basename(parent) === "specs") {
    return join(dirname(parent), "tasks");
  }

  return tasksDir;
}

function tierForStatus(status: Status): TaskTier {
  if (status === "complete") return "completed";
  if (status === "archived") return "archived";
  if (ACTIVE_STATUSES.has(status)) return "active";
  return "active";
}

function moveTaskFile(source: string, destination: string): void {
  try {
    renameSync(source, destination);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "EXDEV") {
      copyFileSync(source, destination);
      unlinkSync(source);
      return;
    }

    throw err;
  }
}

function failure(
  code: LifecycleErrorCode,
  message: string,
  taskId: string,
  newStatus: Status
): TaskLifecycleResult {
  return { ok: false, code, message, taskId, previousStatus: "", newStatus, updatedPath: "" };
}

/**
 * Core status transition without worktree claim-state synchronization.
 *
 * Used by worktree tooling (`manciple_prepare_worktree` internals) where the
 * claim state is managed by the worktree service itself.
 */
export function setTaskStatus(
  taskId: string,
  newStatus: Status,
  specsTasksDir: string
): TaskLifecycleResult {
  if (!STATUSES.includes(newStatus)) {
    return failure(
      "invalid_status",
      `Invalid status: "${newStatus}". Allowed: ${STATUSES.join(", ")}`,
      taskId,
      newStatus
    );
  }

  const { tasks } = loadTasks(specsTasksDir, "all");
  const found = tasks.find((task) => task.spec.id === taskId);

  if (!found) {
    return failure(
      "task_not_found",
      `Task not found: ${taskId}\nRun "manciple list" to see available tasks.`,
      taskId,
      newStatus
    );
  }

  const raw = readFileSync(found.filePath, "utf-8");
  const parsed = parse(raw) as Record<string, unknown>;
  const previousStatus = String(parsed["status"]);
  parsed["status"] = newStatus;

  const destinationTier = tierForStatus(newStatus);
  const destinationDir = join(getTasksRoot(specsTasksDir), destinationTier);
  const destination = join(destinationDir, `${taskId}.yaml`);
  const shouldMove = found.tier !== destinationTier;

  if (shouldMove && existsSync(destination)) {
    return failure(
      "duplicate_in_destination_tier",
      `Task ${taskId} already exists in ${destinationTier} tasks.`,
      taskId,
      newStatus
    );
  }

  writeFileSync(found.filePath, formatYamlDocument(parsed), "utf-8");

  if (shouldMove) {
    mkdirSync(destinationDir, { recursive: true });
    moveTaskFile(found.filePath, destination);
  }

  const updatedPath = shouldMove ? destination : found.filePath;
  return { ok: true, taskId, previousStatus, newStatus, updatedPath };
}

/**
 * Status transition with lifecycle guards: direct-completion safeguards for
 * `complete` and managed-worktree claim-state synchronization.
 */
export function setTaskStatusWithLifecycle(
  taskId: string,
  newStatus: Status,
  options: TaskLifecycleSyncOptions
): TaskLifecycleResult {
  if (newStatus === "complete") {
    try {
      assertDirectCompletionAllowed(taskId, {
        controlRepo: options.controlRepo,
        worktreesDir: options.worktreesDir,
        specsTasksDir: options.specsTasksDir,
      });
    } catch (error) {
      return failure(
        "direct_completion_blocked",
        error instanceof Error ? error.message : String(error),
        taskId,
        newStatus
      );
    }
  }

  const result = setTaskStatus(taskId, newStatus, options.specsTasksDir);
  if (!result.ok) return result;

  const claimState = newStatus === "needs_review"
    ? "review_ready"
    : newStatus === "in_progress" || newStatus === "blocked" || newStatus === "partial" || newStatus === "failed"
      ? "available"
      : undefined;

  if (claimState && isGitRepository(options.controlRepo)) {
    try {
      setManagedWorktreeState(taskId, claimState, {
        controlRepo: options.controlRepo,
        worktreesDir: options.worktreesDir,
        specsTasksDir: options.specsTasksDir,
      });
    } catch (error) {
      return failure(
        "claim_sync_failed",
        error instanceof Error ? error.message : String(error),
        taskId,
        newStatus
      );
    }
  }

  return result;
}

/**
 * Complete an active task: guards direct completion, moves the spec to the
 * completed tier, and flips its status to `complete`.
 */
export function completeTask(taskId: string, options: CompleteTaskOptions): TaskLifecycleResult {
  try {
    assertDirectCompletionAllowed(taskId, {
      controlRepo: options.controlRepo,
      worktreesDir: options.worktreesDir,
      specsTasksDir: options.specsTasksDir,
    });
  } catch (error) {
    return failure(
      "direct_completion_blocked",
      error instanceof Error ? error.message : String(error),
      taskId,
      "complete"
    );
  }

  const { tasks } = loadTasks(options.specsTasksDir, "active");
  const found = tasks.find((task) => task.spec.id === taskId);

  if (!found) {
    return failure("not_in_active", `Task ${taskId} not found in active tasks.`, taskId, "complete");
  }

  const destination = join(options.completedDir, `${taskId}.yaml`);
  if (existsSync(destination)) {
    return failure(
      "duplicate_in_destination_tier",
      `Task ${taskId} already exists in completed. Use manciple reopen first.`,
      taskId,
      "complete"
    );
  }

  const raw = readFileSync(found.filePath, "utf-8");
  const parsed = parse(raw) as Record<string, unknown>;
  parsed["status"] = "complete";

  mkdirSync(options.completedDir, { recursive: true });
  writeFileSync(found.filePath, formatYamlDocument(parsed), "utf-8");
  moveTaskFile(found.filePath, destination);

  return { ok: true, taskId, previousStatus: found.spec.status, newStatus: "complete", updatedPath: destination };
}

/**
 * Archive an active task: moves the spec to the archived tier and flips its
 * status to `archived`.
 */
export function archiveTask(taskId: string, options: ArchiveTaskOptions): TaskLifecycleResult {
  const { tasks } = loadTasks(options.specsTasksDir, "active");
  const found = tasks.find((task) => task.spec.id === taskId);

  if (!found) {
    return failure("not_in_active", `Task ${taskId} not found in active tasks.`, taskId, "archived");
  }

  const destination = join(options.archivedDir, `${taskId}.yaml`);
  if (existsSync(destination)) {
    return failure(
      "duplicate_in_destination_tier",
      `Task ${taskId} already exists in archived.`,
      taskId,
      "archived"
    );
  }

  const raw = readFileSync(found.filePath, "utf-8");
  const parsed = parse(raw) as Record<string, unknown>;
  parsed["status"] = "archived";

  mkdirSync(options.archivedDir, { recursive: true });
  writeFileSync(found.filePath, formatYamlDocument(parsed), "utf-8");
  moveTaskFile(found.filePath, destination);

  return { ok: true, taskId, previousStatus: found.spec.status, newStatus: "archived", updatedPath: destination };
}
