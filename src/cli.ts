#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "module";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { loadConfig } from "./config.js";
import { DEFAULT_ROOT } from "./constants.js";
import { formatTaskCommand } from "./commands/formatTask.js";
import { initCommand } from "./commands/init.js";
import { installAssetsCommand } from "./commands/installAssets.js";
import { mcpConfigCommand } from "./commands/mcpConfig.js";
import { migrateAssignrCommand } from "./commands/migrateAssignr.js";
import { migrateTasksCommand } from "./commands/migrateTasks.js";
import { normalizeLegacyWorktreeArgs, registerWorktreeCommands } from "./commands/worktree.js";
import { registerCheckCommands } from "./commands/check.js";
import { registerHandoffCommands } from "./commands/handoff.js";
import { configureLegacyCommandCompatibility } from "./commands/legacy.js";
import { registerReviewCommands } from "./commands/review.js";
import { registerSubmitCommand } from "./commands/submit.js";
import { registerTaskCommands } from "./commands/task.js";
import { getPaths } from "./utils/paths.js";
import { headerBanner } from "./utils/styling.js";

async function runCliAction(action: () => void | Promise<void>): Promise<void> {
  // Command modules should throw; Commander actions translate failures to stderr and exit codes.
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const cwd = process.cwd();
const config = loadConfig(cwd);
const root = config.root;
const p = getPaths(cwd, root);

const program = new Command();

function shouldLinkGlobalOnInit(): boolean {
	const invokedScript = process.argv[1];
	if (!invokedScript) return false;
	return resolve(invokedScript) === join(packageRoot, "bin", "manciple.js") && resolve(cwd) === packageRoot;
}

program
  .name("manciple")
  .description("A repo-native workflow layer for existing coding agents.")
  .version(version);

program.addHelpText("beforeAll", headerBanner());

program
  .command("init")
  .description("Initialize Manciple folder structure, MCP config, gitignore entries, and packaged agent skills/agents in this repo.")
  .option("--force", "Overwrite existing files.", false)
  .option("--root <dir>", "Root directory for Manciple.", DEFAULT_ROOT)
  .option("--mcp", "Only set up MCP config (.mcp.json), skip directory creation and agents.", false)
  .option("--agents", "Only install packaged agent skills and agents, skip directory creation and MCP.", false)
  .option("--verbose", "Show detailed per-directory and per-file output.", false)
  .action(async (opts: { force: boolean; root: string; mcp: boolean; agents: boolean; verbose: boolean }) => {
    await initCommand({
      force: opts.force,
      cwd,
      root: opts.root,
      mcp: opts.mcp,
      agents: opts.agents,
      verbose: opts.verbose,
      globalLink: shouldLinkGlobalOnInit() ? { packageRoot } : undefined,
    });
  });

program
  .command("install-assets")
  .description("Copy packaged agent skills (.claude/skills/, .codex/skills/) and OpenCode agents (.opencode/agents/) from node_modules to the repo root.")
  .option("--force", "Overwrite existing files.", false)
  .action((opts: { force: boolean }) => {
    installAssetsCommand({ cwd, force: opts.force });
  });

program
  .command("format-task <task-id>")
  .description("Check or format one task YAML file by task id.")
  .option("--check", "Check formatting without writing changes.", false)
  .action((taskId: string, opts: { check: boolean }) => {
    formatTaskCommand(taskId, {
      specsTasksDir: p.specsTasks,
      cwd,
      checkOnly: opts.check,
    });
  });

program
  .command("migrate-tasks")
  .description("One-time migration: copy legacy specs/tasks task files into lifecycle directories.")
  .action(async () => {
    await migrateTasksCommand({
      specsTasksDir: p.specsTasks,
      activeDir: p.tasksActive,
      completedDir: p.tasksCompleted,
      archivedDir: p.tasksArchived,
      cwd,
    });
  });

program
  .command("migrate-assignr")
  .description("One-time migration: rename Assignr repo artifacts and config to Manciple.")
  .option("--yes", "Apply migration without prompting.", false)
  .option("--dry-run", "Preview migration without changing files.", false)
  .action(async (opts: { yes: boolean; dryRun: boolean }) => {
    await migrateAssignrCommand({ cwd, yes: opts.yes, dryRun: opts.dryRun });
  });

registerWorktreeCommands(program, p, cwd);

program
  .command("mcp-config")
  .description("Create or update .mcp.json for the Manciple MCP server.")
  .option("--force", "Overwrite an existing manciple MCP server entry.", false)
  .action((opts: { force: boolean }) => {
    mcpConfigCommand({ cwd, force: opts.force });
  });

registerHandoffCommands(program, p, cwd);
registerTaskCommands(program, p, cwd, { runCliAction });
registerSubmitCommand(program, p, cwd);
registerReviewCommands(program, p, cwd);
registerCheckCommands(program, p, cwd, root);

const filteredArgv = normalizeLegacyWorktreeArgs(configureLegacyCommandCompatibility(program, process.argv));
program.parse(filteredArgv);
