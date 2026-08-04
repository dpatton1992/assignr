import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { runLogCommand } from "../src/commands/runLog.js";
import { setStatusCommand } from "../src/commands/setStatus.js";
import { worktreeCommand } from "../src/commands/worktree.js";
import { approveTask } from "../src/review/reviewActions.js";
import { getPaths } from "../src/utils/paths.js";
import { getManagedWorktree } from "../src/worktrees/manager.js";

let cwd: string;
let p: ReturnType<typeof getPaths>;
const taskId = "managed-feature";
const criterion = "The managed feature is present.";
const projectRoot = process.cwd();

function git(args: string[], repo: string = cwd): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();
}

function writeTask(verification = "test -f feature.txt"): void {
  mkdirSync(p.tasksActive, { recursive: true });
  writeFileSync(
    join(p.tasksActive, `${taskId}.yaml`),
    `id: ${taskId}
title: Managed feature
status: pending
type: implementation
domain: core
priority: high
depends_on: []
blocks: []
conflicts_with: []
can_run_independently: true
allowed_paths:
  - feature.txt
forbidden_paths: []
path_ownership:
  touched_paths: []
  locked_paths: []
  unsafe_parallel_areas: []
goal: Add a feature through a managed worktree.
acceptance_criteria:
  - ${criterion}
verification:
  commands:
    - ${verification}
outputs_required:
  - files_changed
  - tests_run
  - risks
notes: []
`,
    "utf-8",
  );
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-integration-"));
  p = getPaths(cwd, ".manciple");
  git(["init", "-b", "main"]);
  git(["config", "user.email", "tests@example.com"]);
  git(["config", "user.name", "Manciple Tests"]);
  mkdirSync(p.promptsGenerated, { recursive: true });
  mkdirSync(p.runs, { recursive: true });
  writeFileSync(p.config, "root: .manciple\nworktrees:\n  enabled: true\n", "utf-8");
  writeTask();
  writeFileSync(join(cwd, "tracked.txt"), "base\n", "utf-8");
  writeFileSync(join(p.promptsGenerated, `${taskId}.md`), "implementation prompt\n", "utf-8");
  writeFileSync(join(p.promptsGenerated, `review-${taskId}.md`), "review prompt\n", "utf-8");
  git(["add", "."]);
  git(["commit", "-m", "initial task"]);
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function submit(workspacePath: string, verification = "test -f feature.txt"): void {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    runLogCommand(taskId, p.specsTasks, p.runs, p.promptsGenerated, workspacePath, {
      result: "complete",
      taskStatus: "needs_review",
      filesChanged: ["feature.txt"],
      testsRun: [`${verification}: passed`],
      acceptanceCriteriaEvidence: [`${criterion} => feature.txt exists in the task worktree.`],
      verifyReceipt: JSON.stringify({
        ok: true,
        commands_run: [{ command: verification, ok: true, exit_code: 0 }],
      }),
      risks: "none",
    });
    setStatusCommand(taskId, "needs_review", p.specsTasks, cwd);
  } finally {
    logSpy.mockRestore();
  }
}

function runCli(args: string[]) {
  return spawnSync(
    join(projectRoot, "node_modules", ".bin", "tsx"),
    [join(projectRoot, "src", "cli.ts"), ...args],
    { cwd, encoding: "utf-8" },
  );
}

function prepareMixedEvidence(): string {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  let workspacePath: string;
  try {
    workspacePath = worktreeCommand(taskId, {
      cwd,
      worktreesDir: p.worktrees,
      specsTasksDir: p.specsTasks,
    }).workspacePath;
  } finally {
    logSpy.mockRestore();
  }
  writeFileSync(join(workspacePath, "committed.txt"), "committed\n", "utf-8");
  git(["add", "committed.txt"], workspacePath);
  git(["commit", "-m", "committed evidence"], workspacePath);
  writeFileSync(join(workspacePath, "staged.txt"), "staged\n", "utf-8");
  git(["add", "staged.txt"], workspacePath);
  writeFileSync(join(workspacePath, "tracked.txt"), "unstaged\n", "utf-8");
  writeFileSync(join(workspacePath, "untracked.txt"), "untracked\n", "utf-8");
  return workspacePath;
}

describe("managed worktree approval", () => {
  it.each([
    [
      "run-log",
      (workspacePath: string) => [
        "run-log",
        taskId,
        "--workspace",
        workspacePath,
        "--result",
        "complete",
      ],
    ],
    [
      "submit",
      (workspacePath: string) => [
        "submit",
        taskId,
        "--workspace",
        workspacePath,
        "--result",
        "complete",
      ],
    ],
  ])("captures mixed managed-worktree evidence through CLI %s", (_label, argsFor) => {
    const workspacePath = prepareMixedEvidence();

    const result = runCli(argsFor(workspacePath));

    expect(result.status, result.stderr).toBe(0);
    const latest = readdirSync(p.runs)
      .filter((file) => file.endsWith(`-${taskId}.md`))
      .sort()
      .at(-1);
    expect(latest).toBeDefined();
    const content = readFileSync(join(p.runs, latest ?? ""), "utf-8");
    expect(content).toContain(`_Source: auto-detected from managed worktree diff since `);
    expect(content).toContain("- committed.txt");
    expect(content).toContain("- staged.txt");
    expect(content).toContain("- tracked.txt");
    expect(content).toContain("- untracked.txt");
    expect(existsSync(join(workspacePath, ".manciple", "runs", latest ?? ""))).toBe(false);
  });

  it("rejects an unregistered CLI evidence workspace", () => {
    prepareMixedEvidence();

    const result = runCli(["run-log", taskId, "--workspace", cwd, "--result", "complete"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Workspace is not the managed worktree for task ${taskId}`);
  });

  it("reviews, verifies, no-ff merges, completes, and cleans up transactionally", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let workspacePath: string;
    try {
      workspacePath = worktreeCommand(taskId, {
        cwd,
        worktreesDir: p.worktrees,
        specsTasksDir: p.specsTasks,
      }).workspacePath;
    } finally {
      logSpy.mockRestore();
    }
    writeFileSync(join(workspacePath, "feature.txt"), "managed feature\n", "utf-8");
    submit(workspacePath);

    const result = approveTask(taskId, {
      specsTasksDir: p.specsTasks,
      cwd,
      runsDir: p.runs,
      completedDir: p.tasksCompleted,
      activeDir: p.tasksActive,
      archivedDir: p.tasksArchived,
    });

    expect(result.integration).toMatchObject({ managed: true, branch: `manciple/${taskId}` });
    expect(result.cleanupWarnings).toBeUndefined();
    expect(readFileSync(join(cwd, "feature.txt"), "utf-8")).toBe("managed feature\n");
    expect(existsSync(workspacePath)).toBe(false);
    expect(git(["branch", "--list", `manciple/${taskId}`])).toBe("");
    expect(git(["log", "-1", "--pretty=%s"])).toBe(`manciple: integrate ${taskId}`);
    expect(parse(readFileSync(join(p.tasksCompleted, `${taskId}.yaml`), "utf-8"))).toMatchObject({
      status: "complete",
    });
    expect(
      getManagedWorktree(taskId, { controlRepo: cwd, worktreesDir: p.worktrees }),
    ).toBeUndefined();
  });

  it("leaves primary untouched and retains review state when prospective verification fails", () => {
    const failingCommand = "test ! -f feature.txt";
    writeTask(failingCommand);
    git(["add", join(p.tasksActive, `${taskId}.yaml`)]);
    git(["commit", "-m", "change verification"]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let workspacePath: string;
    try {
      workspacePath = worktreeCommand(taskId, {
        cwd,
        worktreesDir: p.worktrees,
        specsTasksDir: p.specsTasks,
      }).workspacePath;
    } finally {
      logSpy.mockRestore();
    }
    writeFileSync(join(workspacePath, "feature.txt"), "managed feature\n", "utf-8");
    submit(workspacePath, failingCommand);

    expect(() =>
      approveTask(taskId, {
        specsTasksDir: p.specsTasks,
        cwd,
        runsDir: p.runs,
        completedDir: p.tasksCompleted,
        activeDir: p.tasksActive,
        archivedDir: p.tasksArchived,
      }),
    ).toThrow("Integration verification failed");

    expect(existsSync(join(cwd, "feature.txt"))).toBe(false);
    expect(existsSync(workspacePath)).toBe(true);
    const task = parse(readFileSync(join(p.tasksActive, `${taskId}.yaml`), "utf-8"));
    expect(task.status).toBe("needs_review");
    expect(
      getManagedWorktree(taskId, { controlRepo: cwd, worktreesDir: p.worktrees })?.claimState,
    ).toBe("review_ready");
  });
});
