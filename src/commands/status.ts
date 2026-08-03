import type { Status } from "../constants.js";
import { STATUSES } from "../constants.js";
import type { LoadedTaskWithTier } from "../specs/loadTasks.js";
import { loadTasks } from "../specs/loadTasks.js";
import { colorForStatus, headerBanner, priorityBadge, statusSymbol } from "../utils/styling.js";

function pad(str: string, width: number): string {
  return str.padEnd(width);
}

function findNextTask(tasks: LoadedTaskWithTier[]): {
  task: LoadedTaskWithTier | null;
  reason: string;
} {
  const completedIds = new Set(
    tasks.filter((t) => t.spec.status === "complete").map((t) => t.spec.id),
  );

  const priorities: Record<string, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };

  const pending = tasks
    .filter((t) => t.tier === "active" && t.spec.status === "pending")
    .sort(
      (a, b) =>
        (priorities[b.spec.priority ?? "medium"] ?? 2) -
        (priorities[a.spec.priority ?? "medium"] ?? 2),
    );

  for (const candidate of pending) {
    const deps = candidate.spec.depends_on ?? [];
    const blockedDeps = deps.filter((d) => !completedIds.has(d));
    if (blockedDeps.length === 0) {
      return { task: candidate, reason: "" };
    }
  }

  if (pending.length > 0) {
    const first = pending[0];
    const blockedDeps = (first.spec.depends_on ?? []).filter((d) => !completedIds.has(d));
    return {
      task: first,
      reason: `Blocked by unresolved dependencies: ${blockedDeps.join(", ")}`,
    };
  }

  return { task: null, reason: "No pending tasks." };
}

export function statusCommand(specsTasksDir: string, _cwd: string): void {
  const { tasks, errors } = loadTasks(specsTasksDir, "all");

  if (errors.length > 0) {
    console.warn(
      `  ⚠ ${errors.length} task file(s) could not be loaded (run "manciple validate" for details).`,
    );
  }

  const counts: Record<Status, number> = {
    pending: 0,
    in_progress: 0,
    needs_review: 0,
    complete: 0,
    blocked: 0,
    failed: 0,
    partial: 0,
    archived: 0,
  };

  const activeTasks = tasks.filter((task) => task.tier === "active");
  const completedLifecycleCount = tasks.filter((task) => task.tier === "completed").length;

  for (const { spec } of activeTasks) {
    counts[spec.status] = (counts[spec.status] ?? 0) + 1;
  }

  console.log(headerBanner().trimEnd());
  console.log("Active tasks:");
  for (const status of STATUSES) {
    if (status === "complete" && counts[status] === 0) continue;
    const coloredLabel = colorForStatus(status)(pad(`${status}:`, 14));
    console.log(`  ${statusSymbol(status)} ${coloredLabel} ${counts[status]}`);
  }
  console.log(`\nCompleted lifecycle tasks: ${completedLifecycleCount}`);

  const { task: next, reason } = findNextTask(tasks);
  console.log("\nNext suggested task:");
  if (next) {
    console.log(`  ${next.spec.id} ${priorityBadge(next.spec.priority ?? "medium")}`);
    if (reason) {
      console.log(`  ⚠ ${reason}`);
    }
  } else {
    console.log(`  ${reason || "None."}`);
  }
}
