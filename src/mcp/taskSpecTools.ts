import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parse } from "yaml";
import { z } from "zod";
import type { Status } from "../constants.js";
import { PRIORITIES, STATUSES, TASK_TYPES } from "../constants.js";
import { setTaskStatusWithLifecycle } from "../lifecycle/taskLifecycleService.js";
import { createTask } from "../tasks/taskCreationService.js";
import { getRepoContext, repoInputSchema } from "./context.js";
import { errorResult, jsonResult, toolResult } from "./results.js";
import { findTask } from "./taskHelpers.js";

export function registerTaskSpecTools(server: McpServer): void {
  server.registerTool(
    "manciple_create",
    {
      title: "Create Manciple Task",
      description:
        "Create a new Manciple task spec in the active tasks directory. Generates the task id from the title using slugify. Returns an error if a task with the same id already exists.",
      inputSchema: {
        ...repoInputSchema,
        title: z
          .string()
          .min(1)
          .describe("Human-readable task title. The id is derived from this."),
        type: z.enum(TASK_TYPES).describe("Task type."),
        domain: z.string().min(1).describe("Domain label, e.g. auth, core, api."),
        priority: z.enum(PRIORITIES).optional().describe("Task priority. Defaults to medium."),
        goal: z
          .string()
          .min(1)
          .describe("One sentence describing what is done when this task is complete."),
        acceptance_criteria: z
          .array(z.string())
          .min(1)
          .describe("Specific, testable criteria the implementation must satisfy."),
        implementation_notes: z
          .array(z.string())
          .optional()
          .describe("Behavior, product, or design constraints the runner must preserve."),
        verification_commands: z
          .array(z.string())
          .min(1)
          .describe("Shell commands to verify the work. Must be runnable in the repo as-is."),
        allowed_paths: z
          .array(z.string())
          .optional()
          .describe("Glob patterns or exact paths the agent may edit."),
        forbidden_paths: z.array(z.string()).optional().describe("Paths the agent must not touch."),
        depends_on: z
          .array(z.string())
          .optional()
          .describe("IDs of tasks that must complete before this one starts."),
        outputs_required: z
          .array(z.string())
          .optional()
          .describe(
            "Evidence fields the agent must report. Defaults to files_changed, tests_run, risks.",
          ),
        notes: z.array(z.string()).optional().describe("Free-form notes or constraints."),
      },
    },
    ({
      repo,
      title,
      type,
      domain,
      priority,
      goal,
      acceptance_criteria,
      implementation_notes,
      verification_commands,
      allowed_paths,
      forbidden_paths,
      depends_on,
      outputs_required,
      notes,
    }) =>
      toolResult(() => {
        const ctx = getRepoContext(repo);
        const result = createTask({
          title,
          type,
          domain,
          priority,
          goal,
          acceptanceCriteria: acceptance_criteria,
          implementationNotes: implementation_notes,
          verificationCommands: verification_commands,
          allowedPaths: allowed_paths,
          forbiddenPaths: forbidden_paths,
          dependsOn: depends_on,
          outputsRequired: outputs_required,
          notes,
          activeDir: ctx.paths.tasksActive,
        });

        if (!result.ok) {
          if (result.code === "duplicate" && result.existingPath) {
            return errorResult(
              `A task with id "${result.id}" already exists at ${relative(ctx.cwd, result.existingPath)}. Choose a different title or update the existing task.`,
            );
          }
          return errorResult(result.message);
        }

        return jsonResult({ id: result.id, file_path: relative(ctx.cwd, result.filePath) });
      }),
  );

  server.registerTool(
    "manciple_get_task",
    {
      title: "Get Manciple Task",
      description: "Read a task YAML file and return the parsed task spec.",
      inputSchema: {
        ...repoInputSchema,
        task_id: z.string(),
      },
    },
    ({ repo, task_id }) =>
      toolResult(() => {
        const ctx = getRepoContext(repo);
        const found = findTask(task_id, ctx);
        if (!found) return errorResult(`Task not found: ${task_id}`);

        const raw = readFileSync(found.filePath, "utf-8");
        const parsed = parse(raw);
        return jsonResult(parsed);
      }),
  );

  server.registerTool(
    "manciple_set_status",
    {
      title: "Set Manciple Task Status",
      description: "Update the status field for one Manciple task YAML file.",
      inputSchema: {
        ...repoInputSchema,
        task_id: z.string(),
        status: z.string(),
      },
    },
    ({ repo, task_id, status }) =>
      toolResult(() => {
        const ctx = getRepoContext(repo);
        if (!STATUSES.includes(status as Status)) {
          return errorResult(`Invalid status: "${status}". Allowed: ${STATUSES.join(", ")}`);
        }

        const found = findTask(task_id, ctx);
        if (!found) return errorResult(`Task not found: ${task_id}`);

        const result = setTaskStatusWithLifecycle(task_id, status as Status, {
          specsTasksDir: ctx.paths.specsTasks,
          controlRepo: ctx.cwd,
          worktreesDir: ctx.paths.worktrees,
        });

        if (!result.ok) {
          return errorResult(result.message ?? "Task status update failed.");
        }

        return jsonResult({
          previous_status: result.previousStatus,
          new_status: status,
          file: result.updatedPath,
        });
      }),
  );
}
