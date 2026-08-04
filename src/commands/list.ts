import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { STATUSES } from "../constants.js";
import type { LoadedTaskWithTier, LoadTaskTier } from "../specs/loadTasks.js";
import { loadTasks } from "../specs/loadTasks.js";
import { colorForStatus, statusSymbol, styleCell, styleHelpSection } from "../utils/styling.js";

const MAX_TITLE_WIDTH = 50;

const VALID_GROUP_BY_VALUES = ["status", "domain", "tier"] as const;

export type GroupByField = (typeof VALID_GROUP_BY_VALUES)[number];

export interface ListCommandOptions {
  status?: string;
  domain?: string;
  completed?: boolean;
  archived?: boolean;
  all?: boolean;
  groupBy?: GroupByField;
}

function truncateTitle(title: string): string {
  if (title.length <= MAX_TITLE_WIDTH) {
    return title;
  }

  return `${title.slice(0, MAX_TITLE_WIDTH - 3)}...`;
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function formatRows(tasks: LoadedTaskWithTier[], showTier: boolean): string[] {
  const rows = tasks.map(({ spec, tier }) => ({
    id: spec.id,
    title: truncateTitle(spec.title),
    status: spec.status,
    tier,
    deps: spec.depends_on.length,
  }));

  const idWidth = Math.max("ID".length, ...rows.map((row) => row.id.length));
  const titleWidth = MAX_TITLE_WIDTH;
  const statusWidth = Math.max("STATUS".length, ...rows.map((row) => row.status.length));
  const tierWidth = Math.max("TIER".length, ...rows.map((row) => row.tier.length));
  const depsWidth = Math.max("DEPS".length, ...rows.map((row) => String(row.deps).length));

  const statusDisplayWidth = statusWidth + 2; // room for statusSymbol + space

  if (showTier) {
    return [
      `${styleCell("ID", undefined, idWidth)}  ${styleCell("TITLE", undefined, titleWidth)}  ${styleCell("STATUS", undefined, statusWidth)}  ${styleCell(
        "TIER",
        undefined,
        tierWidth,
      )}  ${styleCell("DEPS", undefined, depsWidth)}`,
      ...rows.map((row) => {
        const plainStatus = `${statusSymbol(row.status)} ${row.status}`;
        return `${pad(row.id, idWidth)}  ${pad(row.title, titleWidth)}  ${colorForStatus(row.status)(pad(plainStatus, statusDisplayWidth))}  ${pad(
          row.tier,
          tierWidth,
        )}  ${pad(row.deps, depsWidth)}`;
      }),
    ];
  }

  return [
    `${styleCell("ID", undefined, idWidth)}  ${styleCell("TITLE", undefined, titleWidth)}  ${styleCell("STATUS", undefined, statusWidth)}  ${styleCell("DEPS", undefined, depsWidth)}`,
    ...rows.map((row) => {
      const plainStatus = `${statusSymbol(row.status)} ${row.status}`;
      return `${pad(row.id, idWidth)}  ${pad(row.title, titleWidth)}  ${colorForStatus(row.status)(pad(plainStatus, statusDisplayWidth))}  ${pad(
        row.deps,
        depsWidth,
      )}`;
    }),
  ];
}

function applyFilters(
  tasks: LoadedTaskWithTier[],
  options: ListCommandOptions,
): LoadedTaskWithTier[] {
  let filteredTasks = tasks;

  if (options.status) {
    if (!STATUSES.includes(options.status as (typeof STATUSES)[number])) {
      console.warn(`Invalid status filter: "${options.status}". Allowed: ${STATUSES.join(", ")}`);
    }

    filteredTasks = filteredTasks.filter((task) => task.spec.status === options.status);
  }

  if (options.domain) {
    filteredTasks = filteredTasks.filter((task) => task.spec.domain === options.domain);
  }

  return filteredTasks;
}

function resolveTier(options: ListCommandOptions): LoadTaskTier {
  const selectedTiers = [options.completed, options.archived, options.all].filter(Boolean).length;

  if (selectedTiers > 1) {
    console.error("Use only one of --completed, --archived, or --all");
    process.exit(1);
  }

  if (options.completed) {
    return "completed";
  }

  if (options.archived) {
    return "archived";
  }

  if (options.all) {
    return "all";
  }

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

function groupTasksBy(
  tasks: LoadedTaskWithTier[],
  groupBy: GroupByField,
): Map<string, LoadedTaskWithTier[]> {
  const groups = new Map<string, LoadedTaskWithTier[]>();

  for (const task of tasks) {
    let key: string;
    switch (groupBy) {
      case "status":
        key = task.spec.status;
        break;
      case "domain":
        key = task.spec.domain;
        break;
      case "tier":
        key = task.tier;
        break;
    }
    const existing = groups.get(key);
    if (existing) {
      existing.push(task);
    } else {
      groups.set(key, [task]);
    }
  }

  return groups;
}

function formatGroupHeader(groupBy: GroupByField, key: string, count: number): string {
  const label = groupBy === "tier" ? "Tier" : groupBy === "status" ? "Status" : "Domain";
  return styleHelpSection(`── ${label}: ${key} (${count}) ──────────`);
}

export function listCommand(
  specsTasksDir: string,
  _cwd: string,
  options: ListCommandOptions = {},
): void {
  const tier = resolveTier(options);
  const taskDirs = requiredTaskDirs(specsTasksDir, tier);
  const hasReadableTaskDir = taskDirs.some((taskDir) => existsSync(taskDir));
  const tasksRoot = resolveTasksRoot(specsTasksDir);
  const hasTaskStorage = existsSync(tasksRoot) || existsSync(specsTasksDir);

  if (!hasReadableTaskDir && !hasTaskStorage) {
    console.error(`Tasks directory does not exist: ${taskDirs[0]}`);
    process.exit(1);
  }

  const { tasks, errors } = loadTasks(specsTasksDir, tier);

  if (errors.length > 0) {
    console.warn(
      `  ⚠ ${errors.length} task file(s) could not be loaded (run "manciple validate" for details).`,
    );
  }

  const hasFilters = Boolean(options.status || options.domain);
  const filteredTasks = applyFilters(tasks, options);

  if (filteredTasks.length === 0) {
    if (hasFilters) {
      console.log("No tasks match the given filters.");
      return;
    }

    console.log("No tasks found.");
    return;
  }

  const showTier = tier === "all" || options.groupBy === "tier";

  if (options.groupBy) {
    if (!VALID_GROUP_BY_VALUES.includes(options.groupBy)) {
      console.error(
        `Invalid --group-by value: "${options.groupBy}". Allowed: ${VALID_GROUP_BY_VALUES.join(", ")}`,
      );
      process.exit(1);
    }

    const groups = groupTasksBy(filteredTasks, options.groupBy);
    const allRows = formatRows(filteredTasks, showTier);

    // Print column header once before groups
    if (allRows.length > 0) {
      console.log(allRows[0]);
    }

    for (const [key, groupTasks] of groups) {
      console.log(formatGroupHeader(options.groupBy, key, groupTasks.length));
      const rows = formatRows(groupTasks, showTier);
      // Skip the column header row per group, only show data rows
      for (const row of rows.slice(1)) {
        console.log(row);
      }
    }
    return;
  }

  for (const row of formatRows(filteredTasks, showTier)) {
    console.log(row);
  }
}
