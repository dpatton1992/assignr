import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { parse } from "yaml";
import { STATUSES } from "../constants.js";
import type { Status } from "../constants.js";
import { loadTasks } from "../specs/loadTasks.js";
import type { TaskTier } from "../specs/loadTasks.js";
import { formatYamlDocument } from "../utils/yamlFormat.js";
import { colorForStatus } from "../utils/styling.js";
import picocolors from "picocolors";
import { loadConfig } from "../config.js";
import { getPaths } from "../utils/paths.js";
import { assertDirectCompletionAllowed, isGitRepository, setManagedWorktreeState } from "../worktrees/manager.js";

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

export function setStatusCommand(
  taskId: string,
  newStatus: Status,
  specsTasksDir: string,
  cwd: string
): void {
  try {
    const config = loadConfig(cwd);
    const paths = getPaths(cwd, config.root);
    if (newStatus === "complete") {
      assertDirectCompletionAllowed(taskId, {
        controlRepo: cwd,
        worktreesDir: paths.worktrees,
        specsTasksDir,
      });
    }
    const result = setTaskStatus(taskId, newStatus, specsTasksDir);
    const worktreeState = newStatus === "needs_review"
      ? "review_ready"
      : newStatus === "in_progress"
        ? "available"
        : (["blocked", "partial", "failed"] as string[]).includes(newStatus)
          ? "available"
          : undefined;
    if (worktreeState) {
      if (isGitRepository(cwd)) {
        setManagedWorktreeState(taskId, worktreeState, {
          controlRepo: cwd,
          worktreesDir: paths.worktrees,
          specsTasksDir,
        });
      }
    }
    console.log(
      `Updated: ${result.updatedPath.replace(cwd + "/", "")}\n` +
        `  ${colorForStatus(result.previousStatus)(result.previousStatus)} ${picocolors.yellow("→")} ${colorForStatus(newStatus)(newStatus)}`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export interface SetTaskStatusResult {
  taskId: string;
  previousStatus: string;
  newStatus: Status;
  updatedPath: string;
}

export function setTaskStatus(
  taskId: string,
  newStatus: Status,
  specsTasksDir: string,
): SetTaskStatusResult {
  if (!STATUSES.includes(newStatus)) {
    throw new Error(`Invalid status: "${newStatus}". Allowed: ${STATUSES.join(", ")}`);
  }

  const { tasks } = loadTasks(specsTasksDir, "all");
  const found = tasks.find((t) => t.spec.id === taskId);

  if (!found) {
    throw new Error(
      `Task not found: ${taskId}\n` +
        `Run "manciple list" to see available tasks.`
    );
  }

  const raw = readFileSync(found.filePath, "utf-8");
  const parsed = parse(raw) as Record<string, unknown>;
  const previousStatus = parsed["status"];
  parsed["status"] = newStatus;

  const destinationTier = tierForStatus(newStatus);
  const destinationDir = join(getTasksRoot(specsTasksDir), destinationTier);
  const destination = join(destinationDir, `${taskId}.yaml`);
  const shouldMove = found.tier !== destinationTier;

  if (shouldMove && existsSync(destination)) {
    throw new Error(`Task ${taskId} already exists in ${destinationTier} tasks.`);
  }

  writeFileSync(found.filePath, formatYamlDocument(parsed), "utf-8");

  if (shouldMove) {
    mkdirSync(destinationDir, { recursive: true });
    moveTaskFile(found.filePath, destination);
  }

  const updatedPath = shouldMove ? destination : found.filePath;
  return {
    taskId,
    previousStatus: String(previousStatus),
    newStatus,
    updatedPath,
  };
}
