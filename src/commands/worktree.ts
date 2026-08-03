import type { Command } from "commander";
import { relative } from "path";
import { loadTasks } from "../specs/loadTasks.js";
import { setTaskStatus } from "./setStatus.js";
import type { ManciplePaths } from "../utils/paths.js";
import {
  getManagedWorktree,
  listManagedWorktrees,
  prepareManagedWorktree,
  pruneManagedWorktrees,
  releaseManagedWorktree,
  removeManagedWorktree,
} from "../worktrees/manager.js";
import type { ManagedWorktreeRecord, WorktreeServiceOptions } from "../worktrees/manager.js";

export interface WorktreeCommandOptions {
  cwd: string;
  worktreesDir: string;
  specsTasksDir: string;
}

function serviceOptions(options: WorktreeCommandOptions): WorktreeServiceOptions {
  return {
    controlRepo: options.cwd,
    worktreesDir: options.worktreesDir,
    specsTasksDir: options.specsTasksDir,
  };
}

function isPending(taskId: string, options: WorktreeCommandOptions): boolean {
  const { tasks } = loadTasks(options.specsTasksDir, "all");
  const task = tasks.find((entry) => entry.spec.id === taskId);
  return task?.spec.status === "pending";
}

function display(record: ManagedWorktreeRecord, cwd: string): Record<string, unknown> {
  return {
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

function cliAction(action: () => void): void {
  try {
    action();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export function worktreeCommand(taskId: string, options: WorktreeCommandOptions): ManagedWorktreeRecord {
  const shouldStart = isPending(taskId, options);
  const record = prepareManagedWorktree(taskId, { ...serviceOptions(options), claim: true });
  if (shouldStart) setTaskStatus(taskId, "in_progress", options.specsTasksDir);
  console.log(`Worktree ready: ${relative(options.cwd, record.workspacePath)}`);
  console.log(`Branch: ${record.branch}`);
  console.log(`Base: ${record.baseSha}`);
  return record;
}

export function normalizeLegacyWorktreeArgs(argv: string[]): string[] {
  const args = [...argv];
  const index = args.indexOf("worktree", 2);
  if (index === -1) return args;
  const tail = args.slice(index + 1);
  const subcommands = new Set(["create", "list", "status", "release", "remove", "prune"]);
  if (tail.some((value) => subcommands.has(value))) return args;
  if (tail.length === 0 || tail.every((value) => value.startsWith("-"))) return args;
  args.splice(index + 1, 0, "create");
  return args;
}

export function registerWorktreeCommands(program: Command, p: ManciplePaths, cwd: string): void {
  const shared = { cwd, worktreesDir: p.worktrees, specsTasksDir: p.specsTasks };
  const group = program
    .command("worktree")
    .description("Create, inspect, release, and remove Manciple-managed task worktrees.")
    .action(() => group.help());

  group
    .command("create <task-id>")
    .description("Create or claim a task-specific worktree.")
    .action((taskId: string) => {
      cliAction(() => { worktreeCommand(taskId, shared); });
    });

  group
    .command("list")
    .description("List Manciple-managed worktrees.")
    .option("--json", "Print stable JSON.", false)
    .action((opts: { json: boolean }) => {
      cliAction(() => {
        const rows = listManagedWorktrees(serviceOptions(shared)).map((record) => display(record, cwd));
        if (opts.json) return console.log(JSON.stringify(rows, null, 2));
        if (rows.length === 0) return console.log("No managed worktrees.");
        for (const row of rows) {
          console.log(`${row.task_id}\t${row.claim_state}\t${row.branch}\t${row.workspace_relative}`);
        }
      });
    });

  group
    .command("status <task-id>")
    .description("Show one managed worktree.")
    .option("--json", "Print stable JSON.", false)
    .action((taskId: string, opts: { json: boolean }) => {
      cliAction(() => {
        const record = getManagedWorktree(taskId, serviceOptions(shared));
        if (!record) throw new Error(`Managed worktree not found: ${taskId}`);
        const row = display(record, cwd);
        if (opts.json) return console.log(JSON.stringify(row, null, 2));
        for (const [key, value] of Object.entries(row)) console.log(`${key}: ${String(value)}`);
      });
    });

  group
    .command("release <task-id>")
    .description("Release a claimed worktree so the task can be dispatched again.")
    .action((taskId: string) => {
      cliAction(() => {
        const record = releaseManagedWorktree(taskId, serviceOptions(shared));
        if (!record) throw new Error(`Managed worktree not found: ${taskId}`);
        console.log(`Released: ${taskId}`);
      });
    });

  group
    .command("remove <task-id>")
    .description("Remove a Manciple-managed worktree and its local branch.")
    .option("--force", "Remove a dirty managed worktree and delete its unmerged branch.", false)
    .action((taskId: string, opts: { force: boolean }) => {
      cliAction(() => {
        const record = removeManagedWorktree(taskId, {
          ...serviceOptions(shared),
          force: opts.force,
        });
        console.log(`Removed worktree: ${relative(cwd, record.workspacePath)}`);
        console.log(`Removed branch: ${record.branch}`);
      });
    });

  group
    .command("prune")
    .description("Prune stale managed-worktree records and Git metadata.")
    .option("--dry-run", "Report stale records without changing them.", false)
    .action((opts: { dryRun: boolean }) => {
      cliAction(() => {
        const result = pruneManagedWorktrees({ ...serviceOptions(shared), dryRun: opts.dryRun });
        if (result.removedRecords.length === 0) return console.log("No stale managed worktrees.");
        const verb = opts.dryRun ? "Would prune" : "Pruned";
        for (const taskId of result.removedRecords) console.log(`${verb}: ${taskId}`);
      });
    });
}
