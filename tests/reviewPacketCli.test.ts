import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { completeCommand } from "../src/commands/complete.js";
import { initCommand } from "../src/commands/init.js";
import { newCommand } from "../src/commands/new.js";
import { runLogCommand } from "../src/commands/runLog.js";
import { setStatusCommand } from "../src/commands/setStatus.js";
import { getReviewQueue, getTaskReviewPacket } from "../src/review/reviewPacket.js";
import type { TaskSpec } from "../src/specs/schema.js";
import { getPaths } from "../src/utils/paths.js";

let cwd: string;
let p: ReturnType<typeof getPaths>;

function runCli(args: string[]) {
  const tsxBin = join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );
  return spawnSync(tsxBin, [join(process.cwd(), "src", "cli.ts"), ...args], {
    cwd,
    encoding: "utf-8",
  });
}

function slugTitleFromId(id: string): string {
  return id.replaceAll("-", " ");
}

function createTaskInReview(id: string): void {
  newCommand(slugTitleFromId(id), {
    type: "implementation",
    domain: "core",
    priority: "high",
    cwd,
    activeDir: p.tasksActive,
  });
  setStatusCommand(id, "needs_review", p.specsTasks, cwd);
  runLogCommand(id, p.specsTasks, p.runs, p.promptsGenerated, cwd, {
    result: "complete",
    commandsRun: ["pnpm build", "pnpm test"],
    testsRun: ["pnpm build", "pnpm test"],
    filesChanged: ["src/review/readiness.ts"],
    decisionsMade: ["Assembled the review packet via the shared service."],
    risks: "none",
    followUps: ["none"],
    acceptanceCriteriaEvidence: [
      "Review packet is fully assembled.: Complete packet tests cover the assembled shape.",
    ],
    verifyReceipt: JSON.stringify({
      ok: true,
      commands_run: [
        { command: "pnpm build", ok: true, exit_code: 0 },
        { command: "pnpm test", ok: true, exit_code: 0 },
      ],
    }),
  });
}

function createCompletedTask(id: string): void {
  newCommand(slugTitleFromId(id), {
    type: "implementation",
    domain: "core",
    priority: "medium",
    cwd,
    activeDir: p.tasksActive,
  });
  completeCommand(id, {
    specsTasksDir: p.specsTasks,
    completedDir: p.tasksCompleted,
    cwd,
  });
}

// Raw YAML fixture writes are test setup only; the CLI adapters under test
// never read task YAML directly and must not require adapter-level reads.
function writeRawTask(id: string, overrides: Partial<TaskSpec> = {}): void {
  const task: TaskSpec = {
    id,
    title: id,
    status: "needs_review",
    type: "implementation",
    domain: "core",
    priority: "medium",
    depends_on: [],
    blocks: [],
    conflicts_with: [],
    can_run_independently: true,
    path_ownership: {
      touched_paths: [],
      locked_paths: [],
      unsafe_parallel_areas: [],
    },
    allowed_paths: ["src/**"],
    forbidden_paths: [],
    goal: "Contract fixture task.",
    acceptance_criteria: ["It assembles."],
    verification: { commands: ["pnpm test"] },
    outputs_required: ["files_changed"],
    notes: [],
    ...overrides,
  };
  mkdirSync(p.tasksActive, { recursive: true });
  writeFileSync(join(p.tasksActive, `${id}.yaml`), stringify(task, { lineWidth: 0 }), "utf-8");
}

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-review-packet-cli-"));
  p = getPaths(cwd, ".manciple");
  await initCommand({ force: false, cwd, root: ".manciple" });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("review queue --json (CLI contract)", () => {
  it("prints the assembled review queue as stable JSON on stdout", () => {
    createTaskInReview("alpha-review");
    createTaskInReview("beta-review");
    createCompletedTask("done-task");

    const result = runCli(["review", "queue", "--json"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual(getReviewQueue({ specsTasksDir: p.specsTasks, cwd }));
    expect(parsed.needsReview.count).toBe(2);
    expect(parsed.needsReview.rows.map((row: { taskId: string }) => row.taskId).sort()).toEqual([
      "alpha-review",
      "beta-review",
    ]);
    expect(parsed.blocked.count).toBe(0);
    expect(parsed.completed.count).toBe(1);
    expect(parsed.total).toBe(3);
    expect(result.stderr).toBe("");
  });

  it("includes blocked tasks in the queue JSON", () => {
    writeRawTask("blocked-task", { status: "blocked" });

    const result = runCli(["review", "queue", "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.blocked.rows.map((row: { taskId: string }) => row.taskId)).toEqual([
      "blocked-task",
    ]);
    expect(parsed.blocked.rows[0].status).toBe("blocked");
  });

  it("emits no ANSI styling in JSON output", () => {
    createTaskInReview("no-ansi-task");

    const result = runCli(["review", "queue", "--json"]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("\u001b[");
    expect(JSON.parse(result.stdout)).toBeTruthy();
  });

  it("rejects an invalid mode with a nonzero exit even in JSON mode", () => {
    const result = runCli(["review", "queue", "--json", "--mode", "bogus"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unsupported review queue mode: bogus");
    expect(result.stdout).toBe("");
  });

  it("keeps the human-facing queue command backwards compatible without --json", () => {
    createTaskInReview("human-queue-task");

    const result = runCli(["review", "queue"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("human-queue-task");
    // Human output is not the machine-readable JSON shape.
    expect(() => JSON.parse(result.stdout)).toThrow();
  });
});

describe("review packet <task-id> --json (CLI contract)", () => {
  it("prints the assembled ReviewPacket as stable JSON identical to the application layer", () => {
    createTaskInReview("packet-task");

    const result = runCli(["review", "packet", "packet-task", "--json"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual(
      getTaskReviewPacket("packet-task", {
        specsTasksDir: p.specsTasks,
        cwd,
        generatedDir: p.promptsGenerated,
        activeDir: p.tasksActive,
        completedDir: p.tasksCompleted,
        archivedDir: p.tasksArchived,
      }),
    );
    expect(parsed.taskId).toBe("packet-task");
    expect(parsed.status).toBe("needs_review");
    expect(parsed.changedFilesSource).toBe("run-log");
    expect(parsed.acceptanceCriteria[0].criterion).toBe("TODO: add acceptance criteria");
    expect(parsed.availableDecisions.map((d: { id: string }) => d.id)).toEqual([
      "approve",
      "request_changes",
      "reject",
      "block",
    ]);
    expect(result.stderr).toBe("");
  });

  it("emits no ANSI styling in packet JSON", () => {
    createTaskInReview("no-ansi-packet");

    const result = runCli(["review", "packet", "no-ansi-packet", "--json"]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("\u001b[");
    expect(JSON.parse(result.stdout).taskId).toBe("no-ansi-packet");
  });

  it("exits nonzero with a clear error for an absent task", () => {
    const result = runCli(["review", "packet", "missing-task", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Task not found: missing-task");
  });

  it("prints a human summary without --json", () => {
    createTaskInReview("summary-task");

    const result = runCli(["review", "packet", "summary-task"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Review packet: summary-task");
    expect(() => JSON.parse(result.stdout)).toThrow();
  });
});

describe("review outcome commands remain backwards compatible", () => {
  it("approve, changes, and block subcommands still record outcomes", () => {
    createTaskInReview("compat-task");

    const approve = runCli(["review", "approve", "compat-task"]);
    expect(approve.status).toBe(0);
    expect(existsSync(join(p.tasksCompleted, "compat-task.yaml"))).toBe(true);

    createTaskInReview("compat-changes");
    const changes = runCli([
      "review",
      "changes",
      "compat-changes",
      "--reason",
      "Needs more tests.",
    ]);
    expect(changes.status).toBe(0);
    expect(JSON.parse(runCli(["review", "packet", "compat-changes", "--json"]).stdout).status).toBe(
      "in_progress",
    );

    createTaskInReview("compat-block");
    const block = runCli([
      "review",
      "block",
      "compat-block",
      "--reason",
      "Environment unavailable.",
    ]);
    expect(block.status).toBe(0);
    expect(JSON.parse(runCli(["review", "packet", "compat-block", "--json"]).stdout).status).toBe(
      "blocked",
    );
  });
});
