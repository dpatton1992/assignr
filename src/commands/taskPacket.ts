import { relative } from "node:path";
import type { PathOwnershipWarning } from "../specs/loadTasks.js";
import { loadTasks, pathOwnershipWarningsForTask } from "../specs/loadTasks.js";
import type { TaskSpec } from "../specs/schema.js";

export interface TaskPacket {
  task_id: string;
  title: string;
  status: TaskSpec["status"];
  type: TaskSpec["type"];
  domain: string;
  priority: TaskSpec["priority"];
  depends_on: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  path_ownership: TaskSpec["path_ownership"];
  acceptance_criteria: string[];
  implementation_notes: string[];
  verification_commands: string[];
  outputs_required: string[];
  notes: string[];
  path_ownership_warnings: PathOwnershipWarning[];
}

export interface BuildTaskPacketOptions {
  taskId: string;
  specsTasksDir: string;
  cwd: string;
}

export function buildTaskPacket(options: BuildTaskPacketOptions): TaskPacket {
  const { taskId, specsTasksDir, cwd } = options;
  const { tasks, errors } = loadTasks(specsTasksDir, "all");
  if (errors.length > 0) {
    const message = errors
      .map((error) => `${relative(cwd, error.filePath)}: ${error.error}`)
      .join("; ");
    throw new Error(`Cannot load tasks: ${message}`);
  }

  const found = tasks.find((task) => task.spec.id === taskId);
  if (!found) throw new Error(`Task not found: ${taskId}`);

  const { spec } = found;
  return {
    task_id: spec.id,
    title: spec.title,
    status: spec.status,
    type: spec.type,
    domain: spec.domain,
    priority: spec.priority,
    depends_on: spec.depends_on,
    allowed_paths: spec.allowed_paths,
    forbidden_paths: spec.forbidden_paths,
    path_ownership: spec.path_ownership,
    acceptance_criteria: spec.acceptance_criteria,
    implementation_notes: spec.implementation_notes ?? [],
    verification_commands: spec.verification.commands,
    outputs_required: spec.outputs_required,
    notes: spec.notes,
    path_ownership_warnings: pathOwnershipWarningsForTask(found, tasks),
  };
}

export interface TaskPacketCommandOptions {
  specsTasksDir: string;
  cwd: string;
  taskId: string;
}

export function taskPacketCommand(options: TaskPacketCommandOptions): void {
  try {
    console.log(JSON.stringify(buildTaskPacket(options), null, 2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
