import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { z } from "zod";
import { parse } from "yaml";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PRIORITIES, STATUSES, TASK_TYPES } from "../constants.js";
import type { Status } from "../constants.js";
import { TaskSpecSchema } from "../specs/schema.js";
import { slugify } from "../utils/slugify.js";
import { formatYamlDocument } from "../utils/yamlFormat.js";
import { getRepoContext, repoInputSchema } from "./context.js";
import { errorResult, jsonResult, toolResult } from "./results.js";
import { findTask } from "./taskHelpers.js";
import { setTaskStatus } from "../commands/setStatus.js";
import { assertDirectCompletionAllowed, isGitRepository, setManagedWorktreeState } from "../worktrees/manager.js";

export function registerTaskSpecTools(server: McpServer): void {
  server.registerTool(
    "manciple_create",
    {
      title: "Create Manciple Task",
      description:
        "Create a new Manciple task spec in the active tasks directory. Generates the task id from the title using slugify. Returns an error if a task with the same id already exists.",
      inputSchema: {
        ...repoInputSchema,
        title: z.string().min(1).describe("Human-readable task title. The id is derived from this."),
        type: z.enum(TASK_TYPES).describe("Task type."),
        domain: z.string().min(1).describe("Domain label, e.g. auth, core, api."),
        priority: z.enum(PRIORITIES).optional().describe("Task priority. Defaults to medium."),
        goal: z.string().min(1).describe("One sentence describing what is done when this task is complete."),
        acceptance_criteria: z.array(z.string()).min(1).describe("Specific, testable criteria the implementation must satisfy."),
        implementation_notes: z.array(z.string()).optional().describe("Behavior, product, or design constraints the runner must preserve."),
        verification_commands: z.array(z.string()).min(1).describe("Shell commands to verify the work. Must be runnable in the repo as-is."),
        allowed_paths: z.array(z.string()).optional().describe("Glob patterns or exact paths the agent may edit."),
        forbidden_paths: z.array(z.string()).optional().describe("Paths the agent must not touch."),
        depends_on: z.array(z.string()).optional().describe("IDs of tasks that must complete before this one starts."),
        outputs_required: z.array(z.string()).optional().describe("Evidence fields the agent must report. Defaults to files_changed, tests_run, risks."),
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
        const id = slugify(title);

        const existing = findTask(id, ctx);
        if (existing) {
          return errorResult(
            `A task with id "${id}" already exists at ${relative(ctx.cwd, existing.filePath)}. Choose a different title or update the existing task.`
          );
        }

        const spec = {
          id,
          title,
          status: "pending" as const,
          type,
          domain,
          priority: priority ?? "medium",
          depends_on: depends_on ?? [],
          allowed_paths: allowed_paths ?? [],
          forbidden_paths: forbidden_paths ?? [],
          goal,
          acceptance_criteria,
          implementation_notes: implementation_notes ?? [],
          verification: { commands: verification_commands },
          outputs_required: outputs_required ?? ["files_changed", "tests_run", "risks"],
          notes: notes ?? [],
        };

        const parsed = TaskSpecSchema.safeParse(spec);
        if (!parsed.success) {
          const messages = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          return errorResult(`Invalid task spec: ${messages}`);
        }

        if (!existsSync(ctx.paths.tasksActive)) {
          mkdirSync(ctx.paths.tasksActive, { recursive: true });
        }

        const filePath = join(ctx.paths.tasksActive, `${id}.yaml`);
        writeFileSync(filePath, formatYamlDocument(parsed.data), "utf-8");

        return jsonResult({ id, file_path: relative(ctx.cwd, filePath) });
      })
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
      })
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

        if (status === "complete") {
          assertDirectCompletionAllowed(task_id, {
            controlRepo: ctx.cwd,
            worktreesDir: ctx.paths.worktrees,
            specsTasksDir: ctx.paths.specsTasks,
          });
        }

        const result = setTaskStatus(task_id, status as Status, ctx.paths.specsTasks);
        const claimState = status === "needs_review"
          ? "review_ready"
          : status === "in_progress" || status === "blocked" || status === "partial" || status === "failed"
            ? "available"
            : undefined;
        if (claimState && isGitRepository(ctx.cwd)) {
          setManagedWorktreeState(task_id, claimState, {
            controlRepo: ctx.cwd,
            worktreesDir: ctx.paths.worktrees,
            specsTasksDir: ctx.paths.specsTasks,
          });
        }

        return jsonResult({
          previous_status: result.previousStatus,
          new_status: status,
          file: result.updatedPath,
        });
      })
  );
}
