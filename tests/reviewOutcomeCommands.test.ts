import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { approveCommand } from "../src/commands/approve.js";
import { blockReviewCommand } from "../src/commands/blockReview.js";
import { initCommand } from "../src/commands/init.js";
import { newCommand } from "../src/commands/new.js";
import { reopenCommand } from "../src/commands/reopen.js";
import { requestChangesCommand } from "../src/commands/requestChanges.js";
import { setStatusCommand } from "../src/commands/setStatus.js";
import {
  approveTask,
  blockReview as blockReviewAction,
  ReviewActionError,
  rejectTask,
  reopenTask,
  requestChanges as requestChangesAction,
} from "../src/review/reviewActions.js";
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
  return (parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>).status;
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
        "utf-8",
      );

      expect(skill).toContain("manciple review check <task-id> --deterministic --machine");
      expect(skill).toContain("Do not call `manciple_run_log` for a review verdict");
      expect(skill).toContain("manciple request-changes <task-id> --reason");
      expect(skill).toContain("globally installed public package");
      expect(skill).toContain(
        "Do not invoke `src/cli.ts`, `bin/manciple.js`, or `pnpm exec manciple`",
      );
      expect(skill).not.toContain("node --import tsx src/cli.ts");
      expect(skill).not.toContain("node bin/manciple.js review check");
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
    const message = expectExit(() =>
      approveCommand("missing-task", {
        specsTasksDir: p.specsTasks,
        completedDir: p.tasksCompleted,
        runsDir: p.runs,
        cwd,
      }),
    );

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

    const message = expectExit(() =>
      approveCommand("approve-too-soon", {
        specsTasksDir: p.specsTasks,
        completedDir: p.tasksCompleted,
        runsDir: p.runs,
        cwd,
      }),
    );

    expect(message).toContain("expected needs_review, found pending");
  });

  it("exits clearly when requesting changes for a missing task", () => {
    const message = expectExit(() =>
      requestChangesCommand("missing-task", "Needs work.", {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      }),
    );

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

    const message = expectExit(() =>
      requestChangesCommand("not-ready", "Needs work.", {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      }),
    );

    expect(message).toContain("expected needs_review, found pending");
  });

  it("requires a non-empty reason for request changes", () => {
    const taskId = createTaskInReview();
    const message = expectExit(() =>
      requestChangesCommand(taskId, " ", {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      }),
    );

    expect(message).toContain("required option '--reason <text>' must not be empty");
  });

  it("requires a non-empty reason for block review", () => {
    const taskId = createTaskInReview();
    const message = expectExit(() =>
      blockReviewCommand(taskId, "", {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      }),
    );

    expect(message).toContain("required option '--reason <text>' must not be empty");
  });

  it("exits clearly when blocking review for a missing task", () => {
    const message = expectExit(() =>
      blockReviewCommand("missing-task", "Waiting on evidence.", {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      }),
    );

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

    const message = expectExit(() =>
      blockReviewCommand("blocked-too-soon", "Waiting on evidence.", {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      }),
    );

    expect(message).toContain("expected needs_review, found pending");
  });
});

describe("shared review action layer", () => {
  it("approveTask returns a durable action result without printing", () => {
    const taskId = createTaskInReview();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    let result: ReturnType<typeof approveTask>;
    try {
      result = approveTask(taskId, {
        specsTasksDir: p.specsTasks,
        completedDir: p.tasksCompleted,
        runsDir: p.runs,
        cwd,
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(result.outcome).toBe("approved");
    expect(result.previousStatus).toBe("needs_review");
    expect(result.nextStatus).toBe("complete");
    expect(result.outcomePath).toMatch(/review-outcome\.md$/);
    expect(result.outcomePath?.startsWith("/")).toBe(false);
    expect(result.taskPath).toMatch(new RegExp(`${taskId}\\.yaml$`));

    expect(existsSync(join(p.tasksCompleted, `${taskId}.yaml`))).toBe(true);
    expect(readTaskStatus(join(p.tasksCompleted, `${taskId}.yaml`))).toBe("complete");
    expect(latestOutcome()).toContain("- Outcome: approved");
  });

  it("rejectTask moves a needs_review task to failed in the active tier with a durable outcome", () => {
    const taskId = createTaskInReview();

    const result = rejectTask(taskId, "Acceptance evidence is incomplete.", {
      specsTasksDir: p.specsTasks,
      runsDir: p.runs,
      cwd,
    });

    const activeFile = join(p.tasksActive, `${taskId}.yaml`);
    expect(result.outcome).toBe("rejected");
    expect(result.nextStatus).toBe("failed");
    expect(result.taskPath).toMatch(new RegExp(`${taskId}\\.yaml$`));
    expect(existsSync(activeFile)).toBe(true);
    expect(existsSync(join(p.tasksCompleted, `${taskId}.yaml`))).toBe(false);
    expect(readTaskStatus(activeFile)).toBe("failed");
    expect(latestOutcome()).toContain("- Outcome: rejected");
    expect(latestOutcome()).toContain("Acceptance evidence is incomplete.");
  });

  it("rejectTask requires a non-empty reason", () => {
    const taskId = createTaskInReview();

    expect(() =>
      rejectTask(taskId, " ", {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      }),
    ).toThrow(ReviewActionError);
    expect(() =>
      rejectTask(taskId, "", {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      }),
    ).toThrow("required option '--reason <text>' must not be empty");
  });

  it("rejectTask only accepts tasks in needs_review", () => {
    newCommand("Reject too soon", {
      type: "implementation",
      domain: "core",
      priority: "high",
      cwd,
      activeDir: p.tasksActive,
    });

    expect(() =>
      rejectTask("reject-too-soon", "Needs work.", {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      }),
    ).toThrow("expected needs_review, found pending");
  });

  it("blockReview action returns the blocked lifecycle result", () => {
    const taskId = createTaskInReview();

    const result = blockReviewAction(taskId, "Verification environment is unavailable.", {
      specsTasksDir: p.specsTasks,
      runsDir: p.runs,
      cwd,
    });

    expect(result.outcome).toBe("blocked");
    expect(result.nextStatus).toBe("blocked");
    expect(readTaskStatus(join(p.tasksActive, `${taskId}.yaml`))).toBe("blocked");
    expect(latestOutcome()).toContain("- Outcome: blocked");
  });

  it("requestChanges action returns the changes_requested lifecycle result", () => {
    const taskId = createTaskInReview();

    const result = requestChangesAction(taskId, "Add one more edge case.", {
      specsTasksDir: p.specsTasks,
      runsDir: p.runs,
      cwd,
    });

    expect(result.outcome).toBe("changes_requested");
    expect(result.nextStatus).toBe("in_progress");
    expect(readTaskStatus(join(p.tasksActive, `${taskId}.yaml`))).toBe("in_progress");
    expect(latestOutcome()).toContain("- Outcome: changes_requested");
  });

  it("reopenTask reopens a completed task through the shared action layer", () => {
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

    const result = reopenTask(taskId, {
      specsTasksDir: p.specsTasks,
      activeDir: p.tasksActive,
      cwd,
    });

    expect(result.outcome).toBe("reopened");
    expect(result.previousStatus).toBe("complete");
    expect(result.nextStatus).toBe("in_progress");
    expect(result.outcomePath).toBeUndefined();

    const activeFile = join(p.tasksActive, `${taskId}.yaml`);
    expect(existsSync(activeFile)).toBe(true);
    expect(existsSync(join(p.tasksCompleted, `${taskId}.yaml`))).toBe(false);
    expect(readTaskStatus(activeFile)).toBe("in_progress");
  });

  it("reopenCommand still delegates and preserves its output", () => {
    const taskId = createTaskInReview();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      approveCommand(taskId, {
        specsTasksDir: p.specsTasks,
        completedDir: p.tasksCompleted,
        runsDir: p.runs,
        cwd,
      });
      reopenCommand(taskId, {
        specsTasksDir: p.specsTasks,
        activeDir: p.tasksActive,
        cwd,
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(existsSync(join(p.tasksActive, `${taskId}.yaml`))).toBe(true);
    expect(readTaskStatus(join(p.tasksActive, `${taskId}.yaml`))).toBe("in_progress");
  });

  it("review actions validate lifecycle transitions before writing task files", () => {
    const taskId = createTaskInReview();

    expect(() =>
      approveTask(taskId, {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      }),
    ).toThrow(ReviewActionError);
    expect(() =>
      approveTask(taskId, {
        specsTasksDir: p.specsTasks,
        completedDir: p.tasksCompleted,
        runsDir: p.runs,
        cwd,
      }),
    ).not.toThrow();

    newCommand("Action blocked task", {
      type: "implementation",
      domain: "core",
      priority: "high",
      cwd,
      activeDir: p.tasksActive,
    });
    expect(() =>
      blockReviewAction("action-blocked-task", "Needs evidence.", {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      }),
    ).toThrow("expected needs_review, found pending");
  });
});
