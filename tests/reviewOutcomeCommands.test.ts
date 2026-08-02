import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parse } from "yaml";
import { spawnSync } from "child_process";

import { initCommand } from "../src/commands/init.js";
import { newCommand } from "../src/commands/new.js";
import { setStatusCommand } from "../src/commands/setStatus.js";
import { approveCommand } from "../src/commands/approve.js";
import { requestChangesCommand } from "../src/commands/requestChanges.js";
import { blockReviewCommand } from "../src/commands/blockReview.js";
import { getPaths } from "../src/utils/paths.js";

let cwd: string;
let p: ReturnType<typeof getPaths>;

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf-8",
  });
}

function createTaskInReview(title = "Review outcome test"): string {
  newCommand(title, {
    type: "implementation",
    domain: "core",
    priority: "high",
    cwd,
    activeDir: p.tasksActive,
  });
  const taskId = title.toLowerCase().replaceAll(" ", "-");
  setStatusCommand(taskId, "needs_review", p.specsTasks, cwd);
  return taskId;
}

function readTaskStatus(filePath: string): unknown {
  return (parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>)["status"];
}

function latestOutcome(): string {
  const file = readdirSync(p.runs)
    .filter((name) => name.endsWith("-review-outcome.md"))
    .sort()
    .at(-1);

  expect(file).toBeDefined();
  return readFileSync(join(p.runs, file ?? ""), "utf-8");
}

function expectExit(callback: () => void): string {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    throw new Error(`process.exit(${code})`);
  }) as never);

  try {
    expect(callback).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    return errorSpy.mock.calls.flat().join("\n");
  } finally {
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-review-outcome-"));
  p = getPaths(cwd, ".manciple");
  await initCommand({ force: false, cwd, root: ".manciple" });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("review outcome commands", () => {
  it("routes packaged review skills through the task gate and dedicated outcome commands", () => {
    for (const harness of [".codex", ".claude"]) {
      const skill = readFileSync(
        join(process.cwd(), harness, "skills", "manciple-review", "SKILL.md"),
        "utf-8"
      );

      expect(skill).toContain(
        "pnpm exec manciple review check <task-id> --deterministic --machine"
      );
      expect(skill).toContain("Do not call `manciple_run_log` for a review verdict");
      expect(skill).toContain("pnpm exec manciple request-changes <task-id> --reason");
      expect(skill).not.toContain("pnpm exec manciple verify --profile review");
    }
  });

  it("documents review outcome commands and required reason options in CLI help", () => {
    const mainHelp = runCli(["--help"]);
    const allHelp = runCli(["--help", "--all"]);
    const requestChangesHelp = runCli(["request-changes", "--help"]);
    const blockReviewHelp = runCli(["block-review", "--help"]);

    // Default --help shows only 6 primary commands
    expect(mainHelp.status).toBe(0);
    expect(mainHelp.stdout).toContain("  init");
    expect(mainHelp.stdout).toContain("  handoff");
    expect(mainHelp.stdout).toContain("  check");
    expect(mainHelp.stdout).toContain("  review");
    expect(mainHelp.stdout).toContain("  task");
    expect(mainHelp.stdout).toContain("  submit");
    expect(mainHelp.stdout).not.toContain("approve <task-id>");
    expect(mainHelp.stdout).not.toContain("request-changes");
    expect(mainHelp.stdout).not.toContain("block-review");
    expect(mainHelp.stdout).toContain("--help --all");

    // --help --all shows legacy commands
    expect(allHelp.status).toBe(0);
    expect(allHelp.stdout).toContain("approve");
    expect(allHelp.stdout).toContain("request-changes");
    expect(allHelp.stdout).toContain("block-review");

    // Subcommand --help still works for legacy commands
    expect(requestChangesHelp.stdout).toContain("--reason <text>");
    expect(blockReviewHelp.stdout).toContain("--reason <text>");
  });

  it("approves a task in needs_review, records the outcome, and moves it to completed", () => {
    const taskId = createTaskInReview();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      approveCommand(taskId, {
        specsTasksDir: p.specsTasks,
        completedDir: p.tasksCompleted,
        runsDir: p.runs,
        cwd,
      });
    } finally {
      logSpy.mockRestore();
    }

    const completedFile = join(p.tasksCompleted, `${taskId}.yaml`);
    expect(existsSync(completedFile)).toBe(true);
    expect(existsSync(join(p.tasksActive, `${taskId}.yaml`))).toBe(false);
    expect(readTaskStatus(completedFile)).toBe("complete");
    expect(latestOutcome()).toContain("- Outcome: approved");
  });

  it("requests changes for a task in needs_review and returns it to in_progress", () => {
    const taskId = createTaskInReview();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      requestChangesCommand(taskId, "Tests need one more failure case.", {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      });
    } finally {
      logSpy.mockRestore();
    }

    const activeFile = join(p.tasksActive, `${taskId}.yaml`);
    expect(existsSync(activeFile)).toBe(true);
    expect(readTaskStatus(activeFile)).toBe("in_progress");
    expect(latestOutcome()).toContain("- Outcome: changes_requested");
    expect(latestOutcome()).toContain("Tests need one more failure case.");
  });

  it("blocks review for a task in needs_review and records the reason", () => {
    const taskId = createTaskInReview();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      blockReviewCommand(taskId, "Verification environment is unavailable.", {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      });
    } finally {
      logSpy.mockRestore();
    }

    const activeFile = join(p.tasksActive, `${taskId}.yaml`);
    expect(existsSync(activeFile)).toBe(true);
    expect(readTaskStatus(activeFile)).toBe("blocked");
    expect(latestOutcome()).toContain("- Outcome: blocked");
    expect(latestOutcome()).toContain("Verification environment is unavailable.");
  });

  it("exits clearly when approving a missing task", () => {
    const message = expectExit(() => approveCommand("missing-task", {
      specsTasksDir: p.specsTasks,
      completedDir: p.tasksCompleted,
      runsDir: p.runs,
      cwd,
    }));

    expect(message).toContain("Task not found: missing-task");
  });

  it("exits clearly when approving a task not in needs_review", () => {
    newCommand("Approve too soon", {
      type: "implementation",
      domain: "core",
      priority: "high",
      cwd,
      activeDir: p.tasksActive,
    });

    const message = expectExit(() => approveCommand("approve-too-soon", {
      specsTasksDir: p.specsTasks,
      completedDir: p.tasksCompleted,
      runsDir: p.runs,
      cwd,
    }));

    expect(message).toContain("expected needs_review, found pending");
  });

  it("exits clearly when requesting changes for a missing task", () => {
    const message = expectExit(() => requestChangesCommand("missing-task", "Needs work.", {
      specsTasksDir: p.specsTasks,
      runsDir: p.runs,
      cwd,
    }));

    expect(message).toContain("Task not found: missing-task");
  });

  it("exits clearly when requesting changes for a task not in needs_review", () => {
    newCommand("Not ready", {
      type: "implementation",
      domain: "core",
      priority: "high",
      cwd,
      activeDir: p.tasksActive,
    });

    const message = expectExit(() => requestChangesCommand("not-ready", "Needs work.", {
      specsTasksDir: p.specsTasks,
      runsDir: p.runs,
      cwd,
    }));

    expect(message).toContain("expected needs_review, found pending");
  });

  it("requires a non-empty reason for request changes", () => {
    const taskId = createTaskInReview();
    const message = expectExit(() => requestChangesCommand(taskId, " ", {
      specsTasksDir: p.specsTasks,
      runsDir: p.runs,
      cwd,
    }));

    expect(message).toContain("required option '--reason <text>' must not be empty");
  });

  it("requires a non-empty reason for block review", () => {
    const taskId = createTaskInReview();
    const message = expectExit(() => blockReviewCommand(taskId, "", {
      specsTasksDir: p.specsTasks,
      runsDir: p.runs,
      cwd,
    }));

    expect(message).toContain("required option '--reason <text>' must not be empty");
  });

  it("exits clearly when blocking review for a missing task", () => {
    const message = expectExit(() => blockReviewCommand("missing-task", "Waiting on evidence.", {
      specsTasksDir: p.specsTasks,
      runsDir: p.runs,
      cwd,
    }));

    expect(message).toContain("Task not found: missing-task");
  });

  it("exits clearly when blocking review for a task not in needs_review", () => {
    newCommand("Blocked too soon", {
      type: "implementation",
      domain: "core",
      priority: "high",
      cwd,
      activeDir: p.tasksActive,
    });

    const message = expectExit(() => blockReviewCommand("blocked-too-soon", "Waiting on evidence.", {
      specsTasksDir: p.specsTasks,
      runsDir: p.runs,
      cwd,
    }));

    expect(message).toContain("expected needs_review, found pending");
  });
});
