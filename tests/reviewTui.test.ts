import { EventEmitter } from "node:events";
import { render as inkRender } from "ink";
import { cleanup as inkTestingCleanup, render as inkTestRender } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewReadinessReport } from "../src/review/readiness.js";
import type { ReviewActionOutcome } from "../src/review/reviewActions.js";
import type {
  ReviewDecisionId,
  ReviewPacket,
  ReviewQueueRow,
  ReviewQueueSummary,
} from "../src/review/reviewPacket.js";
import type { TaskTier } from "../src/specs/loadTasks.js";
import type { ReviewTuiSession } from "../src/tui/app.js";
import { ReviewTui } from "../src/tui/app.js";
import type { CommandRunner } from "../src/tui/pager.js";
import { buildDiffContent, openInPager, resolvePagerCommand } from "../src/tui/pager.js";
import type { ReviewService } from "../src/tui/service.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

const FAKE_CWD = "/tmp/fake-repo";

function readiness(overrides: Partial<ReviewReadinessReport> = {}): ReviewReadinessReport {
  return {
    taskId: "alpha",
    ready: true,
    score: 80,
    checklist: [],
    humanReviewNeeded: false,
    humanReviewReasons: [],
    hasRunLog: true,
    hasChangedFiles: true,
    changedFiles: ["src/example.ts"],
    changedFilesSource: "run-log",
    overlappingFiles: [],
    hasVerificationCommands: true,
    hasVerificationResults: true,
    hasVerification: true,
    missingVerificationCommands: [],
    failedVerificationCommands: [],
    absentVerificationCommands: [],
    hasRisks: false,
    documentedRisks: [],
    missingReceiptFields: [],
    uncoveredAcceptanceCriteria: [],
    unmappedAcceptanceEvidence: [],
    missingEvidence: [],
    ...overrides,
  };
}

function makePacket(overrides: Partial<ReviewPacket> & { taskId: string }): ReviewPacket {
  const base: ReviewPacket = {
    taskId: overrides.taskId,
    title: "Example task",
    status: "needs_review",
    tier: "active",
    domain: "core",
    priority: "high",
    goal: "Deliver the feature.",
    worktree: { managed: false, workspacePath: ".", dirty: true },
    claimedScope: { allowedPaths: ["src/**"], forbiddenPaths: ["dist/**"] },
    changedFilesSource: "run-log",
    changedPaths: [
      { path: "src/example.ts", source: "run-log", inAllowedPaths: true, inForbiddenPaths: false },
    ],
    scopeDrift: {
      source: "run-log",
      changedPaths: ["src/example.ts"],
      outOfScopePaths: [],
      forbiddenPaths: [],
      declaredAllowedPatterns: ["src/**"],
      declaredForbiddenPatterns: ["dist/**"],
      hasDrift: false,
    },
    acceptanceCriteria: [{ criterion: "It works.", evidence: "Tests pass.", covered: true }],
    verification: {
      requiredCommands: ["pnpm test"],
      commandOutcomes: [{ command: "pnpm test", status: "passed" }],
      failedOrMissingChecks: [],
      hasVerification: true,
    },
    receipt: { result: "complete", hasVerificationReceipt: true, verificationReceipt: "ok: true" },
    workerNotes: { decisionsMade: ["Assembled packet"], followUps: [], risks: "none" },
    risks: [],
    warnings: [],
    blockers: [],
    dependencies: [],
    diffSummary: { changedFileCount: 1, source: "run-log", insertions: 3, deletions: 1 },
    availableDecisions: [
      { id: "approve", label: "Approve and move the task to completed", enabled: true },
      {
        id: "request_changes",
        label: "Request changes and return the task to in_progress",
        enabled: true,
      },
      { id: "reject", label: "Reject the task and move it to failed", enabled: true },
      { id: "block", label: "Block review and set the task to blocked", enabled: true },
    ],
    readiness: readiness({ taskId: overrides.taskId }),
  };
  return { ...base, ...overrides };
}

function row(taskId: string, status = "needs_review", tier: TaskTier = "active"): ReviewQueueRow {
  return { taskId, title: `Task ${taskId}`, status, tier, domain: "core", priority: "medium" };
}

function makeQueue(opts: {
  needsReview?: ReviewQueueRow[];
  blocked?: ReviewQueueRow[];
  completed?: ReviewQueueRow[];
}): ReviewQueueSummary {
  const needsReview = opts.needsReview ?? [];
  const blocked = opts.blocked ?? [];
  const completed = opts.completed ?? [];
  return {
    needsReview: { rows: needsReview, count: needsReview.length },
    blocked: { rows: blocked, count: blocked.length },
    completed: { rows: completed, count: completed.length },
    total: needsReview.length + blocked.length + completed.length,
  };
}

const OUTCOME_MAP: Record<ReviewDecisionId, { outcome: ReviewActionOutcome; nextStatus: string }> =
  {
    approve: { outcome: "approved", nextStatus: "complete" },
    request_changes: { outcome: "changes_requested", nextStatus: "in_progress" },
    reject: { outcome: "rejected", nextStatus: "failed" },
    block: { outcome: "blocked", nextStatus: "blocked" },
    reopen: { outcome: "reopened", nextStatus: "in_progress" },
  };

class FakeReviewService implements ReviewService {
  queue: ReviewQueueSummary;
  packets = new Map<string, ReviewPacket>();
  getQueueCalls = 0;
  getPacketCalls: string[] = [];
  applyDecisionCalls: Array<{ action: ReviewDecisionId; taskId: string; reason?: string }> = [];

  constructor(queue: ReviewQueueSummary, packets: ReviewPacket[]) {
    this.queue = queue;
    for (const packet of packets) this.packets.set(packet.taskId, packet);
  }

  getQueue(): ReviewQueueSummary {
    this.getQueueCalls += 1;
    return this.queue;
  }

  getPacket(taskId: string): ReviewPacket {
    this.getPacketCalls.push(taskId);
    const packet = this.packets.get(taskId);
    if (!packet) throw new Error(`Task not found: ${taskId}`);
    return packet;
  }

  applyDecision(
    action: ReviewDecisionId,
    taskId: string,
    reason?: string,
  ): ReturnType<ReviewService["applyDecision"]> {
    this.applyDecisionCalls.push({ action, taskId, reason });
    const meta = OUTCOME_MAP[action];
    const previousStatus =
      action === "reopen"
        ? "complete"
        : (this.queue.needsReview.rows.find((candidate) => candidate.taskId === taskId)?.status ??
          "needs_review");
    const without = (rows: ReviewQueueRow[]): ReviewQueueRow[] =>
      rows.filter((candidate) => candidate.taskId !== taskId);

    if (action === "approve") {
      const source = this.queue.needsReview.rows.find((candidate) => candidate.taskId === taskId);
      this.queue.needsReview.rows = without(this.queue.needsReview.rows);
      this.queue.needsReview.count = this.queue.needsReview.rows.length;
      if (source) {
        this.queue.completed.rows = [
          ...this.queue.completed.rows,
          { ...source, status: "complete" },
        ];
        this.queue.completed.count = this.queue.completed.rows.length;
      }
    } else if (action === "reopen") {
      this.queue.completed.rows = without(this.queue.completed.rows);
      this.queue.completed.count = this.queue.completed.rows.length;
    } else {
      this.queue.needsReview.rows = without(this.queue.needsReview.rows);
      this.queue.needsReview.count = this.queue.needsReview.rows.length;
    }

    return {
      taskId,
      outcome: meta.outcome,
      previousStatus,
      nextStatus: meta.nextStatus,
      taskPath: `${taskId}.yaml`,
    };
  }
}

function renderTui(
  fake: FakeReviewService,
  options: { session?: ReviewTuiSession; windowHeight?: number; diffRunner?: CommandRunner } = {},
) {
  const onOpenPager = vi.fn();
  const rendered = inkTestRender(
    React.createElement(ReviewTui, {
      service: fake,
      cwd: FAKE_CWD,
      onOpenPager,
      ...(options.session ? { session: options.session } : {}),
      ...(options.windowHeight !== undefined ? { windowHeight: options.windowHeight } : {}),
      ...(options.diffRunner ? { diffRunner: options.diffRunner } : {}),
    }),
  );
  return { ...rendered, onOpenPager };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function press(stdin: { write: (data: string) => void }, keys: string): Promise<void> {
  stdin.write(keys);
  await tick();
}

async function type(stdin: { write: (data: string) => void }, text: string): Promise<void> {
  for (const char of text) {
    stdin.write(char);
    await tick();
  }
}

afterEach(() => {
  inkTestingCleanup();
});

// ── pager.ts unit tests ───────────────────────────────────────────────────

describe("resolvePagerCommand", () => {
  it("splits a configured PAGER into a command and argument array", () => {
    expect(resolvePagerCommand({ PAGER: "less -R -F" })).toEqual({
      command: "less",
      args: ["-R", "-F"],
    });
  });

  it("defaults to less -R when no pager is configured", () => {
    expect(resolvePagerCommand({})).toEqual({ command: "less", args: ["-R"] });
  });
});

describe("buildDiffContent", () => {
  it("scopes git diff arguments to packet changed paths and surfaces untracked paths separately", () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const run: CommandRunner = (command, args, cwd) => {
      calls.push({ command, args, cwd });
      if (args[0] === "status") {
        return { status: 0, stdout: "?? src/new-file.ts\n", stderr: "" };
      }
      return {
        status: 0,
        stdout: "diff --git a/src/example.ts b/src/example.ts\n+added\n-removed\n",
        stderr: "",
      };
    };

    const packet = makePacket({
      taskId: "alpha",
      changedPaths: [
        {
          path: "src/example.ts",
          source: "run-log",
          inAllowedPaths: true,
          inForbiddenPaths: false,
        },
        {
          path: "src/other.ts",
          source: "git-status",
          inAllowedPaths: true,
          inForbiddenPaths: false,
        },
      ],
    });

    const content = buildDiffContent({ packet, cwd: FAKE_CWD, run });

    expect(calls[0].command).toBe("git");
    expect(calls[0].args).toEqual([
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      "src/example.ts",
      "src/other.ts",
    ]);
    expect(calls[1].command).toBe("git");
    expect(calls[1].args).toEqual(["diff", "HEAD", "--", "src/example.ts", "src/other.ts"]);
    expect(calls.every((call) => call.cwd === FAKE_CWD)).toBe(true);
    expect(content).toContain("Untracked paths");
    expect(content).toContain("src/new-file.ts");
    expect(content).toContain("diff --git");
  });

  it("reads managed worktree diffs from the workspace base SHA", () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const run: CommandRunner = (_command, args, cwd) => {
      calls.push({ args, cwd });
      return { status: 0, stdout: args[0] === "diff" ? "managed diff\n" : "", stderr: "" };
    };
    const packet = makePacket({
      taskId: "alpha",
      worktree: {
        managed: true,
        workspacePath: ".manciple/worktrees/alpha",
        baseSha: "abc123",
        dirty: false,
      },
    });

    const content = buildDiffContent({ packet, cwd: FAKE_CWD, run });

    expect(calls).toEqual([
      {
        args: ["status", "--porcelain", "--untracked-files=all", "--", "src/example.ts"],
        cwd: "/tmp/fake-repo/.manciple/worktrees/alpha",
      },
      {
        args: ["diff", "abc123", "--", "src/example.ts"],
        cwd: "/tmp/fake-repo/.manciple/worktrees/alpha",
      },
    ]);
    expect(content).toContain("managed diff");
  });

  it("reports a missing-diff message when git produces no output", () => {
    const run: CommandRunner = () => ({ status: 0, stdout: "", stderr: "" });
    const packet = makePacket({ taskId: "alpha" });
    const content = buildDiffContent({ packet, cwd: FAKE_CWD, run });
    expect(content).toContain("No tracked diff");
  });
});

describe("openInPager", () => {
  it("spawns the pager with content piped to its stdin using an argument array", async () => {
    const spawnPager = vi.fn(async (_command: string, _args: string[], input: string) => {
      expect(input).toContain("long content");
      return 0;
    });
    const stdout = { write: vi.fn() };
    await openInPager("long content", {
      env: { PAGER: "less -R" },
      spawnPager: spawnPager as never,
      stdout: stdout as never,
    });
    expect(spawnPager).toHaveBeenCalledWith("less", ["-R"], "long content");
    expect(stdout.write).not.toHaveBeenCalled();
  });

  it("falls back to inline output when the pager cannot be spawned", async () => {
    const spawnPager = vi.fn(async () => null);
    const stdout = { write: vi.fn() };
    await openInPager("fallback content", {
      env: { PAGER: "missing-pager" },
      spawnPager: spawnPager as never,
      stdout: stdout as never,
    });
    expect(spawnPager).toHaveBeenCalledWith("missing-pager", [], "fallback content");
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("fallback content"));
  });
});

// ── Rendering ─────────────────────────────────────────────────────────────

describe("ReviewTui rendering", () => {
  it("renders responsive queue counts and rows for all three buckets", async () => {
    const fake = new FakeReviewService(
      makeQueue({
        needsReview: [row("alpha"), row("beta")],
        blocked: [row("gamma", "blocked")],
        completed: [row("done", "complete", "completed")],
      }),
      [],
    );
    const { lastFrame } = renderTui(fake);
    await tick();

    const frame = lastFrame();
    expect(frame).toContain("Review Dashboard");
    expect(frame).toContain("Needs review (2)");
    expect(frame).toContain("Blocked (1)");
    expect(frame).toContain("Completed (1)");
    expect(frame).toContain("alpha");
    expect(frame).toContain("beta");
    expect(frame).toContain("gamma");
    expect(frame).toContain("done");
  });

  it("renders an empty state for an empty queue", async () => {
    const fake = new FakeReviewService(makeQueue({}), []);
    const { lastFrame } = renderTui(fake);
    await tick();
    expect(lastFrame()).toContain("No tasks in needs_review, blocked, or completed.");
  });

  it("renders a selected-task summary with drift, evidence, verification, diff stats, risk, metadata, dependencies, and warnings", async () => {
    const packet = makePacket({
      taskId: "alpha",
      scopeDrift: {
        source: "run-log",
        changedPaths: ["src/example.ts", "docs/leak.md"],
        outOfScopePaths: ["docs/leak.md"],
        forbiddenPaths: [{ path: "dist/bundle.js", pattern: "dist/**" }],
        declaredAllowedPatterns: ["src/**"],
        declaredForbiddenPatterns: ["dist/**"],
        hasDrift: true,
      },
      acceptanceCriteria: [
        { criterion: "It works.", evidence: "Tests pass.", covered: true },
        { criterion: "It ships.", evidence: undefined, covered: false },
      ],
      verification: {
        requiredCommands: ["pnpm test", "pnpm build"],
        commandOutcomes: [
          { command: "pnpm test", status: "passed" },
          { command: "pnpm build", status: "missing" },
        ],
        failedOrMissingChecks: [{ command: "pnpm build", status: "missing" }],
        hasVerification: true,
      },
      risks: ["Untested edge case"],
      warnings: ["Run log is stale"],
      dependencies: [{ taskId: "dep-task", status: "in_progress", complete: false }],
      diffSummary: { changedFileCount: 2, source: "run-log", insertions: 12, deletions: 4 },
      receipt: {
        result: "complete",
        hasVerificationReceipt: true,
        verificationReceipt: "verify receipt text",
      },
      workerNotes: {
        decisionsMade: ["Decision A", "Decision B"],
        followUps: ["Follow-up"],
        risks: "none",
      },
    });
    const fake = new FakeReviewService(makeQueue({ needsReview: [row("alpha")] }), [packet]);
    const { lastFrame, stdin } = renderTui(fake, { windowHeight: 40 });
    await tick();
    await press(stdin, "\r");

    const frame = lastFrame();
    expect(frame).toContain("Scope drift:");
    expect(frame).toContain("docs/leak.md");
    expect(frame).toContain("dist/bundle.js");
    expect(frame).toContain("Acceptance: 1/2 covered");
    expect(frame).toContain("Verification: recorded");
    expect(frame).toContain("pnpm build");
    expect(frame).toContain("Changed files: 2 (run-log)");
    expect(frame).toContain("+12");
    expect(frame).toContain("Risks:");
    expect(frame).toContain("Untested edge case");
    expect(frame).toContain("Worker:");
    expect(frame).toContain("decisions 2");
    expect(frame).toContain("Receipt:");
    expect(frame).toContain("Dependencies:");
    expect(frame).toContain("dep-task:in_progress");
    expect(frame).toContain("Warnings:");
    expect(frame).toContain("Run log is stale");
  });
});

// ── Navigation ────────────────────────────────────────────────────────────

describe("ReviewTui navigation", () => {
  function navQueue(): FakeReviewService {
    return new FakeReviewService(
      makeQueue({
        needsReview: [row("alpha"), row("beta")],
        completed: [row("done", "complete", "completed")],
      }),
      [
        makePacket({ taskId: "alpha" }),
        makePacket({ taskId: "beta" }),
        makePacket({ taskId: "done", status: "complete", tier: "completed" }),
      ],
    );
  }

  it("moves selection with j and Enter inspects the selected task", async () => {
    const fake = navQueue();
    const { lastFrame, stdin } = renderTui(fake);
    await tick();

    expect(lastFrame()).toContain("› alpha  Task alpha");

    await press(stdin, "j");
    expect(lastFrame()).toContain("› beta  Task beta");
    expect(lastFrame()).not.toContain("› alpha  Task alpha");

    await press(stdin, "\r");
    expect(lastFrame()).toContain("Reviewing: beta");
    expect(fake.getPacketCalls).toEqual(["beta"]);
  });

  it("moves selection with arrow keys", async () => {
    const fake = navQueue();
    const { lastFrame, stdin } = renderTui(fake);
    await tick();

    await press(stdin, "\u001b[B"); // down
    expect(lastFrame()).toContain("› beta  Task beta");

    await press(stdin, "\u001b[A"); // up
    expect(lastFrame()).toContain("› alpha  Task alpha");
  });

  it("q returns from detail to the list", async () => {
    const fake = navQueue();
    const { lastFrame, stdin } = renderTui(fake);
    await tick();
    await press(stdin, "\r");
    expect(lastFrame()).toContain("Reviewing: alpha");
    await press(stdin, "q");
    expect(lastFrame()).toContain("Review Dashboard");
  });

  it("Escape leaves subviews back toward the list", async () => {
    const fake = navQueue();
    const { lastFrame, stdin } = renderTui(fake);
    await tick();
    await press(stdin, "\r");
    await press(stdin, "t"); // tests view
    expect(lastFrame()).toContain("Tests and commands");
    await press(stdin, "\u001b"); // escape → detail
    expect(lastFrame()).toContain("Reviewing: alpha");
    await press(stdin, "\u001b"); // escape → list
    expect(lastFrame()).toContain("Review Dashboard");
  });

  it("q in the list exits without throwing", async () => {
    const fake = navQueue();
    const { lastFrame, stdin } = renderTui(fake);
    await tick();
    expect(lastFrame()).toContain("Review Dashboard");
    await expect(press(stdin, "q")).resolves.toBeUndefined();
  });

  it("shows a packet loading error and returns to the list", async () => {
    const fake = new FakeReviewService(makeQueue({ needsReview: [row("missing")] }), []);
    const { lastFrame, stdin } = renderTui(fake);
    await tick();
    await press(stdin, "\r");
    expect(lastFrame()).toContain("Task not found: missing");
    await press(stdin, "q");
    expect(lastFrame()).toContain("Review Dashboard");
  });
});

// ── Confirmations and reasons ─────────────────────────────────────────────

describe("ReviewTui confirmations and reasons", () => {
  function detailQueue(): FakeReviewService {
    return new FakeReviewService(
      makeQueue({ needsReview: [row("alpha")], completed: [row("done", "complete", "completed")] }),
      [
        makePacket({ taskId: "alpha" }),
        makePacket({
          taskId: "done",
          status: "complete",
          tier: "completed",
          availableDecisions: [
            { id: "reopen", label: "Reopen the task to in_progress", enabled: true },
          ],
        }),
      ],
    );
  }

  it("shows a confirmation step for approve, and n cancels without mutating", async () => {
    const fake = detailQueue();
    const { lastFrame, stdin } = renderTui(fake);
    await tick();
    await press(stdin, "\r");
    await press(stdin, "a");

    expect(lastFrame()).toContain("Confirm approve");
    expect(lastFrame()).toContain("needs_review to complete");
    expect(fake.applyDecisionCalls).toHaveLength(0);

    await press(stdin, "n");
    expect(lastFrame()).toContain("Reviewing: alpha");
    expect(fake.applyDecisionCalls).toHaveLength(0);
  });

  it("approve confirms with y, applies the decision, refreshes the queue from the service, and shows the transition", async () => {
    const fake = detailQueue();
    const { lastFrame, stdin } = renderTui(fake);
    await tick();
    const queueCallsBefore = fake.getQueueCalls;
    await press(stdin, "\r");
    await press(stdin, "a");
    await press(stdin, "y");

    expect(fake.applyDecisionCalls).toEqual([{ action: "approve", taskId: "alpha" }]);
    // One explicit refresh of the queue happens after the decision is applied.
    expect(fake.getQueueCalls).toBeGreaterThanOrEqual(queueCallsBefore + 1);
    expect(lastFrame()).toContain("Review Dashboard");
    expect(lastFrame()).toContain("approved: alpha needs_review → complete");
    // The approved task now lives in the completed bucket (refreshed from the service).
    expect(fake.queue.completed.rows.map((candidate) => candidate.taskId)).toContain("alpha");
  });

  it("request changes requires a nonblank reason and then applies with the reason", async () => {
    const fake = detailQueue();
    const { lastFrame, stdin } = renderTui(fake);
    await tick();
    await press(stdin, "\r");
    await press(stdin, "e");

    expect(lastFrame()).toContain("Request changes");
    expect(lastFrame()).toContain("Reason:");

    await press(stdin, "\r"); // Enter with an empty reason
    expect(lastFrame()).toContain("A nonblank reason is required.");
    expect(fake.applyDecisionCalls).toHaveLength(0);

    await type(stdin, "More tests");
    await press(stdin, "\r");
    expect(fake.applyDecisionCalls).toEqual([
      { action: "request_changes", taskId: "alpha", reason: "More tests" },
    ]);
    expect(lastFrame()).toContain("changes_requested: alpha needs_review → in_progress");
  });

  it("reject goes through the reason prompt and removes the task from the queue", async () => {
    const fake = detailQueue();
    const { lastFrame, stdin } = renderTui(fake);
    await tick();
    await press(stdin, "\r");
    await press(stdin, "x");

    expect(lastFrame()).toContain("Reject");
    await type(stdin, "Scope is too wide");
    await press(stdin, "\r");

    expect(fake.applyDecisionCalls).toEqual([
      { action: "reject", taskId: "alpha", reason: "Scope is too wide" },
    ]);
    expect(lastFrame()).toContain("rejected: alpha needs_review → failed");
    expect(fake.queue.needsReview.rows).toHaveLength(0);
  });

  it("Escape cancels the reason prompt without mutating", async () => {
    const fake = detailQueue();
    const { lastFrame, stdin } = renderTui(fake);
    await tick();
    await press(stdin, "\r");
    await press(stdin, "e");
    await type(stdin, "half");
    await press(stdin, "\u001b");
    expect(fake.applyDecisionCalls).toHaveLength(0);
    expect(lastFrame()).toContain("Reviewing: alpha");
  });

  it("reopen is offered only for completed tasks and moves them back to in_progress", async () => {
    const fake = detailQueue();
    const { lastFrame, stdin } = renderTui(fake);
    await tick();

    // Select the completed task (third row).
    await press(stdin, "j");
    await press(stdin, "j");
    await press(stdin, "\r");
    expect(lastFrame()).toContain("Reviewing: done");

    await press(stdin, "o");
    expect(lastFrame()).toContain("Confirm reopen");
    expect(lastFrame()).toContain("complete to in_progress");

    await press(stdin, "y");
    expect(fake.applyDecisionCalls).toEqual([{ action: "reopen", taskId: "done" }]);
    expect(lastFrame()).toContain("reopened: done complete → in_progress");
  });

  it("action failure keeps the detail view and reports the error", async () => {
    const failing = new FakeReviewService(makeQueue({ needsReview: [row("alpha")] }), [
      makePacket({ taskId: "alpha" }),
    ]);
    const original = failing.applyDecision.bind(failing);
    failing.applyDecision = (action, taskId, reason) => {
      if (action === "approve") {
        throw new Error("Task alpha is not ready for review outcome");
      }
      return original(action, taskId, reason);
    };

    const { lastFrame, stdin } = renderTui(failing);
    await tick();
    await press(stdin, "\r");
    await press(stdin, "a");
    await press(stdin, "y");

    expect(lastFrame()).toContain("Action failed: Task alpha is not ready for review outcome");
    expect(lastFrame()).toContain("Reviewing: alpha");
  });
});

// ── Pager invocation ──────────────────────────────────────────────────────

describe("ReviewTui pager invocation", () => {
  it("d opens the task-scoped external diff through the pager", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const diffRunner: CommandRunner = (command, args) => {
      calls.push({ command, args });
      if (args[0] === "status") {
        return { status: 0, stdout: "?? src/new-file.ts\n", stderr: "" };
      }
      return {
        status: 0,
        stdout: "diff --git a/src/example.ts b/src/example.ts\n+added\n",
        stderr: "",
      };
    };
    const fake = new FakeReviewService(makeQueue({ needsReview: [row("alpha")] }), [
      makePacket({ taskId: "alpha" }),
    ]);
    const { lastFrame, stdin, onOpenPager } = renderTui(fake, { diffRunner });
    await tick();
    await press(stdin, "\r");
    await press(stdin, "d");

    expect(onOpenPager).toHaveBeenCalledTimes(1);
    const content = onOpenPager.mock.calls[0][0] as string;
    expect(content).toContain("Task: alpha");
    expect(content).toContain("Untracked paths");
    expect(content).toContain("src/new-file.ts");
    expect(content).toContain("diff --git");
    expect(calls[1].args).toEqual(["diff", "HEAD", "--", "src/example.ts"]);
    // The dashboard itself stays put (the diff is external).
    expect(lastFrame()).toContain("Reviewing: alpha");
  });

  it("r opens a long raw receipt through the pager", async () => {
    const longReceipt = Array.from({ length: 80 }, (_, index) => `receipt line ${index}`).join(
      "\n",
    );
    const fake = new FakeReviewService(makeQueue({ needsReview: [row("alpha")] }), [
      makePacket({
        taskId: "alpha",
        receipt: {
          result: "complete",
          hasVerificationReceipt: true,
          verificationReceipt: longReceipt,
        },
      }),
    ]);
    const { lastFrame, stdin, onOpenPager } = renderTui(fake);
    await tick();
    await press(stdin, "\r");
    await press(stdin, "r");

    expect(onOpenPager).toHaveBeenCalledTimes(1);
    expect(onOpenPager.mock.calls[0][0]).toContain("receipt line 0");
    expect(lastFrame()).toContain("Reviewing: alpha");
  });

  it("r shows a short receipt inline", async () => {
    const fake = new FakeReviewService(makeQueue({ needsReview: [row("alpha")] }), [
      makePacket({ taskId: "alpha" }),
    ]);
    const { lastFrame, stdin, onOpenPager } = renderTui(fake);
    await tick();
    await press(stdin, "\r");
    await press(stdin, "r");

    expect(onOpenPager).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Receipt — alpha");
    expect(lastFrame()).toContain("ok: true");
  });

  it("t shows test and command evidence and g shows dependency context", async () => {
    const fake = new FakeReviewService(makeQueue({ needsReview: [row("alpha")] }), [
      makePacket({
        taskId: "alpha",
        dependencies: [{ taskId: "dep-task", status: "complete", complete: true }],
      }),
    ]);
    const { lastFrame, stdin } = renderTui(fake);
    await tick();
    await press(stdin, "\r");
    await press(stdin, "t");
    expect(lastFrame()).toContain("Tests and commands — alpha");
    expect(lastFrame()).toContain("passed: pnpm test");

    await press(stdin, "\u001b"); // back to detail
    await press(stdin, "g");
    expect(lastFrame()).toContain("Dependencies — alpha");
    expect(lastFrame()).toContain("dep-task (complete)");
  });
});

// ── Narrow terminals, empty queues, scroll, session ───────────────────────

describe("ReviewTui narrow terminals and scroll", () => {
  it("renders and stays navigable in a narrow terminal", async () => {
    const fake = new FakeReviewService(makeQueue({ needsReview: [row("alpha"), row("beta")] }), [
      makePacket({ taskId: "alpha" }),
      makePacket({ taskId: "beta" }),
    ]);
    const onOpenPager = vi.fn();
    const { instance, stdout, stdin } = renderNarrow(
      React.createElement(ReviewTui, {
        service: fake,
        cwd: FAKE_CWD,
        onOpenPager,
        windowHeight: 4,
      }),
      24,
    );
    await tick();

    expect(stdout.lastFrame()).toContain("Review Dashboard");
    expect(stdout.lastFrame()).toContain("alpha");

    stdin.write("j");
    await tick();
    expect(stdout.lastFrame()).toContain("beta");

    stdin.write("\r");
    await tick();
    expect(stdout.lastFrame()).toContain("Reviewing: beta");

    instance.unmount();
  });

  it("scrolls the detail summary with j/k and records the scroll in the session", async () => {
    const manyCriteria = Array.from({ length: 14 }, (_, index) => ({
      criterion: `Criterion number ${index}.`,
      evidence: `Evidence ${index}.`,
      covered: true,
    }));
    const packet = makePacket({ taskId: "alpha", acceptanceCriteria: manyCriteria });
    const fake = new FakeReviewService(makeQueue({ needsReview: [row("alpha")] }), [packet]);
    const session: ReviewTuiSession = { selectedTaskId: null, view: "list", scroll: 0 };
    const { lastFrame, stdin } = renderTui(fake, { session, windowHeight: 6 });
    await tick();
    await press(stdin, "\r");

    expect(lastFrame()).toContain("alpha — Example task");
    expect(session.scroll).toBe(0);

    await press(stdin, "j");
    await press(stdin, "j");
    await press(stdin, "j");
    expect(session.scroll).toBe(3);
    expect(lastFrame()).not.toContain("alpha — Example task");

    await press(stdin, "k");
    expect(session.scroll).toBe(2);
  });

  it("restores a pre-pager session on re-render", async () => {
    const packet = makePacket({ taskId: "alpha" });
    const fake = new FakeReviewService(makeQueue({ needsReview: [row("alpha")] }), [packet]);
    const session: ReviewTuiSession = { selectedTaskId: "alpha", view: "detail", scroll: 2 };
    const { lastFrame } = renderTui(fake, { session, windowHeight: 6 });
    await tick();

    expect(lastFrame()).toContain("Reviewing: alpha");
    expect(fake.getPacketCalls).toContain("alpha");
    expect(session.view).toBe("detail");
    expect(session.selectedTaskId).toBe("alpha");
    expect(session.scroll).toBe(2);
  });
});

// ── Narrow-terminal harness (ink render with configurable columns) ────────

type FakeStream = EventEmitter & {
  columns: number;
  rows: number;
  frames: string[];
  lastFrameValue?: string;
  write: (frame: string) => void;
  lastFrame: () => string | undefined;
};

function createFakeStream(columns: number): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  stream.columns = columns;
  stream.rows = 40;
  stream.frames = [];
  stream.write = (frame: string) => {
    stream.frames.push(frame);
    stream.lastFrameValue = frame;
  };
  stream.lastFrame = () => stream.lastFrameValue;
  return stream;
}

type FakeStdin = EventEmitter & {
  isTTY: boolean;
  data: unknown;
  write: (data: string) => void;
  setEncoding: () => void;
  setRawMode: () => void;
  resume: () => void;
  pause: () => void;
  ref: () => void;
  unref: () => void;
  read: () => unknown;
};

function createFakeStdin(): FakeStdin {
  const stdin = new EventEmitter() as FakeStdin;
  stdin.isTTY = true;
  stdin.data = null;
  stdin.write = (data: string) => {
    stdin.data = data;
    stdin.emit("readable");
    stdin.emit("data", data);
  };
  stdin.setEncoding = () => {};
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  stdin.read = () => {
    const data = stdin.data;
    stdin.data = null;
    return data;
  };
  return stdin;
}

function renderNarrow(ui: React.ReactElement, columns: number) {
  const stdout = createFakeStream(columns);
  const stderr = createFakeStream(columns);
  const stdin = createFakeStdin();
  const instance = inkRender(ui, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { instance, stdout, stdin };
}
