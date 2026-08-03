import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { LoadedTaskWithTier, LoadTaskTier } from "../specs/loadTasks.js";
import { loadTasks } from "../specs/loadTasks.js";

const CHARS_PER_TOKEN_ESTIMATE = 4;
const MAX_GOAL_WIDTH = 140;
const MAX_PATHS = 3;

export interface PlannerContextOptions {
  status?: string;
  domain?: string;
  completed?: boolean;
  archived?: boolean;
  all?: boolean;
  maxChars?: number;
  maxTokens?: number;
  strict?: boolean;
}

export interface PlannerContextResult {
  output: string;
  charCount: number;
  estimatedTokens: number;
  warnings: string[];
  truncated: boolean;
  budgetChars?: number;
}

interface CompactTask {
  id: string;
  status: string;
  type: string;
  domain: string;
  priority: string;
  tier: string;
  depCount: number;
  conflictCount: number;
  allowedPathSummary: string;
  allowedPaths: string[];
  goal: string;
}

function resolveTier(options: PlannerContextOptions): LoadTaskTier {
  const selectedTiers = [options.completed, options.archived, options.all].filter(Boolean).length;

  if (selectedTiers > 1) {
    throw new Error("Use only one of --completed, --archived, or --all");
  }

  if (options.completed) return "completed";
  if (options.archived) return "archived";
  if (options.all) return "all";
  return "active";
}

function resolveTasksRoot(tasksDir: string): string {
  const lastSegment = basename(tasksDir);
  const parentDir = dirname(tasksDir);

  if (
    ["active", "completed", "archived"].includes(lastSegment) &&
    basename(parentDir) === "tasks"
  ) {
    return parentDir;
  }

  if (lastSegment === "tasks" && basename(parentDir) === "specs") {
    return join(dirname(parentDir), "tasks");
  }

  return tasksDir;
}

function requiredTaskDirs(specsTasksDir: string, tier: LoadTaskTier): string[] {
  const tasksRoot = resolveTasksRoot(specsTasksDir);

  if (tier === "all") {
    return ["active", "completed", "archived"].map((taskTier) => join(tasksRoot, taskTier));
  }

  return [join(tasksRoot, tier)];
}

function estimateTokens(charCount: number): number {
  return Math.ceil(charCount / CHARS_PER_TOKEN_ESTIMATE);
}

function oneLine(value: string, maxWidth: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxWidth) return normalized;
  return `${normalized.slice(0, maxWidth - 3)}...`;
}

function summarizePaths(paths: string[]): string {
  if (paths.length === 0) return "(none)";
  const shown = paths.slice(0, MAX_PATHS);
  const suffix = paths.length > shown.length ? ` (+${paths.length - shown.length})` : "";
  return `${shown.join(", ")}${suffix}`;
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

function compactTask(task: LoadedTaskWithTier): CompactTask {
  const { spec, tier } = task;
  return {
    id: spec.id,
    status: spec.status,
    type: spec.type,
    domain: spec.domain,
    priority: spec.priority,
    tier,
    depCount: spec.depends_on.length,
    conflictCount: spec.conflicts_with.length,
    allowedPathSummary: summarizePaths(spec.allowed_paths),
    allowedPaths: spec.allowed_paths,
    goal: oneLine(spec.goal, MAX_GOAL_WIDTH),
  };
}

function applyFilters(
  tasks: LoadedTaskWithTier[],
  options: PlannerContextOptions,
): LoadedTaskWithTier[] {
  return tasks
    .filter((task) => (options.status ? task.spec.status === options.status : true))
    .filter((task) => (options.domain ? task.spec.domain === options.domain : true))
    .sort((a, b) => a.spec.id.localeCompare(b.spec.id));
}

function formatTaskLine(task: CompactTask, showTier: boolean): string {
  const tier = showTier ? ` tier:${task.tier}` : "";
  return `- ${task.id} [${task.status}/${task.type}/${task.domain}/${task.priority}${tier}] deps:${task.depCount} conflicts:${task.conflictCount} paths:${task.allowedPathSummary} | goal: ${task.goal}`;
}

function overlapLines(tasks: CompactTask[]): string[] {
  const lines: string[] = [];

  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const first = tasks[i];
      const second = tasks[j];
      const overlaps = first.allowedPaths.filter((firstPath) =>
        second.allowedPaths.some((secondPath) => pathPatternsMayOverlap(firstPath, secondPath)),
      );

      if (overlaps.length === 0) continue;

      lines.push(
        `- ${first.id} <-> ${second.id} paths:${summarizePaths(overlaps)} | ${second.allowedPathSummary}`,
      );
    }
  }

  return lines;
}

function budgetChars(options: PlannerContextOptions): number | undefined {
  if (options.maxChars !== undefined && options.maxTokens !== undefined) {
    return Math.min(options.maxChars, options.maxTokens * CHARS_PER_TOKEN_ESTIMATE);
  }

  if (options.maxChars !== undefined) return options.maxChars;
  if (options.maxTokens !== undefined) return options.maxTokens * CHARS_PER_TOKEN_ESTIMATE;
  return undefined;
}

function appendWithinBudget(
  lines: string[],
  nextLine: string,
  maxChars: number | undefined,
): boolean {
  if (maxChars === undefined) {
    lines.push(nextLine);
    return true;
  }

  const candidate = [...lines, nextLine].join("\n");
  if (candidate.length > maxChars) {
    return false;
  }

  lines.push(nextLine);
  return true;
}

export function buildPlannerContext(
  specsTasksDir: string,
  options: PlannerContextOptions = {},
): PlannerContextResult {
  const tier = resolveTier(options);
  const { tasks, errors } = loadTasks(specsTasksDir, tier);
  const filteredTasks = applyFilters(tasks, options).map(compactTask);
  const maxChars = budgetChars(options);
  const warnings = errors.map((error) => `Could not load ${error.filePath}: ${error.error}`);
  const lines = [
    `Planner context task index (tier: ${tier})`,
    "Fields: id [status/type/domain/priority] deps conflicts paths | goal",
  ];
  let truncated = false;
  let taskLinesEmitted = 0;

  if (filteredTasks.length === 0) {
    appendWithinBudget(lines, "No tasks found.", maxChars);
  } else {
    for (const task of filteredTasks) {
      if (!appendWithinBudget(lines, formatTaskLine(task, tier === "all"), maxChars)) {
        truncated = true;
        break;
      }
      taskLinesEmitted += 1;
    }
  }

  const overlaps = overlapLines(filteredTasks);
  if (!truncated && overlaps.length > 0) {
    if (appendWithinBudget(lines, "Likely overlaps:", maxChars)) {
      for (const line of overlaps) {
        if (!appendWithinBudget(lines, line, maxChars)) {
          truncated = true;
          break;
        }
      }
    } else {
      truncated = true;
    }
  }

  const omittedCount = Math.max(0, filteredTasks.length - taskLinesEmitted);
  if (truncated) {
    warnings.push(`Planner context truncated to fit ${maxChars} chars; read full specs as needed.`);
  }
  if (omittedCount > 0) {
    warnings.push(`${omittedCount} task or overlap line(s) omitted by the context budget.`);
  }

  for (const warning of warnings) {
    const line = `Warning: ${warning}`;
    if (!appendWithinBudget(lines, line, maxChars)) {
      truncated = true;
      break;
    }
  }

  const body = lines.join("\n");
  const sizeLine = `Estimated context size: ${body.length} chars, ~${estimateTokens(body.length)} tokens (${CHARS_PER_TOKEN_ESTIMATE} chars/token).`;
  const output = [sizeLine, body].join("\n");

  return {
    output,
    charCount: output.length,
    estimatedTokens: estimateTokens(output.length),
    warnings,
    truncated,
    budgetChars: maxChars,
  };
}

function positiveIntegerOption(value: number | undefined, name: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

export function plannerContextCommand(
  specsTasksDir: string,
  _cwd: string,
  options: PlannerContextOptions = {},
): void {
  try {
    positiveIntegerOption(options.maxChars, "--max-chars");
    positiveIntegerOption(options.maxTokens, "--max-tokens");
    const tier = resolveTier(options);
    const taskDirs = requiredTaskDirs(specsTasksDir, tier);
    const hasReadableTaskDir = taskDirs.some((taskDir) => existsSync(taskDir));

    if (!hasReadableTaskDir) {
      console.error(`Tasks directory does not exist: ${taskDirs[0]}`);
      process.exit(1);
    }

    const result = buildPlannerContext(specsTasksDir, options);
    console.log(result.output);

    if (options.strict && result.truncated) {
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
