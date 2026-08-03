import type { LoadedTaskWithTier } from "../specs/loadTasks.js";

export type CoordinatorSection =
  | "runnable"
  | "waiting"
  | "needs_review"
  | "complete_ready"
  | "blocked"
  | "rework_needed";

export interface CoordinatorQueueRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  section: CoordinatorSection;
  reason: string;
}

export interface CoordinatorQueue {
  runnable: CoordinatorQueueRow[];
  waiting: CoordinatorQueueRow[];
  needsReview: CoordinatorQueueRow[];
  completeReady: CoordinatorQueueRow[];
  blocked: CoordinatorQueueRow[];
  reworkNeeded: CoordinatorQueueRow[];
}

export interface DispatchPlanOwnershipBoundary {
  allowed_paths: string[];
  forbidden_paths: string[];
  touched_paths: string[];
  locked_paths: string[];
  unsafe_parallel_areas: string[];
}

export interface DispatchPlanAssignment {
  task_id: string;
  ownership_boundary: DispatchPlanOwnershipBoundary;
  reason: string;
  execution: DispatchPlanExecution;
}

export interface DispatchPlanExecution {
  mode: "worktree" | "in_place";
  control_repo: string;
  workspace_path: string;
  branch?: string;
  base_sha?: string;
  prepared: boolean;
  claim_state?: string;
}

export interface DispatchPlanDeferral {
  task_id: string;
  section: Exclude<CoordinatorSection, "runnable">;
  reason: string;
}

export interface DispatchPlanStopAfterBatch {
  required: boolean;
  reason: string;
}

export interface DispatchPlanVerificationEntry {
  task_id: string;
  commands: string[];
}

export interface DispatchPlan {
  execution_mode: "worktree" | "in_place";
  worker_cap: number;
  recommended_batch_size: number;
  assignments: DispatchPlanAssignment[];
  do_not_dispatch: DispatchPlanDeferral[];
  stop_after_batch: DispatchPlanStopAfterBatch;
  verification_plan: {
    batch_commands: string[];
    assignments: DispatchPlanVerificationEntry[];
  };
}

export interface CoordinatorBuildOptions {
  dependenciesRequireComplete?: boolean;
}

export interface DispatchPlanBuildOptions extends CoordinatorBuildOptions {
  executionMode?: "worktree" | "in_place";
  controlRepo?: string;
  worktreesDir?: string;
  preparedWorktrees?: Map<string, {
    workspacePath: string;
    branch: string;
    baseSha: string;
    claimState: string;
  }>;
}

const PRIORITY_ORDER: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const USABLE_DEP_STATUSES = new Set(["needs_review", "complete"]);
const ACTIVE_WORK_STATUSES = new Set(["pending", "in_progress"]);

function normalizePathPattern(pattern: string): string {
  return pattern.trim().replace(/^\.\//, "").replace(/\\/g, "/");
}

function fixedPrefix(pattern: string): string {
  const normalized = normalizePathPattern(pattern);
  const wildcardIndex = normalized.search(/[*?[\]{}]/);
  if (wildcardIndex === -1) {
    return normalized.endsWith("/") ? normalized : normalized;
  }

  const prefix = normalized.slice(0, wildcardIndex);
  const lastSlash = prefix.lastIndexOf("/");
  return lastSlash === -1 ? "" : prefix.slice(0, lastSlash + 1);
}

function isDirectoryPattern(pattern: string): boolean {
  const normalized = normalizePathPattern(pattern);
  return normalized.endsWith("/") || normalized.endsWith("/**") || normalized.endsWith("/*");
}

function pathPatternsMayOverlap(first: string, second: string): boolean {
  const a = normalizePathPattern(first);
  const b = normalizePathPattern(second);

  if (!a || !b) return false;
  if (a === b || a === "**" || b === "**") return true;

  const aPrefix = fixedPrefix(a);
  const bPrefix = fixedPrefix(b);
  if (!aPrefix || !bPrefix) return true;

  if (a.includes("*") || a.includes("?") || b.includes("*") || b.includes("?")) {
    return aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix);
  }

  if (isDirectoryPattern(a) || isDirectoryPattern(b)) {
    return a.startsWith(b) || b.startsWith(a);
  }

  return false;
}

function isSharedDocPath(pattern: string): boolean {
  const normalized = normalizePathPattern(pattern);
  return (
    normalized === "README.md" ||
    normalized.startsWith("README.") ||
    normalized === "docs" ||
    normalized.startsWith("docs/")
  );
}

function sortTasks(tasks: LoadedTaskWithTier[]): LoadedTaskWithTier[] {
  return [...tasks].sort((a, b) => {
    const statusDiff = Number(b.spec.status === "in_progress") - Number(a.spec.status === "in_progress");
    if (statusDiff !== 0) return statusDiff;

    const priorityDiff =
      (PRIORITY_ORDER[b.spec.priority ?? "medium"] ?? 2) -
      (PRIORITY_ORDER[a.spec.priority ?? "medium"] ?? 2);
    if (priorityDiff !== 0) return priorityDiff;
    return a.spec.id.localeCompare(b.spec.id);
  });
}

function row(task: LoadedTaskWithTier, section: CoordinatorSection, reason: string): CoordinatorQueueRow {
  return {
    id: task.spec.id,
    title: task.spec.title,
    status: task.spec.status,
    priority: task.spec.priority ?? "medium",
    section,
    reason,
  };
}

function ownershipBoundary(task: LoadedTaskWithTier): DispatchPlanOwnershipBoundary {
  const ownership = task.spec.path_ownership;
  return {
    allowed_paths: task.spec.allowed_paths ?? [],
    forbidden_paths: task.spec.forbidden_paths ?? [],
    touched_paths: ownership.touched_paths ?? [],
    locked_paths: ownership.locked_paths ?? [],
    unsafe_parallel_areas: ownership.unsafe_parallel_areas ?? [],
  };
}

function isDependencyUsable(
  task: LoadedTaskWithTier | undefined,
  options: CoordinatorBuildOptions,
): boolean {
  if (!task) return false;
  return options.dependenciesRequireComplete
    ? task.spec.status === "complete"
    : USABLE_DEP_STATUSES.has(task.spec.status);
}

function taskPaths(task: LoadedTaskWithTier): string[] {
  const ownership = task.spec.path_ownership;
  return [
    ...(task.spec.allowed_paths ?? []),
    ...(ownership.touched_paths ?? []),
    ...(ownership.locked_paths ?? []),
    ...(ownership.unsafe_parallel_areas ?? []),
  ];
}

function overlapReason(task: LoadedTaskWithTier, others: LoadedTaskWithTier[]): string {
  const paths = taskPaths(task);
  if (paths.length === 0) return "";

  for (const other of others) {
    const otherPaths = taskPaths(other);
    for (const path of paths) {
      for (const otherPath of otherPaths) {
        if (pathPatternsMayOverlap(path, otherPath)) {
          if (isSharedDocPath(path) || isSharedDocPath(otherPath)) {
            return `README or shared-doc overlap with ${other.spec.id}: ${path} <-> ${otherPath}`;
          }
          return `path overlap with ${other.spec.id}: ${path} <-> ${otherPath}`;
        }
      }
    }
  }

  return "";
}

function explicitConflictReason(task: LoadedTaskWithTier, others: LoadedTaskWithTier[]): string {
  for (const other of others) {
    const taskConflicts = task.spec.conflicts_with ?? [];
    const otherConflicts = other.spec.conflicts_with ?? [];
    if (taskConflicts.includes(other.spec.id) || otherConflicts.includes(task.spec.id)) {
      return `explicit conflict with ${other.spec.id}`;
    }
  }

  return "";
}

function independenceConflictReason(task: LoadedTaskWithTier, others: LoadedTaskWithTier[]): string {
  if (others.length === 0) return "";

  if (!task.spec.can_run_independently) {
    return "not marked can_run_independently";
  }

  const exclusiveTask = others.find((other) => !other.spec.can_run_independently);
  if (exclusiveTask) {
    return `cannot run with non-independent task ${exclusiveTask.spec.id}`;
  }

  return "";
}

function dependencyWaitReasons(
  task: LoadedTaskWithTier,
  taskById: Map<string, LoadedTaskWithTier>,
  options: CoordinatorBuildOptions,
): string[] {
  const reasons: string[] = [];
  const unresolvedDeps = (task.spec.depends_on ?? []).filter(
    (dep) => !isDependencyUsable(taskById.get(dep), options)
  );

  if (unresolvedDeps.length > 0) {
    reasons.push(`waiting on dependencies: ${unresolvedDeps.join(", ")}`);
  }

  const activeBlockers = [...taskById.values()].filter(
    (other) =>
      other.spec.id !== task.spec.id &&
      other.tier === "active" &&
      !isDependencyUsable(other, options) &&
      (other.spec.blocks ?? []).includes(task.spec.id)
  );

  if (activeBlockers.length > 0) {
    reasons.push(`blocked by: ${activeBlockers.map((blocker) => blocker.spec.id).join(", ")}`);
  }

  return reasons;
}

function reviewNeedsReworkReason(
  task: LoadedTaskWithTier,
  activeWork: LoadedTaskWithTier[],
  taskById: Map<string, LoadedTaskWithTier>,
  options: CoordinatorBuildOptions,
): string {
  const waitReasons = dependencyWaitReasons(task, taskById, options);
  if (waitReasons.length > 0) return waitReasons.join("; ");

  const conflict = explicitConflictReason(task, activeWork);
  if (conflict) return conflict;

  return overlapReason(task, activeWork);
}

export function buildCoordinatorQueue(
  tasks: LoadedTaskWithTier[],
  options: CoordinatorBuildOptions = {},
): CoordinatorQueue {
  const activeTasks = tasks.filter((task) => task.tier === "active");
  const taskById = new Map(tasks.map((task) => [task.spec.id, task]));
  const queue: CoordinatorQueue = {
    runnable: [],
    waiting: [],
    needsReview: [],
    completeReady: [],
    blocked: [],
    reworkNeeded: [],
  };

  const activeWork = activeTasks.filter((task) => ACTIVE_WORK_STATUSES.has(task.spec.status));
  const selectedRunnable: LoadedTaskWithTier[] = [];

  for (const task of sortTasks(activeTasks)) {
    if (task.spec.status === "blocked") {
      queue.blocked.push(row(task, "blocked", "blocked status"));
      continue;
    }

    if (task.spec.status === "partial" || task.spec.status === "failed") {
      queue.reworkNeeded.push(row(task, "rework_needed", `${task.spec.status} status`));
      continue;
    }

    if (task.spec.status === "complete") {
      queue.completeReady.push(row(task, "complete_ready", "ready to move to completed lifecycle"));
      continue;
    }

    if (task.spec.status === "needs_review") {
      const reason = reviewNeedsReworkReason(task, activeWork, taskById, options);
      if (reason) {
        queue.reworkNeeded.push(row(task, "rework_needed", reason));
      } else {
        queue.needsReview.push(row(task, "needs_review", "ready for owner review"));
      }
      continue;
    }

    if (!ACTIVE_WORK_STATUSES.has(task.spec.status)) {
      continue;
    }

    const waitReasons = dependencyWaitReasons(task, taskById, options);
    if (waitReasons.length > 0) {
      queue.waiting.push(row(task, "waiting", waitReasons.join("; ")));
      continue;
    }

    const explicitConflict = explicitConflictReason(task, selectedRunnable);
    if (explicitConflict) {
      queue.waiting.push(row(task, "waiting", explicitConflict));
      continue;
    }

    const pathConflict = overlapReason(task, selectedRunnable);
    if (pathConflict) {
      queue.waiting.push(row(task, "waiting", pathConflict));
      continue;
    }

    const independenceConflict = independenceConflictReason(task, selectedRunnable);
    if (independenceConflict) {
      queue.waiting.push(row(task, "waiting", independenceConflict));
      continue;
    }

    selectedRunnable.push(task);
    queue.runnable.push(
      row(
        task,
        "runnable",
        task.spec.can_run_independently ? "dependencies usable; parallel-safe" : "dependencies usable; run as a single slice"
      )
    );
  }

  return queue;
}

export function buildDispatchPlan(
  tasks: LoadedTaskWithTier[],
  options: DispatchPlanBuildOptions = {},
): DispatchPlan {
  const executionMode = options.executionMode ?? "in_place";
  const queue = buildCoordinatorQueue(tasks, options);
  const activeTaskById = new Map(
    tasks.filter((task) => task.tier === "active").map((task) => [task.spec.id, task])
  );

  const claimedDeferrals: DispatchPlanDeferral[] = [];
  const assignments = queue.runnable.flatMap((item) => {
    const task = activeTaskById.get(item.id);
    if (!task) {
      throw new Error(`Runnable task missing from active task index: ${item.id}`);
    }

    const prepared = options.preparedWorktrees?.get(item.id);
    if (executionMode === "worktree" && prepared && prepared.claimState !== "available") {
      claimedDeferrals.push({
        task_id: item.id,
        section: "waiting",
        reason: `managed worktree is ${prepared.claimState}; release or resume it before redispatch`,
      });
      return [];
    }
    const controlRepo = options.controlRepo ?? process.cwd();
    const execution: DispatchPlanExecution = executionMode === "worktree"
      ? {
          mode: "worktree",
          control_repo: controlRepo,
          workspace_path: prepared?.workspacePath ?? `${options.worktreesDir ?? ".manciple/worktrees"}/${item.id}`,
          branch: prepared?.branch ?? `manciple/${item.id}`,
          ...(prepared ? { base_sha: prepared.baseSha, claim_state: prepared.claimState } : {}),
          prepared: Boolean(prepared),
        }
      : {
          mode: "in_place",
          control_repo: controlRepo,
          workspace_path: controlRepo,
          prepared: true,
        };
    return [{
      task_id: item.id,
      ownership_boundary: ownershipBoundary(task),
      reason: item.reason,
      execution,
    }];
  });

  const deferredRows: Array<[Exclude<CoordinatorSection, "runnable">, CoordinatorQueueRow[]]> = [
    ["waiting", queue.waiting],
    ["needs_review", queue.needsReview],
    ["complete_ready", queue.completeReady],
    ["blocked", queue.blocked],
    ["rework_needed", queue.reworkNeeded],
  ];

  const doNotDispatch = deferredRows.flatMap(([section, rows]) =>
    rows.map((item) => ({
      task_id: item.id,
      section,
      reason: item.reason,
    }))
  ).concat(claimedDeferrals);

  const verificationEntries = assignments.map((assignment) => {
    const task = activeTaskById.get(assignment.task_id);
    return {
      task_id: assignment.task_id,
      commands: task?.spec.verification.commands ?? [],
    };
  });

  const batchCommands = Array.from(
    new Set(verificationEntries.flatMap((entry) => entry.commands))
  );

  return {
    execution_mode: executionMode,
    worker_cap: assignments.length,
    recommended_batch_size: assignments.length,
    assignments,
    do_not_dispatch: doNotDispatch,
    stop_after_batch: {
      required: true,
      reason:
        assignments.length > 0
          ? "Recompute the dispatch plan after this batch settles; later tasks may unblock or conflict state may change."
          : "No runnable assignments are available; wait for review, rework, dependency, or lifecycle movement before dispatching.",
    },
    verification_plan: {
      batch_commands: batchCommands,
      assignments: verificationEntries,
    },
  };
}
