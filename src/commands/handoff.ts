import type { Command } from "commander";
import { compileCommand } from "./compile.js";
import type { CompileOptions } from "./compile.js";
import { taskPacketCommand } from "./taskPacket.js";
import type { TaskPacketCommandOptions } from "./taskPacket.js";
import { coordinatorCommand } from "./coordinator.js";
import { dispatchPlanCommand } from "./dispatchPlan.js";
import { plannerContextCommand } from "./plannerContext.js";
import type { ManciplePaths } from "../utils/paths.js";
import { loadConfig } from "../config.js";

export interface HandoffContext {
  cwd: string;
  specsTasksDir: string;
  tasksActiveDir: string;
  generatedDir: string;
}

/**
 * `manciple handoff <task-id>` — compile prompt
 * `manciple handoff <task-id> --packet` — compact worker packet
 */
export function handoffCommand(
  taskId: string,
  ctx: HandoffContext & { packet?: boolean }
): void {
  if (ctx.packet) {
    taskPacketCommand({
      specsTasksDir: ctx.specsTasksDir,
      cwd: ctx.cwd,
      taskId,
    });
  } else {
    compileCommand({
      specsTasksDir: ctx.tasksActiveDir,
      generatedDir: ctx.generatedDir,
      cwd: ctx.cwd,
      taskId,
    });
  }
}

/**
 * `manciple handoff queue` — coordinator queue
 * `manciple handoff queue --json` — dispatch plan JSON
 */
export function handoffQueueCommand(ctx: HandoffContext & { json?: boolean; useWorktrees?: boolean }): void {
  const useWorktrees = ctx.useWorktrees ?? loadConfig(ctx.cwd).worktrees.enabled;
  if (ctx.json) {
    dispatchPlanCommand(ctx.specsTasksDir, ctx.cwd, { useWorktrees });
  } else {
    coordinatorCommand(ctx.specsTasksDir, ctx.cwd, { dependenciesRequireComplete: useWorktrees });
  }
}

function parseNumberOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative number, got "${value}".`);
  }
  return parsed;
}

export function registerHandoffCommands(program: Command, p: ManciplePaths, cwd: string): void {
  const handoff = program
    .command("handoff [task-id]")
    .description("Compile a task prompt, or inspect the worker queue. See `manciple handoff --help`.")
    .option("--packet", "Print compact worker packet instead of compiled prompt.", false)
    .action((taskId: string | undefined, opts: { packet: boolean }) => {
      if (taskId) {
        handoffCommand(taskId, {
          cwd,
          specsTasksDir: p.specsTasks,
          tasksActiveDir: p.tasksActive,
          generatedDir: p.promptsGenerated,
          packet: opts.packet,
        });
      } else {
        handoff.help();
      }
    });

  handoff
    .command("queue")
    .description("Show runnable/deferred work (same as `manciple coordinator`). Use --json for dispatch plan (same as `manciple dispatch-plan`).")
    .option("--json", "Print deterministic dispatch packet JSON.", false)
    .option("--worktrees", "Use managed worktrees for this dispatch.")
    .option("--no-worktrees", "Use in-place execution for this dispatch.")
    .action((opts: { json: boolean; worktrees?: boolean }) => {
      handoffQueueCommand({
        cwd,
        specsTasksDir: p.specsTasks,
        tasksActiveDir: p.tasksActive,
        generatedDir: p.promptsGenerated,
        json: opts.json,
        useWorktrees: opts.worktrees,
      });
    });

  program
    .command("compile [task-id]")
    .description("Compile task specs into markdown prompts.")
    .option("--status <status>", "Compile tasks with this status.")
    .option("--all", "Compile tasks from active, completed, and archived lifecycle directories.", false)
    .action((taskId: string | undefined, opts: { status?: string; all: boolean }) => {
      compileCommand({
        specsTasksDir: p.tasksActive,
        generatedDir: p.promptsGenerated,
        cwd,
        taskId,
        status: opts.status as CompileOptions["status"],
        all: opts.all,
      });
    });

  program
    .command("task-packet <task-id>")
    .description("Print a compact bounded worker packet for one task.")
    .action((taskId: string) => {
      taskPacketCommand({
        specsTasksDir: p.specsTasks,
        cwd,
        taskId,
      });
    });

  program
    .command("planner-context")
    .description("Print a compact bounded task index for planning agents.")
    .option("--status <status>", "Show only tasks with this exact status (case-sensitive).")
    .option("--domain <domain>", "Show only tasks in this exact domain (case-sensitive).")
    .option("--completed", "Include completed lifecycle tasks instead of active tasks.")
    .option("--archived", "Include archived lifecycle tasks instead of active tasks.")
    .option("--all", "Include active, completed, and archived lifecycle tasks.")
    .option("--max-chars <count>", "Warn and truncate generated context above this character budget.", parseNumberOption)
    .option("--max-tokens <count>", "Warn and truncate generated context above this estimated token budget.", parseNumberOption)
    .option("--strict", "Exit with status 1 when the requested budget truncates planner context.", false)
    .action((opts: {
      status?: string;
      domain?: string;
      completed?: boolean;
      archived?: boolean;
      all?: boolean;
      maxChars?: number;
      maxTokens?: number;
      strict?: boolean;
    }) => {
      plannerContextCommand(p.specsTasks, cwd, {
        status: opts.status,
        domain: opts.domain,
        completed: opts.completed,
        archived: opts.archived,
        all: opts.all,
        maxChars: opts.maxChars,
        maxTokens: opts.maxTokens,
        strict: opts.strict,
      });
    });

  program
    .command("coordinator")
    .description("Show the owner queue for runnable, waiting, review, complete-ready, blocked, and rework tasks.")
    .option("--worktrees", "Use managed-worktree dependency semantics.")
    .option("--no-worktrees", "Use in-place dependency semantics.")
    .action((opts: { worktrees?: boolean }) => {
      const useWorktrees = opts.worktrees ?? loadConfig(cwd).worktrees.enabled;
      coordinatorCommand(p.specsTasks, cwd, { dependenciesRequireComplete: useWorktrees });
    });

  program
    .command("dispatch-plan")
    .description("Print a deterministic coordinator dispatch packet as JSON.")
    .option("--worktrees", "Use managed worktrees for this dispatch.")
    .option("--no-worktrees", "Use in-place execution for this dispatch.")
    .action((opts: { worktrees?: boolean }) => {
      dispatchPlanCommand(p.specsTasks, cwd, { useWorktrees: opts.worktrees });
    });
}
