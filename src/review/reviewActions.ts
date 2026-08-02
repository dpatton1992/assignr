import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { parse } from "yaml";
import { loadTasks } from "../specs/loadTasks.js";
import type { LoadedTaskWithTier, TaskTier } from "../specs/loadTasks.js";
import { formatYamlDocument } from "../utils/yamlFormat.js";

/**
 * Shared durable review-outcome action layer.
 *
 * Packet construction (reviewPacket.ts) is read-only. All lifecycle mutations
 * live here behind typed actions that validate legal transitions before
 * writing task files or durable review-outcome receipts.
 */

export type ReviewOutcome = "approved" | "changes_requested" | "rejected" | "blocked";
export type ReviewActionOutcome = ReviewOutcome | "reopened";

export interface ReviewActionOptions {
  specsTasksDir: string;
  cwd: string;
  runsDir?: string;
  completedDir?: string;
  activeDir?: string;
  archivedDir?: string;
}

export interface ReviewActionResult {
  taskId: string;
  outcome: ReviewActionOutcome;
  previousStatus: string;
  nextStatus: string;
  /** Repo-relative path to the durable review-outcome receipt, when one is written. */
  outcomePath?: string;
  /** Repo-relative path to the task file after the action. */
  taskPath: string;
}

export class ReviewActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewActionError";
  }
}

function outcomeTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace("T", "-")
    .replace(/\./, "-")
    .replace("Z", "");
}

function rel(cwd: string, path: string): string {
  return path.replace(cwd + "/", "");
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

function updateTaskStatus(filePath: string, status: string): void {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parse(raw) as Record<string, unknown>;
  parsed["status"] = status;
  writeFileSync(filePath, formatYamlDocument(parsed), "utf-8");
}

function writeReviewOutcome(
  task: LoadedTaskWithTier,
  runsDir: string,
  cwd: string,
  outcome: ReviewOutcome,
  nextStatus: string,
  reason?: string
): string {
  mkdirSync(runsDir, { recursive: true });
  const outPath = join(runsDir, `${outcomeTimestamp()}-${task.spec.id}-review-outcome.md`);
  const content = `# Review Outcome: ${task.spec.title}

## Metadata

- Task ID: ${task.spec.id}
- Previous Status: ${task.spec.status}
- Next Status: ${nextStatus}
- Outcome: ${outcome}
- Recorded: ${new Date().toISOString()}

## Reason

${reason?.trim() || "_No reason provided._"}
`;

  writeFileSync(outPath, content, "utf-8");
  return outPath;
}

function requireReason(reason: string): void {
  if (!reason.trim()) {
    throw new ReviewActionError("error: required option '--reason <text>' must not be empty");
  }
}

function requireRunsDir(options: ReviewActionOptions): string {
  if (!options.runsDir) {
    throw new ReviewActionError("error: a runs directory is required to record a review outcome.");
  }
  return options.runsDir;
}

function findActiveNeedsReviewTask(taskId: string, options: ReviewActionOptions): LoadedTaskWithTier {
  const { tasks } = loadTasks(options.specsTasksDir, "all");
  const found = tasks.find((task) => task.spec.id === taskId);

  if (!found) {
    throw new ReviewActionError(`Task not found: ${taskId}`);
  }

  if (found.spec.status !== "needs_review") {
    throw new ReviewActionError(
      `Task ${taskId} is not ready for review outcome: expected needs_review, found ${found.spec.status}.`
    );
  }

  if (found.tier !== "active") {
    throw new ReviewActionError(`Task ${taskId} must be in active tasks to record a review outcome.`);
  }

  return found;
}

export function approveTask(taskId: string, options: ReviewActionOptions): ReviewActionResult {
  if (!options.completedDir) {
    throw new ReviewActionError("error: approve requires a completed tasks directory.");
  }

  const found = findActiveNeedsReviewTask(taskId, options);
  const destination = join(options.completedDir, `${taskId}.yaml`);

  if (existsSync(destination)) {
    throw new ReviewActionError(`Task ${taskId} already exists in completed. Use manciple reopen first.`);
  }

  const runsDir = requireRunsDir(options);
  const outcomePath = writeReviewOutcome(found, runsDir, options.cwd, "approved", "complete");
  mkdirSync(options.completedDir, { recursive: true });
  updateTaskStatus(found.filePath, "complete");
  moveTaskFile(found.filePath, destination);

  return {
    taskId,
    outcome: "approved",
    previousStatus: found.spec.status,
    nextStatus: "complete",
    outcomePath: rel(options.cwd, outcomePath),
    taskPath: rel(options.cwd, destination),
  };
}

export function requestChanges(
  taskId: string,
  reason: string,
  options: ReviewActionOptions
): ReviewActionResult {
  requireReason(reason);
  const found = findActiveNeedsReviewTask(taskId, options);
  const runsDir = requireRunsDir(options);
  const outcomePath = writeReviewOutcome(
    found,
    runsDir,
    options.cwd,
    "changes_requested",
    "in_progress",
    reason
  );
  updateTaskStatus(found.filePath, "in_progress");

  return {
    taskId,
    outcome: "changes_requested",
    previousStatus: found.spec.status,
    nextStatus: "in_progress",
    outcomePath: rel(options.cwd, outcomePath),
    taskPath: rel(options.cwd, found.filePath),
  };
}

export function rejectTask(taskId: string, reason: string, options: ReviewActionOptions): ReviewActionResult {
  requireReason(reason);
  const found = findActiveNeedsReviewTask(taskId, options);
  const runsDir = requireRunsDir(options);
  const outcomePath = writeReviewOutcome(found, runsDir, options.cwd, "rejected", "failed", reason);
  updateTaskStatus(found.filePath, "failed");

  return {
    taskId,
    outcome: "rejected",
    previousStatus: found.spec.status,
    nextStatus: "failed",
    outcomePath: rel(options.cwd, outcomePath),
    taskPath: rel(options.cwd, found.filePath),
  };
}

export function blockReview(
  taskId: string,
  reason: string,
  options: ReviewActionOptions
): ReviewActionResult {
  requireReason(reason);
  const found = findActiveNeedsReviewTask(taskId, options);
  const runsDir = requireRunsDir(options);
  const outcomePath = writeReviewOutcome(found, runsDir, options.cwd, "blocked", "blocked", reason);
  updateTaskStatus(found.filePath, "blocked");

  return {
    taskId,
    outcome: "blocked",
    previousStatus: found.spec.status,
    nextStatus: "blocked",
    outcomePath: rel(options.cwd, outcomePath),
    taskPath: rel(options.cwd, found.filePath),
  };
}

export function reopenTask(taskId: string, options: ReviewActionOptions): ReviewActionResult {
  if (!options.activeDir) {
    throw new ReviewActionError("error: reopen requires an active tasks directory.");
  }

  const sourceTiers: TaskTier[] = ["completed", "archived"];
  const found = sourceTiers
    .flatMap((tier) => loadTasks(options.specsTasksDir, tier).tasks)
    .find((task) => task.spec.id === taskId);

  if (!found) {
    throw new ReviewActionError(`Task ${taskId} not found in completed or archived tasks.`);
  }

  const destination = join(options.activeDir, `${taskId}.yaml`);
  if (existsSync(destination)) {
    throw new ReviewActionError(`Task ${taskId} already exists in active tasks.`);
  }

  const raw = readFileSync(found.filePath, "utf-8");
  const parsed = parse(raw) as Record<string, unknown>;
  parsed["status"] = "in_progress";

  mkdirSync(options.activeDir, { recursive: true });
  writeFileSync(found.filePath, formatYamlDocument(parsed), "utf-8");
  moveTaskFile(found.filePath, destination);

  return {
    taskId,
    outcome: "reopened",
    previousStatus: found.spec.status,
    nextStatus: "in_progress",
    taskPath: rel(options.cwd, destination),
  };
}
