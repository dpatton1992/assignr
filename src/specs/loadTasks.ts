import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";
import type { LoadedTask } from "./schema.js";
import { TaskSpecSchema } from "./schema.js";

export type TaskTier = "active" | "completed" | "archived";
export type LoadTaskTier = TaskTier | "all";
export type LoadedTaskWithTier = LoadedTask & { tier: TaskTier };

export interface LoadResult {
  tasks: LoadedTaskWithTier[];
  errors: Array<{ filePath: string; error: string }>;
}

export type PathOwnershipWarningKind = "touched" | "locked" | "unsafe_parallel_area";

export interface PathOwnershipWarning {
  kind: PathOwnershipWarningKind;
  owner_task_id: string;
  affected_path: string;
  owner_path: string;
}

const TASK_TIERS: TaskTier[] = ["active", "completed", "archived"];

function getTasksRoot(tasksDir: string): string {
  const last = basename(tasksDir);
  const parent = dirname(tasksDir);

  if (TASK_TIERS.includes(last as TaskTier) && basename(parent) === "tasks") {
    return parent;
  }

  if (last === "tasks" && basename(parent) === "specs") {
    return join(dirname(parent), "tasks");
  }

  return tasksDir;
}

function loadTasksFromDir(tasksDir: string, tier: TaskTier): LoadResult {
  if (!existsSync(tasksDir)) {
    return { tasks: [], errors: [] };
  }

  const files = readdirSync(tasksDir).filter((f) => f.endsWith(".yaml"));
  const tasks: LoadedTaskWithTier[] = [];
  const errors: Array<{ filePath: string; error: string }> = [];

  for (const file of files) {
    const filePath = join(tasksDir, file);
    const raw = readFileSync(filePath, "utf-8");

    let parsed: unknown;
    try {
      parsed = parse(raw);
    } catch (err) {
      errors.push({
        filePath,
        error: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const result = TaskSpecSchema.safeParse(parsed);
    if (!result.success) {
      const messages = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      errors.push({ filePath, error: messages });
      continue;
    }

    tasks.push({ spec: result.data, filePath, tier });
  }

  return { tasks, errors };
}

export function loadTasks(tasksDir: string, tier: LoadTaskTier = "active"): LoadResult {
  const tasksRoot = getTasksRoot(tasksDir);

  // Emit a one-time migration warning when legacy specs/tasks/ files are present
  // but are being bypassed because loadTasks now reads from tasks/{tier}/.
  const lastSegment = basename(tasksDir);
  const parentSegment = basename(dirname(tasksDir));
  if (lastSegment === "tasks" && parentSegment === "specs" && existsSync(tasksDir)) {
    const legacyFiles = readdirSync(tasksDir).filter((f) => f.endsWith(".yaml"));
    if (legacyFiles.length > 0) {
      console.warn(
        `\n  ⚠ Migration: ${legacyFiles.length} task file(s) in specs/tasks/ are not visible to manciple commands.` +
          `\n    Move them to tasks/active/ or run "manciple migrate-tasks" when available.\n`,
      );
    }
  }

  const tiers = tier === "all" ? TASK_TIERS : [tier];
  const tasks: LoadedTaskWithTier[] = [];
  const errors: Array<{ filePath: string; error: string }> = [];

  for (const taskTier of tiers) {
    const result = loadTasksFromDir(join(tasksRoot, taskTier), taskTier);
    tasks.push(...result.tasks);
    errors.push(...result.errors);
  }

  return { tasks, errors };
}

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

function addWarningsForPatterns(
  warnings: PathOwnershipWarning[],
  targetAllowedPaths: string[],
  ownerTaskId: string,
  kind: PathOwnershipWarningKind,
  ownerPaths: string[],
): void {
  for (const affectedPath of targetAllowedPaths) {
    for (const ownerPath of ownerPaths) {
      if (pathPatternsMayOverlap(affectedPath, ownerPath)) {
        warnings.push({
          kind,
          owner_task_id: ownerTaskId,
          affected_path: affectedPath,
          owner_path: ownerPath,
        });
      }
    }
  }
}

export function pathOwnershipWarningsForTask(
  target: LoadedTaskWithTier,
  tasks: LoadedTaskWithTier[],
): PathOwnershipWarning[] {
  const allowedPaths = target.spec.allowed_paths ?? [];
  if (allowedPaths.length === 0) return [];

  const warnings: PathOwnershipWarning[] = [];

  for (const task of tasks) {
    if (task.spec.id === target.spec.id || task.tier !== "active") continue;

    const ownership = task.spec.path_ownership;
    const touchedPaths =
      ownership.touched_paths.length > 0
        ? ownership.touched_paths
        : (task.spec.allowed_paths ?? []);

    addWarningsForPatterns(warnings, allowedPaths, task.spec.id, "touched", touchedPaths);
    addWarningsForPatterns(warnings, allowedPaths, task.spec.id, "locked", ownership.locked_paths);
    addWarningsForPatterns(
      warnings,
      allowedPaths,
      task.spec.id,
      "unsafe_parallel_area",
      ownership.unsafe_parallel_areas,
    );
  }

  return warnings;
}
