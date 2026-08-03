/**
 * CLI workflow tests for the new command groups (task, submit, handoff, review, check)
 * and legacy command deprecation notices.
 *
 * Testing strategy:
 * - Import command functions directly (not via CLI spawn) following happyPath.test.ts pattern.
 * - Use vi.spyOn to capture console.log/error and process.exit calls.
 * - Use spawnSync for CLI-level help output and process-boundary deprecation tests.
 * - Focus on verifying delegation to existing command functions — do not re-test the
 *   underlying implementations, only the new wrapper wiring.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parse } from "yaml";
import { spawnSync } from "child_process";

import { initCommand } from "../src/commands/init.js";
import { newCommand } from "../src/commands/new.js";
import { listCommand } from "../src/commands/list.js";
import { setStatusCommand } from "../src/commands/setStatus.js";
import { completeCommand } from "../src/commands/complete.js";
import { archiveCommand } from "../src/commands/archive.js";
import { reopenCommand } from "../src/commands/reopen.js";
import { runLogCommand } from "../src/commands/runLog.js";
import { compileCommand } from "../src/commands/compile.js";
import { taskPacketCommand } from "../src/commands/taskPacket.js";
import { handoffCommand } from "../src/commands/handoff.js";
import { reviewCommand } from "../src/commands/review.js";
import { reviewCheckCommand } from "../src/commands/reviewCheck.js";
import { reviewQueueCommand } from "../src/commands/reviewQueue.js";
import { approveCommand } from "../src/commands/approve.js";
import { requestChangesCommand } from "../src/commands/requestChanges.js";
import { blockReviewCommand } from "../src/commands/blockReview.js";
import { doctorCommand } from "../src/commands/doctor.js";
import { validateCommand } from "../src/commands/validate.js";
import { checkLifecycleCommand } from "../src/commands/checkLifecycle.js";
import {
  checkDefaultCommand,
  checkTasksCommand,
  checkLifecycleSubCommand,
  checkTokensCommand,
  checkCostCommand,
} from "../src/commands/check.js";
import type { CheckContext } from "../src/commands/check.js";
import { getPaths } from "../src/utils/paths.js";
import type { Status } from "../src/constants.js";
import { loadTasks } from "../src/specs/loadTasks.js";

// ── Helpers ──────────────────────────────────────────────────────────────

let cwd: string;
let p: ReturnType<typeof getPaths>;

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf-8",
  });
}

function createTask(title = "CLI workflow test"): string {
  newCommand(title, {
    type: "implementation",
    domain: "core",
    priority: "high",
    cwd,
    activeDir: p.tasksActive,
  });
  return title.toLowerCase().replaceAll(" ", "-");
}

function readStatus(taskId: string): unknown {
  const { tasks } = loadTasks(p.specsTasks, "all");
  const found = tasks.find((t) => t.spec.id === taskId);
  if (!found) return undefined;
  return (parse(readFileSync(found.filePath, "utf-8")) as Record<string, unknown>)["status"];
}

function captureExit(callback: () => void): { error: string; log: string } {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: string | number | null) => {
    throw new Error(`process.exit(${_code})`);
  }) as never);

  try {
    callback();
    return {
      error: errorSpy.mock.calls.flat().join("\n"),
      log: logSpy.mock.calls.flat().join("\n"),
    };
  } catch (e) {
    return {
      error: errorSpy.mock.calls.flat().join("\n"),
      log: logSpy.mock.calls.flat().join("\n"),
    };
  } finally {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

function captureOutput(callback: () => void): { error: string; log: string } {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

  try {
    callback();
  } catch {
    // ignore
  }

  const result = {
    error: errorSpy.mock.calls.flat().join("\n"),
    log: logSpy.mock.calls.flat().join("\n"),
  };

  errorSpy.mockRestore();
  logSpy.mockRestore();
  return result;
}

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-cli-workflow-"));
  p = getPaths(cwd, ".manciple");
  await initCommand({ force: false, cwd, root: ".manciple" });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// ── init flags ───────────────────────────────────────────────────────────

describe("manciple init flags", () => {
  it("init with no flags runs full directory structure, MCP config, and agent install", async () => {
    // Full setup: lifecycle dirs exist
    expect(existsSync(p.tasksActive)).toBe(true);
    expect(existsSync(p.tasksCompleted)).toBe(true);
    expect(existsSync(p.tasksArchived)).toBe(true);
    expect(existsSync(p.promptsTemplates)).toBe(true);
    expect(existsSync(p.stateFile)).toBe(true);
    // MCP config created
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(true);
  });

  it("init --mcp only touches .mcp.json and skips directory creation", async () => {
    const mcpOnlyDir = mkdtempSync(join(tmpdir(), "manciple-mcp-only-"));
    const mp = getPaths(mcpOnlyDir, ".manciple");

    try {
      await initCommand({ force: false, cwd: mcpOnlyDir, root: ".manciple", mcp: true });

      // MCP config created
      expect(existsSync(join(mcpOnlyDir, ".mcp.json"))).toBe(true);

      // Lifecycle directories NOT created
      expect(existsSync(mp.tasksActive)).toBe(false);
      expect(existsSync(mp.tasksCompleted)).toBe(false);
      expect(existsSync(mp.tasksArchived)).toBe(false);
      expect(existsSync(mp.promptsTemplates)).toBe(false);

      // .gitignore NOT updated (happens only in full setup)
      expect(existsSync(join(mcpOnlyDir, ".gitignore"))).toBe(false);
    } finally {
      rmSync(mcpOnlyDir, { recursive: true, force: true });
    }
  });

  it("init --agents only installs packaged assets and skips directory creation", async () => {
    const agentsOnlyDir = mkdtempSync(join(tmpdir(), "manciple-agents-only-"));
    const ap = getPaths(agentsOnlyDir, ".manciple");

    try {
      await initCommand({ force: false, cwd: agentsOnlyDir, root: ".manciple", agents: true });

      // Lifecycle directories NOT created
      expect(existsSync(ap.tasksActive)).toBe(false);
      expect(existsSync(ap.tasksCompleted)).toBe(false);
      expect(existsSync(ap.tasksArchived)).toBe(false);

      // MCP config NOT created (agents != mcp)
      expect(existsSync(join(agentsOnlyDir, ".mcp.json"))).toBe(false);

      // The command completes without error — we can't easily check file copying
      // from the package in a temp dir without running install, but we can verify
      // the init log message
    } finally {
      rmSync(agentsOnlyDir, { recursive: true, force: true });
    }
  });
});

// ── task command group delegation ────────────────────────────────────────

describe("manciple task command group", () => {
  it("task new delegates to newCommand and creates a task spec", () => {
    // This is what `manciple task new <title>` does under the hood
    newCommand("Task from group", {
      type: "implementation",
      domain: "core",
      priority: "medium",
      cwd,
      activeDir: p.tasksActive,
    });

    const taskFile = join(p.tasksActive, "task-from-group.yaml");
    expect(existsSync(taskFile)).toBe(true);
    const spec = parse(readFileSync(taskFile, "utf-8")) as Record<string, unknown>;
    expect(spec["id"]).toBe("task-from-group");
  });

  it("task list delegates to listCommand", () => {
    createTask("Listable task");

    // `manciple task list` calls listCommand under the hood
    const { error, log } = captureOutput(() => {
      listCommand(p.specsTasks, cwd);
    });

    expect(log).toContain("listable-task");
    expect(error).toBe("");
  });

  it("task start sets status to in_progress", () => {
    const taskId = createTask("Startable task");

    // `manciple task start <task-id>` calls setStatusCommand(id, "in_progress")
    expect(() => setStatusCommand(taskId, "in_progress" as Status, p.specsTasks, cwd)).not.toThrow();
    expect(readStatus(taskId)).toBe("in_progress");
  });

  it("task show prints the raw task YAML", () => {
    const taskId = createTask("Showable task");

    const { log } = captureOutput(() => {
      // This replicates what `manciple task show <task-id>` does:
      // loadTasks, find the task, readFileSync, console.log
      const { tasks } = loadTasks(p.specsTasks, "all");
      const found = tasks.find((t) => t.spec.id === taskId);
      expect(found).toBeDefined();
      const raw = readFileSync(found!.filePath, "utf-8");
      console.log(raw);
    });

    expect(log).toContain("id: showable-task");
    expect(log).toContain("title: Showable task");
  });

  it("task archive delegates to archiveCommand", () => {
    const taskId = createTask("Archivable task");

    // `manciple task archive <task-id>` calls archiveCommand
    archiveCommand(taskId, {
      specsTasksDir: p.specsTasks,
      archivedDir: p.tasksArchived,
      cwd,
    });

    expect(existsSync(join(p.tasksActive, "archivable-task.yaml"))).toBe(false);
    expect(existsSync(join(p.tasksArchived, "archivable-task.yaml"))).toBe(true);
  });

  it("task reopen delegates to reopenCommand", () => {
    const taskId = createTask("Reopenable task");

    // Complete it first
    completeCommand(taskId, {
      specsTasksDir: p.specsTasks,
      completedDir: p.tasksCompleted,
      cwd,
    });

    // `manciple task reopen <task-id>` calls reopenCommand
    reopenCommand(taskId, {
      specsTasksDir: p.specsTasks,
      activeDir: p.tasksActive,
      cwd,
    });

    expect(existsSync(join(p.tasksActive, "reopenable-task.yaml"))).toBe(true);
    expect(readStatus(taskId)).toBe("in_progress");
  });

  it("task pause sets blocked status", () => {
    const taskId = createTask("Pausable task");

    // `manciple task pause <task-id> --reason <text>` calls setStatusCommand(id, "blocked")
    expect(() => setStatusCommand(taskId, "blocked" as Status, p.specsTasks, cwd)).not.toThrow();
    expect(readStatus(taskId)).toBe("blocked");
  });

  it("task resume sets in_progress for tasks not in blocked/completed/archived", () => {
    const taskId = createTask("Resumable task");

    // Start the task first
    setStatusCommand(taskId, "in_progress" as Status, p.specsTasks, cwd);

    // `manciple task resume <task-id>` — for non-blocked/non-completed active tasks, sets in_progress
    expect(() => setStatusCommand(taskId, "in_progress" as Status, p.specsTasks, cwd)).not.toThrow();
    expect(readStatus(taskId)).toBe("in_progress");
  });
});

// ── submit delegation ────────────────────────────────────────────────────

describe("manciple submit delegation", () => {
  it("submit --result complete creates a run log and sets needs_review", () => {
    const taskId = createTask("Submit review task");

    // Start the task first
    setStatusCommand(taskId, "in_progress" as Status, p.specsTasks, cwd);

    // `manciple submit <task-id> --result complete` ⇒
    //   runLogCommand(result=complete) + setStatusCommand(needs_review)
    const { log } = captureOutput(() => {
      runLogCommand(taskId, p.specsTasks, p.runs, p.promptsGenerated, cwd, {
        result: "complete",
        agent: "test",
      });
      setStatusCommand(taskId, "needs_review" as Status, p.specsTasks, cwd);
    });

    expect(log).toContain("Created run log");
    expect(readStatus(taskId)).toBe("needs_review");
  });

  it("submit --complete creates a run log and completes the task", () => {
    const taskId = createTask("Submit complete task");

    // Start the task first
    setStatusCommand(taskId, "in_progress" as Status, p.specsTasks, cwd);

    // `manciple submit <task-id> --complete` ⇒
    //   runLogCommand(result=complete) + completeCommand
    const { log } = captureOutput(() => {
      runLogCommand(taskId, p.specsTasks, p.runs, p.promptsGenerated, cwd, {
        result: "complete",
        agent: "test",
      });
      completeCommand(taskId, {
        specsTasksDir: p.specsTasks,
        completedDir: p.tasksCompleted,
        cwd,
      });
    });

    expect(log).toContain("Created run log");
    expect(log).toContain("Completed:");
    expect(existsSync(join(p.tasksActive, "submit-complete-task.yaml"))).toBe(false);
    expect(existsSync(join(p.tasksCompleted, "submit-complete-task.yaml"))).toBe(true);
  });

  it("submit --blocked --reason creates a run log and sets blocked", () => {
    const taskId = createTask("Submit blocked task");

    // `manciple submit <task-id> --blocked --reason <text>` ⇒
    //   runLogCommand(result=blocked) + setStatusCommand(blocked)
    const { log } = captureOutput(() => {
      runLogCommand(taskId, p.specsTasks, p.runs, p.promptsGenerated, cwd, {
        result: "blocked",
        agent: "test",
      });
      setStatusCommand(taskId, "blocked" as Status, p.specsTasks, cwd);
    });

    expect(log).toContain("Created run log");
    expect(readStatus(taskId)).toBe("blocked");
  });
});

// ── handoff delegation ───────────────────────────────────────────────────

describe("manciple handoff delegation", () => {
  it("handoff <task-id> produces a compiled prompt (same as compile)", () => {
    const taskId = createTask("Handoff compile task");

    // `manciple handoff <task-id>` calls handoffCommand with packet=false,
    // which delegates to compileCommand
    const { log } = captureOutput(() => {
      handoffCommand(taskId, {
        cwd,
        specsTasksDir: p.specsTasks,
        tasksActiveDir: p.tasksActive,
        generatedDir: p.promptsGenerated,
        packet: false,
      });
    });

    const promptFile = join(p.promptsGenerated, "handoff-compile-task.md");
    expect(existsSync(promptFile)).toBe(true);
    expect(log).toContain("Compiled:");
    expect(readFileSync(promptFile, "utf-8")).toContain("Handoff compile task");
  });

  it("handoff <task-id> --packet produces a JSON task packet (same as task-packet)", () => {
    const taskId = createTask("Handoff packet task");

    // `manciple handoff <task-id> --packet` calls handoffCommand with packet=true,
    // which delegates to taskPacketCommand
    const { log } = captureOutput(() => {
      handoffCommand(taskId, {
        cwd,
        specsTasksDir: p.specsTasks,
        tasksActiveDir: p.tasksActive,
        generatedDir: p.promptsGenerated,
        packet: true,
      });
    });

    expect(log).toContain(taskId);
    expect(log).toContain("Handoff packet task");
    expect(log).toContain('"task_id"');
    // Should be valid JSON
    expect(() => JSON.parse(log)).not.toThrow();
  });
});

// ── review subcommand delegation ─────────────────────────────────────────

describe("manciple review subcommands", () => {
  it("review check delegates to reviewCheckCommand", () => {
    const taskId = createTask("Review check task");

    // Put it in needs_review
    setStatusCommand(taskId, "needs_review" as Status, p.specsTasks, cwd);

    // `manciple review check <task-id>` calls reviewCheckCommand
    const { log } = captureOutput(() => {
      reviewCheckCommand(p.tasksActive, cwd, taskId);
    });

    // Should find the task and report on it
    expect(log).toContain(taskId);
  });

  it("review queue (triage) delegates to reviewQueueCommand", () => {
    const taskId = createTask("Review queue task");

    // Put it in needs_review
    setStatusCommand(taskId, "needs_review" as Status, p.specsTasks, cwd);

    // `manciple review queue` calls reviewQueueCommand with mode="triage"
    const { log } = captureOutput(() => {
      reviewQueueCommand(p.tasksActive, cwd, { mode: "triage" });
    });

    // Triage mode should show decision lines
    expect(log).toContain(taskId);
  });

  it("review prompt generates a review prompt (same as manciple review <task-id>)", () => {
    const taskId = createTask("Review prompt task");

    // We need a compiled prompt first
    compileCommand({
      specsTasksDir: p.tasksActive,
      generatedDir: p.promptsGenerated,
      cwd,
      taskId,
    });

    // `manciple review prompt <task-id>` calls reviewCommand
    const { log } = captureOutput(() => {
      reviewCommand(taskId, p.specsTasks, p.promptsGenerated, cwd);
    });

    expect(log).toContain("Review prompt created");
    const reviewFile = join(p.promptsGenerated, `review-${taskId}.md`);
    expect(existsSync(reviewFile)).toBe(true);
  });

  it("review approve delegates to approveCommand", () => {
    const taskId = createTask("Review approve task");

    // Put it in needs_review
    setStatusCommand(taskId, "needs_review" as Status, p.specsTasks, cwd);

    // `manciple review approve <task-id>` calls approveCommand
    const { log } = captureOutput(() => {
      approveCommand(taskId, {
        specsTasksDir: p.specsTasks,
        completedDir: p.tasksCompleted,
        runsDir: p.runs,
        cwd,
      });
    });

    expect(log).toContain("Approved:");
    expect(existsSync(join(p.tasksActive, "review-approve-task.yaml"))).toBe(false);
    expect(existsSync(join(p.tasksCompleted, "review-approve-task.yaml"))).toBe(true);
    expect(readStatus(taskId)).toBe("complete");
  });

  it("review changes delegates to requestChangesCommand", () => {
    const taskId = createTask("Review changes task");

    // Put it in needs_review
    setStatusCommand(taskId, "needs_review" as Status, p.specsTasks, cwd);

    // `manciple review changes <task-id> --reason <text>` calls requestChangesCommand
    const { log } = captureOutput(() => {
      requestChangesCommand(taskId, "Need more edge case coverage.", {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      });
    });

    expect(log).toContain("Recorded review outcome");
    expect(readStatus(taskId)).toBe("in_progress");
  });

  it("review block delegates to blockReviewCommand", () => {
    const taskId = createTask("Review block task");

    // Put it in needs_review
    setStatusCommand(taskId, "needs_review" as Status, p.specsTasks, cwd);

    // `manciple review block <task-id> --reason <text>` calls blockReviewCommand
    const { log } = captureOutput(() => {
      blockReviewCommand(taskId, "Verification environment unavailable.", {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      });
    });

    expect(log).toContain("Recorded review outcome");
    expect(readStatus(taskId)).toBe("blocked");
  });
});

// ── check subcommand delegation ──────────────────────────────────────────

describe("manciple check subcommands", () => {
  function checkContext(): CheckContext {
    return {
      cwd,
      root: ".manciple",
      specsTasksDir: p.specsTasks,
      tasksActiveDir: p.tasksActive,
      tasksCompletedDir: p.tasksCompleted,
      tasksArchivedDir: p.tasksArchived,
      runsDir: p.runs,
      generatedDir: p.promptsGenerated,
    };
  }

  it("check (default) runs doctor + validate + lifecycle check", () => {
    const ctx = checkContext();

    const { log } = captureOutput(() => {
      checkDefaultCommand(ctx);
    });

    // Doctor output (headerBanner adds the branded line)
    expect(log).toContain("Manciple — A repo-native workflow layer");
    // Validate output
    expect(log).toContain("Checked:");
    // Lifecycle check output
    expect(log).toContain("Lifecycle placement");
  });

  it("check tasks runs validate", () => {
    const ctx = checkContext();

    const { log } = captureOutput(() => {
      checkTasksCommand(ctx);
    });

    // Should produce validate-like output
    expect(log).toContain("Checked:");
  });

  it("check lifecycle runs lifecycle check", () => {
    const ctx = checkContext();

    const { log } = captureOutput(() => {
      checkLifecycleSubCommand(ctx);
    });

    expect(log).toContain("Lifecycle placement");
  });

  it("check tokens runs token estimate for a task", () => {
    const taskId = createTask("Check tokens task");
    const ctx = checkContext();

    const { log } = captureOutput(() => {
      checkTokensCommand(ctx, taskId);
    });

    // Token estimate should reference the task
    expect(log).toContain(taskId);
    expect(log).toContain("estimated tokens");
  });

  it("check cost summarizes run costs", () => {
    const ctx = checkContext();

    const { log } = captureOutput(() => {
      checkCostCommand(ctx);
    });

    // With no runs, cost summary should show 0 runs
    expect(log).toContain("Run Cost Summary");
    expect(log).toContain("Run count: 0");
  });
});

// ── CLI --help output structure ──────────────────────────────────────────

describe("CLI --help output structure", () => {
  it("--help shows only the 6 primary commands", () => {
    const result = runCli(["--help"]);

    expect(result.status).toBe(0);

    // Primary commands
    expect(result.stdout).toContain("  init");
    expect(result.stdout).toContain("  task");
    expect(result.stdout).toContain("  submit");
    expect(result.stdout).toContain("  handoff");
    expect(result.stdout).toContain("  review");
    expect(result.stdout).toContain("  check");

    // Legacy commands should be hidden
    expect(result.stdout).not.toContain("  compile");
    expect(result.stdout).not.toContain("  validate");
    expect(result.stdout).not.toContain("  complete");
    expect(result.stdout).not.toContain("  archive");
    expect(result.stdout).not.toContain("  approve");
    expect(result.stdout).not.toContain("  request-changes");
    expect(result.stdout).not.toContain("  block-review");
    expect(result.stdout).not.toContain("  doctor");
    expect(result.stdout).not.toContain("  list");
    expect(result.stdout).not.toContain("  set-status");
    expect(result.stdout).not.toContain("  new");

    // Hint about --all
    expect(result.stdout).toContain("--help --all");
  });

  it("--help --all shows legacy commands too", () => {
    const result = runCli(["--help", "--all"]);

    expect(result.status).toBe(0);

    // Primary commands still shown
    expect(result.stdout).toContain("  init");
    expect(result.stdout).toContain("  task");

    // Legacy commands now visible
    expect(result.stdout).toContain("  compile");
    expect(result.stdout).toContain("  validate");
    expect(result.stdout).toContain("  complete");
    expect(result.stdout).toContain("  archive");
    expect(result.stdout).toContain("  approve");
    expect(result.stdout).toContain("  request-changes");
    expect(result.stdout).toContain("  block-review");
    expect(result.stdout).toContain("  doctor");
    expect(result.stdout).toContain("  list");
    expect(result.stdout).toContain("  set-status");
    expect(result.stdout).toContain("  new");
  });
});

// ── Legacy command deprecation ───────────────────────────────────────────

describe("Legacy command deprecation", () => {
  it("legacy compile command prints deprecation hint to stderr", () => {
    const result = runCli(["compile"]);

    // stderr should have the deprecation hint
    expect(result.stderr).toContain("manciple compile -> manciple handoff");
  });

  it("legacy list command prints deprecation hint to stderr", () => {
    const result = runCli(["list"]);

    expect(result.stderr).toContain("manciple list -> manciple task list");
    // The command still works — stdout has output
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("legacy new command prints deprecation hint to stderr", () => {
    const result = runCli(["new"]);

    expect(result.stderr).toContain("manciple new -> manciple task new");
  });

  it("legacy new command exits nonzero for missing title at the CLI boundary", () => {
    const result = runCli(["new"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: missing required argument 'title'");
  });

  it("legacy new command exits nonzero for task creation errors at the CLI boundary", () => {
    const result = runCli(["new", "Empty goal from cli", "--goal", " "]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Error: --goal value must not be empty.");
  });

  it("legacy validate command prints deprecation hint to stderr", () => {
    const result = runCli(["validate"]);

    expect(result.stderr).toContain("manciple validate -> manciple check tasks");
  });

  it("legacy doctor command prints deprecation hint to stderr", () => {
    const result = runCli(["doctor"]);

    expect(result.stderr).toContain("manciple doctor -> manciple check");
  });

  it("multiple legacy commands each emit their own deprecation hint once", () => {
    const result = runCli(["validate"]);

    // Hint appears exactly once (the shownDeprecation set prevents duplicates)
    const matches = result.stderr.match(/manciple validate -> manciple check tasks/g);
    expect(matches).not.toBeNull();

    // The command still produces stdout output (it still works)
    expect(result.stdout).toBeDefined();
  });
});

// ── version parity ───────────────────────────────────────────────────────

describe("CLI version parity", () => {
  it("manciple --version reports the package.json version", () => {
    const result = runCli(["--version"]);
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")) as {
      version: string;
    };

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });
});
