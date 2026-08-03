import type { Command } from "commander";
import type { ManciplePaths } from "../utils/paths.js";
import { checkLifecycleCommand } from "./checkLifecycle.js";
import { doctorCommand } from "./doctor.js";
import { summarizeRunCostCommand } from "./summarizeRunCost.js";
import { DEFAULT_TOKEN_BUDGET, tokenEstimateCommand } from "./tokenEstimate.js";
import { validateCommand } from "./validate.js";
import { verifyCommand } from "./verify.js";

export interface CheckContext {
  cwd: string;
  root: string;
  specsTasksDir: string;
  tasksActiveDir: string;
  tasksCompletedDir: string;
  tasksArchivedDir: string;
  runsDir: string;
  generatedDir: string;
}

/**
 * `manciple check` — runs doctor + validate + lifecycle check in sequence
 */
export function checkDefaultCommand(ctx: CheckContext): void {
  doctorCommand(ctx.cwd, ctx.root);
  console.log();
  validateCommand(ctx.tasksActiveDir, ctx.cwd);
  console.log();
  checkLifecycleCommand({
    cwd: ctx.cwd,
    activeDir: ctx.tasksActiveDir,
    completedDir: ctx.tasksCompletedDir,
    archivedDir: ctx.tasksArchivedDir,
  });
}

/**
 * `manciple check tasks` — validate all task specs
 */
export function checkTasksCommand(ctx: CheckContext): void {
  validateCommand(ctx.tasksActiveDir, ctx.cwd);
}

/**
 * `manciple check lifecycle` — lifecycle placement check
 */
export function checkLifecycleSubCommand(ctx: CheckContext): void {
  checkLifecycleCommand({
    cwd: ctx.cwd,
    activeDir: ctx.tasksActiveDir,
    completedDir: ctx.tasksCompletedDir,
    archivedDir: ctx.tasksArchivedDir,
  });
}

/**
 * `manciple check verify --profile <profile>` — run verification
 */
export function checkVerifyCommand(profile: string, cwd: string): Promise<void> {
  return verifyCommand(profile, cwd);
}

/**
 * `manciple check tokens <task-id>` — token estimate
 */
export function checkTokensCommand(ctx: CheckContext, taskId: string): void {
  tokenEstimateCommand({
    specsTasksDir: ctx.specsTasksDir,
    cwd: ctx.cwd,
    taskId,
  });
}

/**
 * `manciple check cost` — summarize run costs
 */
export function checkCostCommand(ctx: CheckContext): void {
  summarizeRunCostCommand(ctx.runsDir);
}

function parseNumberOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative number, got "${value}".`);
  }
  return parsed;
}

function createCheckContext(p: ManciplePaths, cwd: string, root: string): CheckContext {
  return {
    cwd,
    root,
    specsTasksDir: p.specsTasks,
    tasksActiveDir: p.tasksActive,
    tasksCompletedDir: p.tasksCompleted,
    tasksArchivedDir: p.tasksArchived,
    runsDir: p.runs,
    generatedDir: p.promptsGenerated,
  };
}

export function registerCheckCommands(
  program: Command,
  p: ManciplePaths,
  cwd: string,
  root: string,
): void {
  const ctx = createCheckContext(p, cwd, root);

  const check = program
    .command("check")
    .description(
      "Health summary, validation, lifecycle check, and diagnostics. See `manciple check --help`.",
    )
    .action(() => {
      checkDefaultCommand(ctx);
    });

  check
    .command("tasks")
    .description("Validate all task specs (same as `manciple validate`).")
    .action(() => {
      checkTasksCommand(ctx);
    });

  check
    .command("lifecycle")
    .description("Run lifecycle placement check (same as `manciple check-lifecycle`).")
    .action(() => {
      checkLifecycleSubCommand(ctx);
    });

  check
    .command("verify")
    .description("Run verification (same as `manciple verify`).")
    .requiredOption("--profile <profile>", "Verification profile: coordinator, worker, or review.")
    .action(async (opts: { profile: string }) => {
      await checkVerifyCommand(opts.profile, cwd);
    });

  check
    .command("tokens <task-id>")
    .description("Estimate token usage for a task (same as `manciple token-estimate`).")
    .action((taskId: string) => {
      checkTokensCommand(ctx, taskId);
    });

  check
    .command("cost")
    .description("Summarize run costs (same as `manciple summarize-run-cost`).")
    .action(() => {
      checkCostCommand(ctx);
    });

  program
    .command("validate")
    .description("Validate all task specs.")
    .option("--all", "Validate active, completed, and archived tasks.", false)
    .action((opts: { all: boolean }) => {
      validateCommand(p.tasksActive, cwd, { all: opts.all });
    });

  program
    .command("check-lifecycle")
    .description("Validate that task files live in the lifecycle directory matching their status.")
    .action(() => {
      checkLifecycleCommand({
        cwd,
        activeDir: p.tasksActive,
        completedDir: p.tasksCompleted,
        archivedDir: p.tasksArchived,
      });
    });

  program
    .command("verify")
    .description("Run a deterministic verification profile.")
    .requiredOption("--profile <profile>", "Verification profile: coordinator, worker, or review.")
    .action(async (opts: { profile?: string }) => {
      await verifyCommand(opts.profile, cwd);
    });

  program
    .command("doctor")
    .description("Check whether this repo is configured correctly for Manciple.")
    .action(() => {
      doctorCommand(cwd, root);
    });

  program
    .command("token-estimate <task-id>")
    .description("Estimate Manciple handoff prompt size using a deterministic local heuristic.")
    .option(
      "--budget <tokens>",
      "Estimated-token budget for risk reporting.",
      parseNumberOption,
      DEFAULT_TOKEN_BUDGET,
    )
    .option("--include-review", "Include generated review prompt estimate.", false)
    .option("--include-run-log", "Include latest run log estimate.", false)
    .option("--include-diff", "Include git diff estimate.", false)
    .option("--include-git-context", "Include compact git status context estimate.", false)
    .option(
      "--append-run-log",
      "Append the token-estimate section to the latest existing run log.",
      false,
    )
    .action(
      (
        taskId: string,
        opts: {
          budget: number;
          includeReview: boolean;
          includeRunLog: boolean;
          includeDiff: boolean;
          includeGitContext: boolean;
          appendRunLog: boolean;
        },
      ) => {
        tokenEstimateCommand({
          specsTasksDir: p.specsTasks,
          cwd,
          taskId,
          budget: opts.budget,
          includeReview: opts.includeReview,
          includeRunLog: opts.includeRunLog,
          includeDiff: opts.includeDiff,
          includeGitContext: opts.includeGitContext,
          appendRunLog: opts.appendRunLog,
        });
      },
    );

  program
    .command("summarize-run-cost [task-id]")
    .description("Summarize recorded run-log model, token, and cost evidence.")
    .action((taskId: string | undefined) => {
      summarizeRunCostCommand(p.runs, taskId);
    });
}
