import { relative } from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadTasks } from "../specs/loadTasks.js";
import { setTaskStatus } from "../commands/setStatus.js";
import {
  assertInPlaceExecutionAllowed,
  getManagedWorktree,
  listManagedWorktrees,
  prepareManagedWorktree,
  pruneManagedWorktrees,
  releaseManagedWorktree,
  removeManagedWorktree,
} from "../worktrees/manager.js";
import type { ManagedWorktreeRecord } from "../worktrees/manager.js";
import { getRepoContext, repoInputSchema } from "./context.js";
import { errorResult, jsonResult, toolResult } from "./results.js";
import { loadConfig } from "../config.js";

function jsonRecord(record: ManagedWorktreeRecord, cwd: string): Record<string, unknown> {
  return {
    mode: "worktree",
    prepared: true,
    task_id: record.taskId,
    control_repo: record.controlRepo,
    workspace_path: record.workspacePath,
    workspace_relative: relative(cwd, record.workspacePath),
    branch: record.branch,
    base_branch: record.baseBranch,
    base_sha: record.baseSha,
    claim_state: record.claimState,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    ...(record.integratedSha ? { integrated_sha: record.integratedSha } : {}),
  };
}

export function registerWorktreeTools(server: McpServer): void {
  server.registerTool(
    "manciple_prepare_worktree",
    {
      title: "Prepare Manciple Task Worktree",
      description: "Create or reclaim a managed task worktree and mark the task in progress.",
      inputSchema: {
        ...repoInputSchema,
        task_id: z.string(),
        use_worktrees: z.boolean().optional().describe("Override worktrees.enabled for this preparation."),
      },
    },
    ({ repo, task_id, use_worktrees }) => toolResult(() => {
      const ctx = getRepoContext(repo);
      const { tasks } = loadTasks(ctx.paths.specsTasks, "all");
      const task = tasks.find((entry) => entry.spec.id === task_id);
      if (!task) return errorResult(`Task not found: ${task_id}`);
      if (!(use_worktrees ?? loadConfig(ctx.cwd).worktrees.enabled)) {
        assertInPlaceExecutionAllowed(task_id, {
          controlRepo: ctx.cwd,
          worktreesDir: ctx.paths.worktrees,
          specsTasksDir: ctx.paths.specsTasks,
        });
        if (task.spec.status === "pending") setTaskStatus(task_id, "in_progress", ctx.paths.specsTasks);
        return jsonResult({
          mode: "in_place",
          task_id,
          control_repo: ctx.cwd,
          workspace_path: ctx.cwd,
          prepared: true,
        });
      }
      const record = prepareManagedWorktree(task_id, {
        controlRepo: ctx.cwd,
        worktreesDir: ctx.paths.worktrees,
        specsTasksDir: ctx.paths.specsTasks,
        claim: true,
      });
      if (task.spec.status === "pending") setTaskStatus(task_id, "in_progress", ctx.paths.specsTasks);
      return jsonResult(jsonRecord(record, ctx.cwd));
    }),
  );

  server.registerTool(
    "manciple_get_worktree",
    {
      title: "Get Manciple Task Worktree",
      description: "Return one managed task worktree record.",
      inputSchema: { ...repoInputSchema, task_id: z.string() },
    },
    ({ repo, task_id }) => toolResult(() => {
      const ctx = getRepoContext(repo);
      const record = getManagedWorktree(task_id, {
        controlRepo: ctx.cwd,
        worktreesDir: ctx.paths.worktrees,
        specsTasksDir: ctx.paths.specsTasks,
      });
      return record ? jsonResult(jsonRecord(record, ctx.cwd)) : errorResult(`Managed worktree not found: ${task_id}`);
    }),
  );

  server.registerTool(
    "manciple_list_worktrees",
    {
      title: "List Manciple Task Worktrees",
      description: "Return all Manciple-managed task worktrees for a repository.",
      inputSchema: repoInputSchema,
    },
    ({ repo }) => toolResult(() => {
      const ctx = getRepoContext(repo);
      const records = listManagedWorktrees({
        controlRepo: ctx.cwd,
        worktreesDir: ctx.paths.worktrees,
        specsTasksDir: ctx.paths.specsTasks,
      });
      return jsonResult(records.map((record) => jsonRecord(record, ctx.cwd)));
    }),
  );

  server.registerTool(
    "manciple_release_worktree",
    {
      title: "Release Manciple Task Worktree",
      description: "Release a claimed managed worktree so its task can be dispatched again.",
      inputSchema: { ...repoInputSchema, task_id: z.string() },
    },
    ({ repo, task_id }) => toolResult(() => {
      const ctx = getRepoContext(repo);
      const record = releaseManagedWorktree(task_id, {
        controlRepo: ctx.cwd,
        worktreesDir: ctx.paths.worktrees,
        specsTasksDir: ctx.paths.specsTasks,
      });
      return record ? jsonResult(jsonRecord(record, ctx.cwd)) : errorResult(`Managed worktree not found: ${task_id}`);
    }),
  );

  server.registerTool(
    "manciple_remove_worktree",
    {
      title: "Remove Manciple Task Worktree",
      description: "Remove a managed task worktree and its local branch.",
      inputSchema: {
        ...repoInputSchema,
        task_id: z.string(),
        force: z.boolean().optional(),
      },
    },
    ({ repo, task_id, force }) => toolResult(() => {
      const ctx = getRepoContext(repo);
      const record = removeManagedWorktree(task_id, {
        controlRepo: ctx.cwd,
        worktreesDir: ctx.paths.worktrees,
        specsTasksDir: ctx.paths.specsTasks,
        force: force ?? false,
      });
      return jsonResult(jsonRecord(record, ctx.cwd));
    }),
  );

  server.registerTool(
    "manciple_prune_worktrees",
    {
      title: "Prune Manciple Task Worktrees",
      description: "Prune stale managed-worktree records and Git worktree metadata.",
      inputSchema: {
        ...repoInputSchema,
        dry_run: z.boolean().optional(),
      },
    },
    ({ repo, dry_run }) => toolResult(() => {
      const ctx = getRepoContext(repo);
      const result = pruneManagedWorktrees({
        controlRepo: ctx.cwd,
        worktreesDir: ctx.paths.worktrees,
        specsTasksDir: ctx.paths.specsTasks,
        dryRun: dry_run ?? false,
      });
      return jsonResult({
        removed_records: result.removedRecords,
        pruned_git_metadata: result.prunedGitMetadata,
      });
    }),
  );
}
