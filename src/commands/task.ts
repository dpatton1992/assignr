import { readFileSync } from "fs";
import type { Command } from "commander";
import { TASK_TYPES, PRIORITIES, STATUSES } from "../constants.js";
import type { TaskType, Priority, Status } from "../constants.js";
import { newCommand, newInteractiveCommand } from "./new.js";
import { listCommand } from "./list.js";
import { statusCommand } from "./status.js";
import { setStatusCommand } from "./setStatus.js";
import { completeCommand } from "./complete.js";
import { archiveCommand } from "./archive.js";
import { reopenCommand } from "./reopen.js";
import { loadTasks } from "../specs/loadTasks.js";
import type { ManciplePaths } from "../utils/paths.js";
import { loadConfig } from "../config.js";
import { worktreeCommand } from "./worktree.js";
import { assertInPlaceExecutionAllowed } from "../worktrees/manager.js";

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

export interface RegisterTaskCommandsOptions {
  runCliAction?: (action: () => void | Promise<void>) => Promise<void>;
}

export function registerTaskCommands(
  program: Command,
  p: ManciplePaths,
  cwd: string,
  options: RegisterTaskCommandsOptions = {}
): void {
  const task = program
    .command("task")
    .description("Manage tasks. See `manciple task --help` for subcommands.")
    .action(() => {
      task.help();
    });

  // manciple task new <title>
  task
    .command("new <title>")
    .description("Create a new task spec (same as `manciple new`).")
    .option("--type <type>", `Task type (${TASK_TYPES.join(", ")})`, "implementation")
    .option("--domain <domain>", "Domain for this task.", "core")
    .option("--priority <priority>", `Priority (${PRIORITIES.join(", ")})`, "medium")
    .option("--goal <goal>", "Pre-fill the goal field.")
    .option("--implementation-note <note>", "Behavior, product, or design constraint. May be repeated.", collect, [])
    .action((title: string, opts: {
      type: string;
      domain: string;
      priority: string;
      goal?: string;
      implementationNote: string[];
    }) => {
      const type = opts.type as TaskType;
      const priority = opts.priority as Priority;
      if (!TASK_TYPES.includes(type)) {
        console.error(`Invalid type: "${type}". Allowed: ${TASK_TYPES.join(", ")}`);
        process.exit(1);
      }
      if (!PRIORITIES.includes(priority)) {
        console.error(`Invalid priority: "${priority}". Allowed: ${PRIORITIES.join(", ")}`);
        process.exit(1);
      }
      newCommand(title, {
        type,
        domain: opts.domain,
        priority,
        goal: opts.goal,
        cwd,
        activeDir: p.tasksActive,
        implementationNotes: opts.implementationNote,
      });
    });

  // manciple task list
  task
    .command("list")
    .description("List task specs (same as `manciple list`).")
    .option("--status <status>", "Show only tasks with this exact status (case-sensitive).")
    .option("--domain <domain>", "Show only tasks in this exact domain (case-sensitive).")
    .option("--completed", "Show completed tasks. Mutually exclusive with --archived and --all.")
    .option("--archived", "Show archived tasks. Mutually exclusive with --completed and --all.")
    .option("--all", "Show active, completed, and archived tasks. Mutually exclusive with --completed and --archived.")
    .option("--group-by <field>", 'Group tasks by "status", "domain", or "tier".')
    .action((opts: {
      status?: string;
      domain?: string;
      completed?: boolean;
      archived?: boolean;
      all?: boolean;
      groupBy?: string;
    }) => {
      listCommand(p.specsTasks, cwd, {
        status: opts.status,
        domain: opts.domain,
        completed: opts.completed,
        archived: opts.archived,
        all: opts.all,
        groupBy: opts.groupBy as "status" | "domain" | "tier" | undefined,
      });
    });

  // manciple task show <task-id>
  task
    .command("show <task-id>")
    .description("Show task details (prints the parsed task YAML).")
    .action((taskId: string) => {
      const { tasks, errors } = loadTasks(p.specsTasks, "all");
      if (errors.length > 0) {
        console.warn(`⚠ ${errors.length} task(s) failed to load.`);
      }
      const found = tasks.find((t) => t.spec.id === taskId);
      if (!found) {
        console.error(`Task not found: ${taskId}`);
        process.exit(1);
      }
      const raw = readFileSync(found.filePath, "utf-8");
      console.log(raw);
    });

  // manciple task start <task-id>
  task
    .command("start <task-id>")
    .description("Start a task (set status to in_progress).")
    .option("--worktrees", "Create and use a managed task worktree.")
    .option("--no-worktrees", "Run this task in the primary checkout.")
    .action((taskId: string, opts: { worktrees?: boolean }) => {
      try {
        const useWorktrees = opts.worktrees ?? loadConfig(cwd).worktrees.enabled;
        if (useWorktrees) {
          worktreeCommand(taskId, { cwd, worktreesDir: p.worktrees, specsTasksDir: p.specsTasks });
        } else {
          assertInPlaceExecutionAllowed(taskId, {
            controlRepo: cwd,
            worktreesDir: p.worktrees,
            specsTasksDir: p.specsTasks,
          });
          setStatusCommand(taskId, "in_progress" as Status, p.specsTasks, cwd);
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // manciple task pause <task-id> --reason <text>
  task
    .command("pause <task-id>")
    .description("Pause a task (set status to blocked). Requires --reason.")
    .requiredOption("--reason <text>", "Reason for pausing.")
    .action((taskId: string, opts: { reason: string }) => {
      setStatusCommand(taskId, "blocked" as Status, p.specsTasks, cwd);
    });

  // manciple task resume <task-id>
  task
    .command("resume <task-id>")
    .description("Resume a task (set status to pending, or reopen if archived/completed).")
    .option("--worktrees", "Create or reclaim the managed task worktree.")
    .option("--no-worktrees", "Resume this task in the primary checkout.")
    .action((taskId: string, opts: { worktrees?: boolean }) => {
      try {
        const useWorktrees = opts.worktrees ?? loadConfig(cwd).worktrees.enabled;
        const { tasks } = loadTasks(p.specsTasks, "all");
        const found = tasks.find((t) => t.spec.id === taskId);
        if (!found) {
          console.error(`Task not found: ${taskId}`);
          process.exit(1);
        }
        if (!useWorktrees) {
          assertInPlaceExecutionAllowed(taskId, {
            controlRepo: cwd,
            worktreesDir: p.worktrees,
            specsTasksDir: p.specsTasks,
          });
        }
        if (found.tier === "completed" || found.tier === "archived") {
          reopenCommand(taskId, {
            specsTasksDir: p.specsTasks,
            activeDir: p.tasksActive,
            cwd,
          });
        } else if (found.spec.status === "blocked") {
          setStatusCommand(taskId, "pending" as Status, p.specsTasks, cwd);
        } else {
          setStatusCommand(taskId, "in_progress" as Status, p.specsTasks, cwd);
        }
        if (useWorktrees) {
          worktreeCommand(taskId, { cwd, worktreesDir: p.worktrees, specsTasksDir: p.specsTasks });
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // manciple task archive <task-id>
  task
    .command("archive <task-id>")
    .description("Archive a task (same as `manciple archive`).")
    .action((taskId: string) => {
      archiveCommand(taskId, {
        specsTasksDir: p.specsTasks,
        archivedDir: p.tasksArchived,
        cwd,
      });
    });

  // manciple task reopen <task-id>
  task
    .command("reopen <task-id>")
    .description("Reopen a task (same as `manciple reopen`).")
    .action((taskId: string) => {
      reopenCommand(taskId, {
        specsTasksDir: p.specsTasks,
        activeDir: p.tasksActive,
        cwd,
      });
    });

  program
    .command("new [title]")
    .description("Create a new task spec.")
    .option("--type <type>", `Task type (${TASK_TYPES.join(", ")})`, "implementation")
    .option("--domain <domain>", "Domain for this task.", "core")
    .option("--priority <priority>", `Priority (${PRIORITIES.join(", ")})`, "medium")
    .option("--goal <goal>", "Pre-fill the goal field.")
    .option("--implementation-note <note>", "Behavior, product, or design constraint. May be repeated.", collect, [])
    .option("--interactive", "Prompt for task fields.", false)
    .action((title: string | undefined, opts: {
      type: string;
      domain: string;
      priority: string;
      goal?: string;
      implementationNote: string[];
      interactive: boolean;
    }) => {
      const action = async () => {
        if (!title && !opts.interactive) {
          throw new Error("error: missing required argument 'title'");
        }

        const type = opts.type as TaskType;
        const priority = opts.priority as Priority;
        if (!TASK_TYPES.includes(type)) {
          throw new Error(`Invalid type: "${type}". Allowed: ${TASK_TYPES.join(", ")}`);
        }
        if (!PRIORITIES.includes(priority)) {
          throw new Error(`Invalid priority: "${priority}". Allowed: ${PRIORITIES.join(", ")}`);
        }
        if (opts.interactive) {
          await newInteractiveCommand(title, { type, domain: opts.domain, priority, goal: opts.goal, cwd, activeDir: p.tasksActive });
          return;
        }
        newCommand(title!, {
          type,
          domain: opts.domain,
          priority,
          goal: opts.goal,
          cwd,
          activeDir: p.tasksActive,
          implementationNotes: opts.implementationNote,
        });
      };

      if (options.runCliAction) {
        return options.runCliAction(action);
      }
      return action();
    });

  program
    .command("list")
    .description("List task specs in a compact table.")
    .option("--status <status>", "Show only tasks with this exact status (case-sensitive).")
    .option("--domain <domain>", "Show only tasks in this exact domain (case-sensitive).")
    .option("--completed", "Show completed tasks. Mutually exclusive with --archived and --all.")
    .option("--archived", "Show archived tasks. Mutually exclusive with --completed and --all.")
    .option("--all", "Show active, completed, and archived tasks. Mutually exclusive with --completed and --archived.")
    .option("--group-by <field>", 'Group tasks by "status", "domain", or "tier".')
    .action((opts: {
      status?: string;
      domain?: string;
      completed?: boolean;
      archived?: boolean;
      all?: boolean;
      groupBy?: string;
    }) => {
      listCommand(p.specsTasks, cwd, {
        status: opts.status,
        domain: opts.domain,
        completed: opts.completed,
        archived: opts.archived,
        all: opts.all,
        groupBy: opts.groupBy as "status" | "domain" | "tier" | undefined,
      });
    });

  program
    .command("status")
    .description("Show task status summary.")
    .action(() => {
      statusCommand(p.specsTasks, cwd);
    });

  program
    .command("set-status <task-id> <status>")
    .description(`Update task status. Allowed: ${STATUSES.join(", ")}`)
    .action((taskId: string, status: string) => {
      setStatusCommand(taskId, status as Status, p.specsTasks, cwd);
    });

  program
    .command("complete <task-id>")
    .description("Mark an active task complete and move it to tasks/completed.")
    .action((taskId: string) => {
      completeCommand(taskId, {
        specsTasksDir: p.specsTasks,
        completedDir: p.tasksCompleted,
        cwd,
      });
    });

  program
    .command("archive <task-id>")
    .description("Archive an active task and move it to tasks/archived.")
    .action((taskId: string) => {
      archiveCommand(taskId, {
        specsTasksDir: p.specsTasks,
        archivedDir: p.tasksArchived,
        cwd,
      });
    });

  program
    .command("reopen <task-id>")
    .description("Reopen a completed or archived task, searching completed first, and move it to tasks/active.")
    .action((taskId: string) => {
      reopenCommand(taskId, {
        specsTasksDir: p.specsTasks,
        activeDir: p.tasksActive,
        cwd,
      });
    });
}
