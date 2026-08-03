import { relative } from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDispatchPlan } from "../commands/dispatchPlan.js";
import { VERIFY_PROFILE_NAMES, parseVerifyProfile, runVerifyProfile } from "../commands/verify.js";
import { checkLifecyclePlacement } from "../lifecycle/placement.js";
import { listTasksForMcp } from "../mcpList.js";
import { loadTasks } from "../specs/loadTasks.js";
import type { LoadedTaskWithTier } from "../specs/loadTasks.js";
import { validateTasks } from "../specs/validateTasks.js";
import { getRepoContext, repoInputSchema } from "./context.js";
import type { McpRepoContext } from "./context.js";
import { jsonResult, toolResult } from "./results.js";
import { findManagedWorktreeByWorkspace } from "../worktrees/manager.js";

function dependencyContextTask(task: LoadedTaskWithTier): LoadedTaskWithTier {
  return {
    ...task,
    spec: {
      ...task.spec,
      depends_on: [],
      allowed_paths: ["dependency-context"],
      forbidden_paths: ["dependency-context"],
      outputs_required: ["dependency-context"],
      notes: ["Loaded only so active task dependency references can be resolved."],
    },
  };
}

function loadActiveValidationTasks(ctx: McpRepoContext): {
  tasks: LoadedTaskWithTier[];
  errors: Array<{ filePath: string; error: string }>;
  activeFilePaths: Set<string>;
} {
  const activeResult = loadTasks(ctx.paths.specsTasks, "active");
  const allResult = loadTasks(ctx.paths.specsTasks, "all");
  const activeIds = new Set(activeResult.tasks.map((task) => task.spec.id));
  const activeFilePaths = new Set(activeResult.tasks.map((task) => task.filePath));
  const contextTasks = allResult.tasks
    .filter((task) => !activeIds.has(task.spec.id))
    .map(dependencyContextTask);

  return {
    tasks: [...activeResult.tasks, ...contextTasks],
    errors: activeResult.errors,
    activeFilePaths,
  };
}

export function registerOverviewTools(server: McpServer): void {
  server.registerTool(
    "manciple_list",
    {
      title: "List Manciple Tasks",
      description: "List Manciple tasks, optionally filtered by status or domain.",
      inputSchema: {
        ...repoInputSchema,
        status: z.string().optional(),
        tier: z.enum(["active", "completed", "archived", "all"]).optional(),
        domain: z.string().optional(),
      },
    },
    ({ repo, status, tier, domain }) =>
      toolResult(() => {
        const ctx = getRepoContext(repo);
        return jsonResult(listTasksForMcp(ctx.paths.specsTasks, ctx.cwd, { status, tier, domain }));
      })
  );

  server.registerTool(
    "manciple_validate",
    {
      title: "Validate Manciple Tasks",
      description: "Run schema and semantic validation for Manciple task specs.",
      inputSchema: repoInputSchema,
    },
    ({ repo }) =>
      toolResult(() => {
        const ctx = getRepoContext(repo);
        const {
          tasks,
          errors: loadErrors,
          activeFilePaths,
        } = loadActiveValidationTasks(ctx);
        const result = validateTasks(tasks, {
          specsDomainsDir: ctx.paths.specsDomains,
          countFilePaths: activeFilePaths,
        });
        const valid = result.valid.filter((task) => activeFilePaths.has(task.filePath));
        const invalid = result.invalid.filter((entry) => activeFilePaths.has(entry.filePath));
        const errors = [
          ...loadErrors.map((error) => ({
            file: relative(ctx.cwd, error.filePath),
            message: error.error,
          })),
          ...invalid.flatMap(({ filePath, errors: issues }) =>
            issues.map((issue) => ({
              file: relative(ctx.cwd, filePath),
              message: `[${issue.field}] ${issue.message}`,
            }))
          ),
        ];

        return jsonResult({
          valid_count: valid.length,
          error_count: errors.length,
          counts: {
            tasks_checked: result.counts.tasksChecked + loadErrors.length,
            domains_checked: result.counts.domainsChecked,
            contracts_checked: result.counts.contractsChecked + loadErrors.length,
          },
          errors,
        });
      })
  );

  server.registerTool(
    "manciple_check_lifecycle",
    {
      title: "Check Manciple Lifecycle Placement",
      description: "Validate that task files live in the lifecycle directory matching their status.",
      inputSchema: repoInputSchema,
    },
    ({ repo }) =>
      toolResult(() => {
        const ctx = getRepoContext(repo);
        return jsonResult(
          checkLifecyclePlacement({
            cwd: ctx.cwd,
            activeDir: ctx.paths.tasksActive,
            completedDir: ctx.paths.tasksCompleted,
            archivedDir: ctx.paths.tasksArchived,
          })
        );
      })
  );

  server.registerTool(
    "manciple_dispatch_plan",
    {
      title: "Build Manciple Dispatch Plan",
      description:
        "Return a deterministic coordinator packet with assignments, deferrals, stop conditions, and verification commands.",
      inputSchema: {
        ...repoInputSchema,
        use_worktrees: z.boolean().optional().describe("Override worktrees.enabled for this dispatch only."),
      },
    },
    ({ repo, use_worktrees }) =>
      toolResult(() => {
        const ctx = getRepoContext(repo);
        return jsonResult(createDispatchPlan(ctx.paths.specsTasks, ctx.cwd, { useWorktrees: use_worktrees }));
      })
  );

  server.registerTool(
    "manciple_verify",
    {
      title: "Run Manciple Verify Profile",
      description: "Run a deterministic verification profile and return a compact pass/fail receipt.",
      inputSchema: {
        ...repoInputSchema,
        profile: z.enum(VERIFY_PROFILE_NAMES),
        workspace: z.string().optional().describe("Registered managed worktree in which verification should run."),
      },
    },
    ({ repo, profile, workspace }) =>
      toolResult(async () => {
        const ctx = getRepoContext(repo);
        let verificationCwd = ctx.cwd;
        if (workspace) {
          const record = findManagedWorktreeByWorkspace(workspace, {
            controlRepo: ctx.cwd,
            worktreesDir: ctx.paths.worktrees,
            specsTasksDir: ctx.paths.specsTasks,
          });
          if (!record) throw new Error(`Workspace is not a registered Manciple worktree: ${workspace}`);
          verificationCwd = record.workspacePath;
        }
        return jsonResult(await runVerifyProfile(parseVerifyProfile(profile), { cwd: verificationCwd }));
      })
  );
}
