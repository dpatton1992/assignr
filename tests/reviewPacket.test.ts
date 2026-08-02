import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { stringify } from "yaml";

import { initCommand } from "../src/commands/init.js";
import { completeCommand } from "../src/commands/complete.js";
import { runLogCommand } from "../src/commands/runLog.js";
import { getPaths } from "../src/utils/paths.js";
import {
  getReviewQueue,
  getScopeDrift,
  getTaskReviewPacket,
  ReviewPacketError,
} from "../src/review/reviewPacket.js";
import type { TaskSpec } from "../src/specs/schema.js";

let cwd: string;
let p: ReturnType<typeof getPaths>;

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-review-packet-"));
  p = getPaths(cwd, ".manciple");
  await initCommand({ force: false, cwd, root: ".manciple" });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writeTask(id: string, overrides: Partial<TaskSpec> = {}): void {
  const task: TaskSpec = {
    id,
    title: id,
    status: "needs_review",
    type: "implementation",
    domain: "core",
    priority: "medium",
    depends_on: [],
    allowed_paths: ["src/review/readiness.ts", "tests/reviewReadiness.test.ts"],
    forbidden_paths: ["dist/"],
    goal: "Assemble a review packet for presentation clients.",
    acceptance_criteria: ["Review packet is fully assembled."],
    verification: {
      commands: ["pnpm build", "pnpm test"],
    },
    outputs_required: ["files_changed", "tests_run", "decisions_made", "risks", "follow_ups"],
    notes: [],
    ...overrides,
  };

  mkdirSync(p.tasksActive, { recursive: true });
  writeFileSync(join(p.tasksActive, `${id}.yaml`), stringify(task, { lineWidth: 0 }), "utf-8");
}

function writeGeneratedPrompts(taskId: string): void {
  mkdirSync(p.promptsGenerated, { recursive: true });
  writeFileSync(join(p.promptsGenerated, `${taskId}.md`), "implementation prompt", "utf-8");
  writeFileSync(join(p.promptsGenerated, `review-${taskId}.md`), "review prompt", "utf-8");
}

function writeCompleteRunLog(taskId: string): void {
  runLogCommand(taskId, p.specsTasks, p.runs, p.promptsGenerated, cwd, {
    result: "complete",
    commandsRun: ["pnpm build", "pnpm test"],
    testsRun: ["pnpm build", "pnpm test"],
    filesChanged: ["src/review/readiness.ts", "tests/reviewReadiness.test.ts"],
    decisionsMade: ["Packet assembly delegates to existing review modules."],
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

function createCompletePacket(taskId: string): ReturnType<typeof getTaskReviewPacket> {
  writeTask(taskId);
  writeCompleteRunLog(taskId);
  writeGeneratedPrompts(taskId);
  return getTaskReviewPacket(taskId, { specsTasksDir: p.specsTasks, cwd });
}

function createCompletedTask(id: string): void {
  writeTask(id, { status: "pending" });
  completeCommand(id, {
    specsTasksDir: p.specsTasks,
    completedDir: p.tasksCompleted,
    cwd,
  });
}

function gitInitAndCommitBaseline(): void {
  const init = spawnSync("git", ["init", "-q"], { cwd, encoding: "utf8" });
  expect(init.status).toBe(0);
  const add = spawnSync("git", ["add", "-A"], { cwd, encoding: "utf8" });
  expect(add.status).toBe(0);
  const commit = spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "baseline"],
    { cwd, encoding: "utf8" }
  );
  expect(commit.status).toBe(0);
}

describe("getTaskReviewPacket", () => {
  it("assembles a complete packet for a needs_review task with full run-log evidence", () => {
    const packet = createCompletePacket("complete-review-task");

    expect(packet.taskId).toBe("complete-review-task");
    expect(packet.title).toBe("complete-review-task");
    expect(packet.status).toBe("needs_review");
    expect(packet.tier).toBe("active");
    expect(packet.goal).toBe("Assemble a review packet for presentation clients.");

    expect(packet.claimedScope.allowedPaths).toEqual([
      "src/review/readiness.ts",
      "tests/reviewReadiness.test.ts",
    ]);
    expect(packet.claimedScope.forbiddenPaths).toEqual(["dist/"]);

    expect(packet.changedFilesSource).toBe("run-log");
    expect(packet.changedPaths.map((entry) => entry.path)).toEqual([
      "src/review/readiness.ts",
      "tests/reviewReadiness.test.ts",
    ]);
    expect(packet.changedPaths.every((entry) => entry.source === "run-log")).toBe(true);
    expect(packet.changedPaths.every((entry) => entry.inAllowedPaths)).toBe(true);
    expect(packet.changedPaths.every((entry) => !entry.inForbiddenPaths)).toBe(true);

    expect(packet.scopeDrift.source).toBe("run-log");
    expect(packet.scopeDrift.outOfScopePaths).toEqual([]);
    expect(packet.scopeDrift.forbiddenPaths).toEqual([]);
    expect(packet.scopeDrift.hasDrift).toBe(false);

    expect(packet.acceptanceCriteria).toEqual([
      { criterion: "Review packet is fully assembled.", evidence: "Complete packet tests cover the assembled shape.", covered: true },
    ]);

    expect(packet.verification.requiredCommands).toEqual(["pnpm build", "pnpm test"]);
    expect(packet.verification.hasVerification).toBe(true);
    expect(packet.verification.commandOutcomes).toEqual([
      { command: "pnpm build", status: "passed", detail: "exit code 0" },
      { command: "pnpm test", status: "passed", detail: "exit code 0" },
    ]);
    expect(packet.verification.failedOrMissingChecks).toEqual([]);

    expect(packet.receipt.result).toBe("complete");
    expect(packet.receipt.hasVerificationReceipt).toBe(true);
    expect(packet.receipt.receiptParseError).toBeUndefined();

    expect(packet.workerNotes.decisionsMade).toEqual([
      "Packet assembly delegates to existing review modules.",
    ]);
    expect(packet.workerNotes.risks).toBe("none");

    expect(packet.risks).toEqual([]);
    expect(packet.warnings).toEqual([]);
    expect(packet.blockers).toEqual([]);
    expect(packet.dependencies).toEqual([]);

    expect(packet.diffSummary.changedFileCount).toBe(2);
    expect(packet.diffSummary.source).toBe("run-log");

    expect(packet.availableDecisions.map((decision) => decision.id)).toEqual([
      "approve",
      "request_changes",
      "reject",
      "block",
    ]);
    expect(packet.availableDecisions.every((decision) => decision.enabled)).toBe(true);

    expect(packet.readiness.ready).toBe(true);
    expect(packet.readiness.score).toBe(100);
  });

  it("assembles an incomplete packet when run-log evidence is missing", () => {
    writeTask("incomplete-review-task");
    const packet = getTaskReviewPacket("incomplete-review-task", {
      specsTasksDir: p.specsTasks,
      cwd,
    });

    expect(packet.changedFilesSource).toBe("unavailable");
    expect(packet.changedPaths).toEqual([]);
    expect(packet.scopeDrift.source).toBe("unavailable");
    expect(packet.scopeDrift.hasDrift).toBe(false);
    expect(packet.verification.hasVerification).toBe(false);
    expect(packet.verification.commandOutcomes.map((outcome) => outcome.status)).toEqual([
      "missing",
      "missing",
    ]);
    expect(packet.verification.failedOrMissingChecks.map((check) => check.command).sort()).toEqual([
      "pnpm build",
      "pnpm test",
    ]);
    expect(packet.acceptanceCriteria).toEqual([
      { criterion: "Review packet is fully assembled.", covered: false },
    ]);
    expect(packet.receipt.hasVerificationReceipt).toBe(false);
    expect(packet.workerNotes.decisionsMade).toEqual([]);
    expect(packet.risks).toEqual([]);
    expect(packet.readiness.ready).toBe(false);
    expect(packet.blockers.map((blocker) => blocker.kind)).toContain("missing-run-log");
  });

  it("uses git-status provenance when no run log is present", () => {
    gitInitAndCommitBaseline();
    writeTask("git-provenance-task", {
      allowed_paths: ["src/review/", ".manciple/tasks/active/"],
    });
    mkdirSync(join(cwd, "src/review"), { recursive: true });
    writeFileSync(join(cwd, "src/review", "readiness.ts"), "export const ready = true;\n", "utf-8");
    mkdirSync(join(cwd, "dist"), { recursive: true });
    writeFileSync(join(cwd, "dist", "bundle.js"), "console.log(1);\n", "utf-8");

    const packet = getTaskReviewPacket("git-provenance-task", {
      specsTasksDir: p.specsTasks,
      cwd,
    });

    expect(packet.changedFilesSource).toBe("git-status");
    expect(packet.changedPaths.every((entry) => entry.source === "git-status")).toBe(true);
    expect(packet.changedPaths.map((entry) => entry.path)).toEqual([
      ".manciple/tasks/active/git-provenance-task.yaml",
      "dist/bundle.js",
      "src/review/readiness.ts",
    ]);

    const inScope = packet.changedPaths.find((entry) => entry.path === "src/review/readiness.ts");
    expect(inScope?.inAllowedPaths).toBe(true);
    expect(inScope?.inForbiddenPaths).toBe(false);

    const forbidden = packet.changedPaths.find((entry) => entry.path === "dist/bundle.js");
    expect(forbidden?.inForbiddenPaths).toBe(true);
    expect(forbidden?.forbiddenPattern).toBe("dist/");

    expect(packet.scopeDrift.source).toBe("git-status");
    expect(packet.scopeDrift.outOfScopePaths).toEqual([]);
    expect(packet.scopeDrift.forbiddenPaths).toEqual([{ path: "dist/bundle.js", pattern: "dist/" }]);
    expect(packet.scopeDrift.hasDrift).toBe(true);
  });

  it("reports out-of-scope and forbidden-path scope drift from a run log", () => {
    writeTask("drift-task");
    runLogCommand("drift-task", p.specsTasks, p.runs, p.promptsGenerated, cwd, {
      result: "complete",
      filesChanged: ["src/review/readiness.ts", "README.md", "dist/bundle.js"],
      commandsRun: ["pnpm build", "pnpm test"],
      testsRun: ["pnpm build", "pnpm test"],
      decisionsMade: ["Recorded drift."],
      risks: "none",
      followUps: ["none"],
    });

    const packet = getTaskReviewPacket("drift-task", { specsTasksDir: p.specsTasks, cwd });

    expect(packet.changedFilesSource).toBe("run-log");
    expect(packet.scopeDrift.outOfScopePaths).toEqual(["README.md"]);
    expect(packet.scopeDrift.forbiddenPaths).toEqual([{ path: "dist/bundle.js", pattern: "dist/" }]);
    expect(packet.scopeDrift.hasDrift).toBe(true);

    const readme = packet.changedPaths.find((entry) => entry.path === "README.md");
    expect(readme?.inAllowedPaths).toBe(false);
  });

  it("includes dependency status context", () => {
    createCompletedTask("dep-complete");
    writeTask("dependent-task", {
      depends_on: ["dep-complete", "dep-missing"],
    });

    const packet = getTaskReviewPacket("dependent-task", { specsTasksDir: p.specsTasks, cwd });

    expect(packet.dependencies).toEqual([
      { taskId: "dep-complete", status: "complete", complete: true },
      { taskId: "dep-missing", status: "missing", complete: false },
    ]);
  });

  it("distinguishes failed and missing verification checks", () => {
    writeTask("check-failed");
    runLogCommand("check-failed", p.specsTasks, p.runs, p.promptsGenerated, cwd, {
      result: "partial",
      filesChanged: ["src/review/readiness.ts"],
      commandsRun: ["pnpm build", "pnpm test"],
      testsRun: ["pnpm build"],
      decisionsMade: ["Recorded a failing verification result."],
      risks: "none",
      followUps: ["Fix the failing test."],
      verifyReceipt: JSON.stringify({
        ok: false,
        commands_run: [
          { command: "pnpm build", ok: true },
          { command: "pnpm test", ok: false },
        ],
      }),
    });

    const failedPacket = getTaskReviewPacket("check-failed", { specsTasksDir: p.specsTasks, cwd });
    const failedOutcomes = Object.fromEntries(
      failedPacket.verification.commandOutcomes.map((outcome) => [outcome.command, outcome.status])
    );
    expect(failedOutcomes["pnpm build"]).toBe("passed");
    expect(failedOutcomes["pnpm test"]).toBe("failed");
    expect(failedPacket.verification.failedOrMissingChecks.map((check) => check.command)).toEqual([
      "pnpm test",
    ]);
    expect(failedPacket.verification.hasVerification).toBe(false);

    writeTask("check-missing", {
      verification: { commands: ["pnpm build", "pnpm test", "pnpm lint"] },
    });
    runLogCommand("check-missing", p.specsTasks, p.runs, p.promptsGenerated, cwd, {
      result: "complete",
      filesChanged: ["src/review/readiness.ts"],
      commandsRun: ["pnpm build", "pnpm test"],
      testsRun: ["pnpm build", "pnpm test"],
      decisionsMade: ["Recorded tests."],
      risks: "none",
      followUps: ["none"],
    });

    const missingPacket = getTaskReviewPacket("check-missing", { specsTasksDir: p.specsTasks, cwd });
    const missingOutcomes = Object.fromEntries(
      missingPacket.verification.commandOutcomes.map((outcome) => [outcome.command, outcome.status])
    );
    expect(missingOutcomes["pnpm build"]).toBe("skipped");
    expect(missingOutcomes["pnpm lint"]).toBe("missing");
    expect(missingPacket.verification.failedOrMissingChecks.map((check) => check.command)).toEqual([
      "pnpm lint",
    ]);
  });

  it("keeps the packet JSON-safe with repo-relative paths", () => {
    const packet = createCompletePacket("json-safe-task");

    expect(() => JSON.stringify(packet)).not.toThrow();
    expect(JSON.stringify(packet)).not.toContain(cwd);
    for (const changedPath of packet.changedPaths) {
      expect(changedPath.path.startsWith("/")).toBe(false);
      expect(changedPath.path.startsWith(cwd)).toBe(false);
    }
  });

  it("orders packet contents deterministically", () => {
    const first = createCompletePacket("deterministic-task");
    const second = createCompletePacket("deterministic-task");

    expect(second).toEqual(first);
    expect(first.changedPaths.map((entry) => entry.path)).toEqual(
      [...first.changedPaths.map((entry) => entry.path)].sort()
    );
  });

  it("throws for an unknown task id", () => {
    expect(() => getTaskReviewPacket("missing-task", { specsTasksDir: p.specsTasks, cwd })).toThrow(
      ReviewPacketError
    );
    expect(() => getTaskReviewPacket("missing-task", { specsTasksDir: p.specsTasks, cwd })).toThrow(
      "Task not found: missing-task"
    );
  });
});

describe("getReviewQueue", () => {
  it("returns stable summary rows and counts for needs_review, blocked, and completed tasks", () => {
    writeTask("alpha-review");
    writeTask("beta-review");
    writeTask("blocked-task", { status: "blocked" });
    createCompletedTask("done-task");

    const summary = getReviewQueue({ specsTasksDir: p.specsTasks, cwd });

    expect(summary.needsReview.count).toBe(2);
    expect(summary.needsReview.rows.map((row) => row.taskId)).toEqual(["alpha-review", "beta-review"]);
    expect(summary.needsReview.rows[0]).toMatchObject({
      title: "alpha-review",
      status: "needs_review",
      tier: "active",
      domain: "core",
      priority: "medium",
    });

    expect(summary.blocked.count).toBe(1);
    expect(summary.blocked.rows[0]).toMatchObject({
      taskId: "blocked-task",
      status: "blocked",
      tier: "active",
    });

    expect(summary.completed.count).toBe(1);
    expect(summary.completed.rows[0]).toMatchObject({
      taskId: "done-task",
      status: "complete",
      tier: "completed",
    });

    expect(summary.total).toBe(4);
  });

  it("is deterministic across calls", () => {
    writeTask("zeta-review");
    writeTask("alpha-review");

    const first = getReviewQueue({ specsTasksDir: p.specsTasks, cwd });
    const second = getReviewQueue({ specsTasksDir: p.specsTasks, cwd });

    expect(second).toEqual(first);
    expect(first.needsReview.rows.map((row) => row.taskId)).toEqual(["alpha-review", "zeta-review"]);
  });
});

describe("getScopeDrift", () => {
  it("returns a standalone drift report", () => {
    writeTask("drift-task");
    runLogCommand("drift-task", p.specsTasks, p.runs, p.promptsGenerated, cwd, {
      result: "complete",
      filesChanged: ["src/review/readiness.ts", "README.md", "dist/bundle.js"],
      commandsRun: ["pnpm build", "pnpm test"],
      testsRun: ["pnpm build", "pnpm test"],
      decisionsMade: ["Recorded drift."],
      risks: "none",
      followUps: ["none"],
    });

    const drift = getScopeDrift("drift-task", { specsTasksDir: p.specsTasks, cwd });

    expect(drift.taskId).toBe("drift-task");
    expect(drift.source).toBe("run-log");
    expect(drift.changedPaths).toEqual(["README.md", "dist/bundle.js", "src/review/readiness.ts"]);
    expect(drift.outOfScopePaths).toEqual(["README.md"]);
    expect(drift.forbiddenPaths).toEqual([{ path: "dist/bundle.js", pattern: "dist/" }]);
    expect(drift.declaredAllowedPatterns).toEqual([
      "src/review/readiness.ts",
      "tests/reviewReadiness.test.ts",
    ]);
    expect(drift.declaredForbiddenPatterns).toEqual(["dist/"]);
    expect(drift.hasDrift).toBe(true);
  });
});
