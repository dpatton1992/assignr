/**
 * Shared task-creation service.
 *
 * Owns slug generation, duplicate detection across active/completed/archived
 * tiers, default normalization, schema validation, YAML formatting, directory
 * creation, and file persistence for newly created task specs.
 *
 * The service never prints to stdout/stderr, never calls process.exit, and
 * never constructs MCP response payloads. It returns a typed result so CLI and
 * MCP adapters can format their own human-readable or structured output.
 */
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { PRIORITIES, TASK_TYPES } from "../constants.js";
import { loadTasks } from "../specs/loadTasks.js";
import type { TaskTier } from "../specs/loadTasks.js";
import { TaskSpecSchema } from "../specs/schema.js";
import { slugify } from "../utils/slugify.js";
import { formatYamlDocument } from "../utils/yamlFormat.js";

export interface CreateTaskInput {
  title: string;
  type: string;
  domain: string;
  priority?: string;
  goal?: string;
  dependsOn?: string[];
  acceptanceCriteria?: string[];
  verificationCommands?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  outputsRequired?: string[];
  implementationNotes?: string[];
  notes?: string[];
  /** Active tasks directory where the new spec is written. */
  activeDir: string;
}

export type CreateTaskFailureCode =
  | "invalid_id"
  | "empty_goal"
  | "invalid_type"
  | "invalid_priority"
  | "duplicate"
  | "invalid_spec";

export type CreateTaskResult =
  | { ok: true; id: string; filePath: string }
  | { ok: false; code: "invalid_id"; message: string }
  | {
      ok: false;
      code: "empty_goal" | "invalid_type" | "invalid_priority" | "invalid_spec";
      id: string;
      message: string;
    }
  | {
      ok: false;
      code: "duplicate";
      id: string;
      message: string;
      existingPath: string;
      existingTier: TaskTier;
    };

const DEFAULT_GOAL = "TODO: describe the goal of this task.";
const DEFAULT_ACCEPTANCE_CRITERIA = ["TODO: add acceptance criteria"];
const DEFAULT_VERIFICATION_COMMANDS = ["TODO: add verification commands"];
const DEFAULT_OUTPUTS_REQUIRED = ["files_changed", "tests_run", "risks"];

/**
 * Resolve the tasks root directory from any loadTasks-compatible directory
 * (e.g. `.manciple/specs/tasks`, `.manciple/tasks/active`, or the root itself).
 */
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

function validateChoice<T extends readonly string[]>(
  value: string,
  allowed: T,
  label: string
): { ok: true; value: T[number] } | { ok: false; message: string } {
  if (allowed.includes(value)) {
    return { ok: true, value: value as T[number] };
  }
  return { ok: false, message: `Invalid ${label}: "${value}". Allowed: ${allowed.join(", ")}` };
}

export function createTask(input: CreateTaskInput): CreateTaskResult {
  const { title, activeDir, domain } = input;
  const id = slugify(title);

  if (!id) {
    return { ok: false, code: "invalid_id", message: "could not generate a valid id from the provided title." };
  }

  // Duplicate detection spans every lifecycle tier so a title cannot silently
  // collide with an active, completed, or archived spec.
  const tasksRoot = getTasksRoot(activeDir);
  const duplicate = loadTasks(tasksRoot, "all").tasks.find((task) => task.spec.id === id);
  if (duplicate) {
    return {
      ok: false,
      code: "duplicate",
      id,
      message: "task spec already exists",
      existingPath: duplicate.filePath,
      existingTier: duplicate.tier,
    };
  }

  const typeResult = validateChoice(input.type, TASK_TYPES, "type");
  if (!typeResult.ok) {
    return { ok: false, code: "invalid_type", id, message: typeResult.message };
  }

  const priority = input.priority ?? "medium";
  const priorityResult = validateChoice(priority, PRIORITIES, "priority");
  if (!priorityResult.ok) {
    return { ok: false, code: "invalid_priority", id, message: priorityResult.message };
  }

  let goal: string;
  if (input.goal !== undefined) {
    const trimmed = input.goal.trim();
    if (!trimmed) {
      return { ok: false, code: "empty_goal", id, message: "--goal value must not be empty." };
    }
    goal = trimmed;
  } else {
    goal = DEFAULT_GOAL;
  }

  const spec = {
    id,
    title,
    status: "pending" as const,
    type: typeResult.value,
    domain,
    priority: priorityResult.value,
    depends_on: input.dependsOn ?? [],
    allowed_paths: input.allowedPaths ?? [],
    forbidden_paths: input.forbiddenPaths ?? [],
    goal,
    acceptance_criteria: input.acceptanceCriteria ?? DEFAULT_ACCEPTANCE_CRITERIA,
    implementation_notes: input.implementationNotes ?? [],
    verification: {
      commands: input.verificationCommands ?? DEFAULT_VERIFICATION_COMMANDS,
    },
    outputs_required: input.outputsRequired ?? DEFAULT_OUTPUTS_REQUIRED,
    notes: input.notes ?? [],
  };

  const parsed = TaskSpecSchema.safeParse(spec);
  if (!parsed.success) {
    const messages = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    return { ok: false, code: "invalid_spec", id, message: `Invalid task spec: ${messages}` };
  }

  if (!existsSync(activeDir)) {
    mkdirSync(activeDir, { recursive: true });
  }

  const filePath = join(activeDir, `${id}.yaml`);
  writeFileSync(filePath, formatYamlDocument(parsed.data), "utf-8");

  return { ok: true, id, filePath };
}
