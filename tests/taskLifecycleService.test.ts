/**
 * Service-level tests for the shared task-lifecycle service.
 *
 * These exercise the service directly (typed results, no printing, no exit)
 * including tier placement/movement, direct-completion safeguards, and
 * managed-worktree claim-state synchronization.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { parse } from "yaml";
import {
  archiveTask,
  completeTask,
  setTaskStatus,
  setTaskStatusWithLifecycle,
} from "../src/lifecycle/taskLifecycleService.js";
import { createTask } from "../src/tasks/taskCreationService.js";
import { getPaths } from "../src/utils/paths.js";

let cwd: string;
let p: ReturnType<typeof getPaths>;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-task-lifecycle-"));
  p = getPaths(cwd, ".manciple");
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function createActiveTask(title = "License expiration reminders"): string {
  const result = createTask({
    title,
    type: "implementation",
    domain: "credentialing",
    priority: "high",
    goal: "Add expiration reminder support for provider licenses.",
    activeDir: p.tasksActive,
  });
  if (!result.ok) {
    throw new Error(`test setup failed to create task: ${result.message}`);
  }
  return result.id;
}

function readStatus(taskId: string): string {
  const { tasks } = { tasks: [] as Array<{ spec: { id: string; status: string } }> };
  void tasks;
  const raw = readFileSync(join(p.tasksActive, `${taskId}.yaml`), "utf-8");
  return (parse(raw) as { status: string }).status;
}

function writeTierCopy(taskId: string, tier: "completed" | "archived", status: string): string {
  const dir = tier === "completed" ? p.tasksCompleted : p.tasksArchived;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${taskId}.yaml`);
  writeFileSync(
    file,
    [
      `id: ${taskId}`,
      "title: Duplicate lifecycle copy",
      `status: ${status}`,
      "type: implementation",
      "domain: core",
      "priority: medium",
      "depends_on: []",
      "allowed_paths: []",
      "forbidden_paths: []",
      "goal: Pre-existing copy used for duplicate detection.",
      "acceptance_criteria:",
      "  - It exists.",
      "implementation_notes: []",
      "verification:",
      "  commands:",
      "    - pnpm test",
      "outputs_required:",
      "  - files_changed",
      "notes: []",
      "",
    ].join("\n"),
    "utf-8"
  );
  return file;
}

function initGitRepo(): void {
  spawnSync("git", ["init", "-b", "main"], { cwd, encoding: "utf-8" });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd, encoding: "utf-8" });
  spawnSync("git", ["config", "user.name", "Manciple Test"], { cwd, encoding: "utf-8" });
}

function gitCommonDir(): string {
  return spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf-8" }).stdout.trim();
}

function registryPath(): string {
  return join(cwd, gitCommonDir(), "manciple", "worktrees-v1.json");
}

function writeWorktreeRecord(taskId: string, claimState = "assigned"): void {
  mkdirSync(join(cwd, gitCommonDir(), "manciple"), { recursive: true });
  writeFileSync(
    registryPath(),
    JSON.stringify(
      {
        version: 1,
        worktrees: {
          [taskId]: {
            taskId,
            controlRepo: cwd,
            workspacePath: join(cwd, ".manciple", "worktrees", taskId),
            branch: `manciple/${taskId}`,
            baseBranch: "main",
            baseSha: "0".repeat(40),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            claimState,
          },
        },
      },
      null,
      2
    ) + "\n",
    "utf-8"
  );
}

function readClaimState(taskId: string): string | undefined {
  if (!existsSync(registryPath())) return undefined;
  const registry = JSON.parse(readFileSync(registryPath(), "utf-8")) as {
    worktrees: Record<string, { claimState: string }>;
  };
  return registry.worktrees[taskId]?.claimState;
}

describe("lifecycle service: setTaskStatus", () => {
  it("updates the status in place for an active task", () => {
    const taskId = createActiveTask();

    const result = setTaskStatus(taskId, "in_progress", p.specsTasks);

    expect(result.ok).toBe(true);
    expect(result.previousStatus).toBe("pending");
    expect(result.newStatus).toBe("in_progress");
    expect(result.updatedPath).toBe(join(p.tasksActive, `${taskId}.yaml`));
    expect(readStatus(taskId)).toBe("in_progress");
  });

  it("moves a task to the completed tier when status becomes complete", () => {
    const taskId = createActiveTask();
    rmSync(p.tasksCompleted, { recursive: true, force: true });

    const result = setTaskStatus(taskId, "complete", p.specsTasks);

    expect(result.ok).toBe(true);
    expect(result.updatedPath).toBe(join(p.tasksCompleted, `${taskId}.yaml`));
    expect(existsSync(join(p.tasksActive, `${taskId}.yaml`))).toBe(false);
    expect(existsSync(join(p.tasksCompleted, `${taskId}.yaml`))).toBe(true);
    expect(readFileSync(join(p.tasksCompleted, `${taskId}.yaml`), "utf-8")).toContain("status: complete");
  });

  it("moves a task to the archived tier when status becomes archived", () => {
    const taskId = createActiveTask();

    const result = setTaskStatus(taskId, "archived", p.specsTasks);

    expect(result.ok).toBe(true);
    expect(existsSync(join(p.tasksActive, `${taskId}.yaml`))).toBe(false);
    expect(existsSync(join(p.tasksArchived, `${taskId}.yaml`))).toBe(true);
  });

  it("returns an invalid_status error for an unknown status", () => {
    const taskId = createActiveTask();

    const result = setTaskStatus(taskId, "complete-ish" as never, p.specsTasks);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_status");
    expect(result.message).toContain('Invalid status: "complete-ish"');
  });

  it("returns a task_not_found error for a missing task", () => {
    const result = setTaskStatus("missing-task", "in_progress", p.specsTasks);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("task_not_found");
    expect(result.message).toContain("Task not found: missing-task");
  });

  it("returns a duplicate error when the destination tier already has the task", () => {
    const taskId = createActiveTask();
    writeTierCopy(taskId, "completed", "complete");

    const result = setTaskStatus(taskId, "complete", p.specsTasks);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("duplicate_in_destination_tier");
    expect(result.message).toBe(`Task ${taskId} already exists in completed tasks.`);
    expect(existsSync(join(p.tasksActive, `${taskId}.yaml`))).toBe(true);
  });
});

describe("lifecycle service: completeTask", () => {
  it("completes an active task and moves it to the completed directory", () => {
    const taskId = createActiveTask();
    rmSync(p.tasksCompleted, { recursive: true, force: true });

    const result = completeTask(taskId, {
      specsTasksDir: p.specsTasks,
      completedDir: p.tasksCompleted,
      controlRepo: cwd,
      worktreesDir: p.worktrees,
    });

    expect(result.ok).toBe(true);
    expect(result.newStatus).toBe("complete");
    expect(result.updatedPath).toBe(join(p.tasksCompleted, `${taskId}.yaml`));
    expect(existsSync(join(p.tasksActive, `${taskId}.yaml`))).toBe(false);
    expect(existsSync(join(p.tasksCompleted, `${taskId}.yaml`))).toBe(true);
  });

  it("returns not_in_active when the task is missing", () => {
    const result = completeTask("missing-task", {
      specsTasksDir: p.specsTasks,
      completedDir: p.tasksCompleted,
      controlRepo: cwd,
      worktreesDir: p.worktrees,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_in_active");
    expect(result.message).toBe("Task missing-task not found in active tasks.");
  });

  it("returns a duplicate error without overwriting an existing completed task", () => {
    const taskId = createActiveTask();
    writeTierCopy(taskId, "completed", "complete");

    const result = completeTask(taskId, {
      specsTasksDir: p.specsTasks,
      completedDir: p.tasksCompleted,
      controlRepo: cwd,
      worktreesDir: p.worktrees,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("duplicate_in_destination_tier");
    expect(result.message).toBe(`Task ${taskId} already exists in completed. Use manciple reopen first.`);
  });
});

describe("lifecycle service: archiveTask", () => {
  it("archives an active task and moves it to the archived directory", () => {
    const taskId = createActiveTask();

    const result = archiveTask(taskId, {
      specsTasksDir: p.specsTasks,
      archivedDir: p.tasksArchived,
    });

    expect(result.ok).toBe(true);
    expect(result.newStatus).toBe("archived");
    expect(existsSync(join(p.tasksActive, `${taskId}.yaml`))).toBe(false);
    expect(existsSync(join(p.tasksArchived, `${taskId}.yaml`))).toBe(true);
  });

  it("returns not_in_active when the task is missing", () => {
    const result = archiveTask("missing-task", {
      specsTasksDir: p.specsTasks,
      archivedDir: p.tasksArchived,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_in_active");
    expect(result.message).toBe("Task missing-task not found in active tasks.");
  });
});

describe("lifecycle service: setTaskStatusWithLifecycle", () => {
  it("transitions a status without claim sync in a non-git repo", () => {
    const taskId = createActiveTask();

    const result = setTaskStatusWithLifecycle(taskId, "in_progress", {
      specsTasksDir: p.specsTasks,
      controlRepo: cwd,
      worktreesDir: p.worktrees,
    });

    expect(result.ok).toBe(true);
    expect(readStatus(taskId)).toBe("in_progress");
  });

  it("allows direct completion when no managed worktree exists", () => {
    initGitRepo();
    const taskId = createActiveTask();

    const result = setTaskStatusWithLifecycle(taskId, "complete", {
      specsTasksDir: p.specsTasks,
      controlRepo: cwd,
      worktreesDir: p.worktrees,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(p.tasksCompleted, `${taskId}.yaml`))).toBe(true);
  });

  it("blocks direct completion for a managed worktree", () => {
    initGitRepo();
    const taskId = createActiveTask();
    writeWorktreeRecord(taskId);

    const result = setTaskStatusWithLifecycle(taskId, "complete", {
      specsTasksDir: p.specsTasks,
      controlRepo: cwd,
      worktreesDir: p.worktrees,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("direct_completion_blocked");
    expect(result.message).toContain("must be approved");
    expect(existsSync(join(p.tasksActive, `${taskId}.yaml`))).toBe(true);
  });

  it("sets claim state review_ready for needs_review in a managed worktree", () => {
    initGitRepo();
    const taskId = createActiveTask();
    writeWorktreeRecord(taskId, "assigned");

    const result = setTaskStatusWithLifecycle(taskId, "needs_review", {
      specsTasksDir: p.specsTasks,
      controlRepo: cwd,
      worktreesDir: p.worktrees,
    });

    expect(result.ok).toBe(true);
    expect(readStatus(taskId)).toBe("needs_review");
    expect(readClaimState(taskId)).toBe("review_ready");
  });

  it("sets claim state available for in_progress in a managed worktree", () => {
    initGitRepo();
    const taskId = createActiveTask();
    writeWorktreeRecord(taskId, "assigned");

    const result = setTaskStatusWithLifecycle(taskId, "in_progress", {
      specsTasksDir: p.specsTasks,
      controlRepo: cwd,
      worktreesDir: p.worktrees,
    });

    expect(result.ok).toBe(true);
    expect(readClaimState(taskId)).toBe("available");
  });
});
