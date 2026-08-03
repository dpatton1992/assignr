import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { completeCommand } from "../src/commands/complete.js";
import { initCommand } from "../src/commands/init.js";
import { newCommand } from "../src/commands/new.js";
import { runLogCommand } from "../src/commands/runLog.js";
import { setStatusCommand } from "../src/commands/setStatus.js";
import { getPaths } from "../src/utils/paths.js";

const tempDirs: string[] = [];

function makeRepo(prefix: string): { cwd: string; p: ReturnType<typeof getPaths> } {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(cwd);
  const p = getPaths(cwd, ".manciple");
  return { cwd, p };
}

function slugTitleFromId(id: string): string {
  return id.replaceAll("-", " ");
}

async function initRepo(cwd: string): Promise<void> {
  await initCommand({ force: false, cwd, root: ".manciple" });
}

function createTaskInReview(p: ReturnType<typeof getPaths>, cwd: string, id: string): void {
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
    decisionsMade: ["Recorded via MCP decision tool."],
    risks: "none",
    followUps: ["none"],
    verifyReceipt: JSON.stringify({
      ok: true,
      commands_run: [
        { command: "pnpm build", ok: true, exit_code: 0 },
        { command: "pnpm test", ok: true, exit_code: 0 },
      ],
    }),
  });
}

function createPendingTask(p: ReturnType<typeof getPaths>, cwd: string, id: string): void {
  newCommand(slugTitleFromId(id), {
    type: "implementation",
    domain: "core",
    priority: "medium",
    cwd,
    activeDir: p.tasksActive,
  });
}

function createCompletedTask(p: ReturnType<typeof getPaths>, cwd: string, id: string): void {
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

function readTaskStatus(filePath: string): unknown {
  return (parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>).status;
}

async function connectServer(cwd: string): Promise<Client> {
  const tsxBin = join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );
  const transport = new StdioClientTransport({
    command: tsxBin,
    args: [join(process.cwd(), "src", "mcp.ts")],
    cwd,
  });
  const client = new Client({ name: "manciple-review-tools-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const text = content?.find((part) => part.type === "text")?.text;
  expect(text).toBeDefined();
  return text ?? "";
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("manciple_list_review_queue", () => {
  it("returns the assembled review queue summary as JSON", async () => {
    const { cwd, p } = makeRepo("manciple-mcp-review-queue-");
    await initRepo(cwd);
    createTaskInReview(p, cwd, "alpha-review");
    createTaskInReview(p, cwd, "beta-review");
    createCompletedTask(p, cwd, "done-task");

    const client = await connectServer(cwd);
    const result = await client.callTool({ name: "manciple_list_review_queue", arguments: {} });
    await client.close();

    const parsed = JSON.parse(textOf(result));
    expect(result.isError).toBeFalsy();
    expect(parsed.needsReview.count).toBe(2);
    expect(parsed.needsReview.rows.map((row: { taskId: string }) => row.taskId).sort()).toEqual([
      "alpha-review",
      "beta-review",
    ]);
    expect(parsed.blocked.count).toBe(0);
    expect(parsed.completed.count).toBe(1);
    expect(parsed.total).toBe(3);
  });
});

describe("manciple_get_review_packet", () => {
  it("returns the assembled ReviewPacket for an existing task", async () => {
    const { cwd, p } = makeRepo("manciple-mcp-review-packet-");
    await initRepo(cwd);
    createTaskInReview(p, cwd, "packet-task");

    const client = await connectServer(cwd);
    const result = await client.callTool({
      name: "manciple_get_review_packet",
      arguments: { task_id: "packet-task" },
    });
    await client.close();

    const parsed = JSON.parse(textOf(result));
    expect(result.isError).toBeFalsy();
    expect(parsed.taskId).toBe("packet-task");
    expect(parsed.status).toBe("needs_review");
    expect(parsed.tier).toBe("active");
    expect(parsed.changedFilesSource).toBe("run-log");
    expect(parsed.availableDecisions.map((d: { id: string }) => d.id)).toEqual([
      "approve",
      "request_changes",
      "reject",
      "block",
    ]);
    // Run-log evidence was assembled by the service layer, not by the MCP adapter.
    expect(parsed.workerNotes.decisionsMade).toEqual(["Recorded via MCP decision tool."]);
    expect(parsed.verification.commandOutcomes).toEqual([
      { command: "TODO: add verification commands", status: "missing" },
    ]);
  });

  it("returns a structured error result for an absent task", async () => {
    const { cwd, p } = makeRepo("manciple-mcp-review-missing-");
    await initRepo(cwd);
    createTaskInReview(p, cwd, "present-task");

    const client = await connectServer(cwd);
    const result = await client.callTool({
      name: "manciple_get_review_packet",
      arguments: { task_id: "missing-task" },
    });
    await client.close();

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({ error: "Task not found: missing-task" });
  });
});

describe("manciple_review_decision", () => {
  it("approves a needs_review task and moves it to completed", async () => {
    const { cwd, p } = makeRepo("manciple-mcp-review-approve-");
    await initRepo(cwd);
    createTaskInReview(p, cwd, "approve-task");

    const client = await connectServer(cwd);
    const result = await client.callTool({
      name: "manciple_review_decision",
      arguments: { task_id: "approve-task", action: "approve" },
    });
    await client.close();

    const parsed = JSON.parse(textOf(result));
    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({
      taskId: "approve-task",
      outcome: "approved",
      previousStatus: "needs_review",
      nextStatus: "complete",
    });
    expect(existsSync(join(p.tasksCompleted, "approve-task.yaml"))).toBe(true);
    expect(readTaskStatus(join(p.tasksCompleted, "approve-task.yaml"))).toBe("complete");
    expect(existsSync(join(p.tasksActive, "approve-task.yaml"))).toBe(false);
  });

  it("requires a reason for request_changes", async () => {
    const { cwd, p } = makeRepo("manciple-mcp-review-reason-");
    await initRepo(cwd);
    createTaskInReview(p, cwd, "changes-task");

    const client = await connectServer(cwd);
    const result = await client.callTool({
      name: "manciple_review_decision",
      arguments: { task_id: "changes-task", action: "request_changes" },
    });
    await client.close();

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      error: "reason is required for action 'request_changes'.",
    });
  });

  it("requires a non-empty reason for block and reject", async () => {
    const { cwd, p } = makeRepo("manciple-mcp-review-empty-reason-");
    await initRepo(cwd);
    createTaskInReview(p, cwd, "block-task");
    createTaskInReview(p, cwd, "reject-task");

    const client = await connectServer(cwd);
    const blockResult = await client.callTool({
      name: "manciple_review_decision",
      arguments: { task_id: "block-task", action: "block", reason: "  " },
    });
    const rejectResult = await client.callTool({
      name: "manciple_review_decision",
      arguments: { task_id: "reject-task", action: "reject", reason: "" },
    });
    await client.close();

    expect(blockResult.isError).toBe(true);
    expect(JSON.parse(textOf(blockResult))).toEqual({
      error: "reason is required for action 'block'.",
    });
    expect(rejectResult.isError).toBe(true);
    expect(JSON.parse(textOf(rejectResult))).toEqual({
      error: "reason is required for action 'reject'.",
    });
  });

  it("request_changes with a reason returns the task to in_progress", async () => {
    const { cwd, p } = makeRepo("manciple-mcp-review-changes-");
    await initRepo(cwd);
    createTaskInReview(p, cwd, "changes-task");

    const client = await connectServer(cwd);
    const result = await client.callTool({
      name: "manciple_review_decision",
      arguments: { task_id: "changes-task", action: "request_changes", reason: "Add edge cases." },
    });
    await client.close();

    const parsed = JSON.parse(textOf(result));
    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({
      outcome: "changes_requested",
      previousStatus: "needs_review",
      nextStatus: "in_progress",
    });
    expect(readTaskStatus(join(p.tasksActive, "changes-task.yaml"))).toBe("in_progress");
  });

  it("block and reject record durable outcomes", async () => {
    const { cwd, p } = makeRepo("manciple-mcp-review-blockreject-");
    await initRepo(cwd);
    createTaskInReview(p, cwd, "block-task");
    createTaskInReview(p, cwd, "reject-task");

    const client = await connectServer(cwd);
    const blockResult = await client.callTool({
      name: "manciple_review_decision",
      arguments: { task_id: "block-task", action: "block", reason: "Environment unavailable." },
    });
    const rejectResult = await client.callTool({
      name: "manciple_review_decision",
      arguments: { task_id: "reject-task", action: "reject", reason: "Evidence incomplete." },
    });
    await client.close();

    expect(JSON.parse(textOf(blockResult))).toMatchObject({
      outcome: "blocked",
      nextStatus: "blocked",
    });
    expect(readTaskStatus(join(p.tasksActive, "block-task.yaml"))).toBe("blocked");
    expect(JSON.parse(textOf(rejectResult))).toMatchObject({
      outcome: "rejected",
      nextStatus: "failed",
    });
    expect(readTaskStatus(join(p.tasksActive, "reject-task.yaml"))).toBe("failed");
  });

  it("reopens a completed task back to active in_progress", async () => {
    const { cwd, p } = makeRepo("manciple-mcp-review-reopen-");
    await initRepo(cwd);
    createTaskInReview(p, cwd, "reopen-task");

    const client = await connectServer(cwd);
    await client.callTool({
      name: "manciple_review_decision",
      arguments: { task_id: "reopen-task", action: "approve" },
    });
    const result = await client.callTool({
      name: "manciple_review_decision",
      arguments: { task_id: "reopen-task", action: "reopen" },
    });
    await client.close();

    const parsed = JSON.parse(textOf(result));
    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({
      outcome: "reopened",
      previousStatus: "complete",
      nextStatus: "in_progress",
    });
    expect(existsSync(join(p.tasksActive, "reopen-task.yaml"))).toBe(true);
    expect(readTaskStatus(join(p.tasksActive, "reopen-task.yaml"))).toBe("in_progress");
    expect(existsSync(join(p.tasksCompleted, "reopen-task.yaml"))).toBe(false);
  });

  it("returns a structured error for an illegal lifecycle transition", async () => {
    const { cwd, p } = makeRepo("manciple-mcp-review-illegal-");
    await initRepo(cwd);
    createPendingTask(p, cwd, "pending-task");

    const client = await connectServer(cwd);
    const result = await client.callTool({
      name: "manciple_review_decision",
      arguments: { task_id: "pending-task", action: "approve" },
    });
    await client.close();

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      error:
        "Task pending-task is not ready for review outcome: expected needs_review, found pending.",
    });
  });

  it("rejects a malformed action with a structured protocol error", async () => {
    const { cwd, p } = makeRepo("manciple-mcp-review-malformed-");
    await initRepo(cwd);
    createTaskInReview(p, cwd, "valid-task");

    const client = await connectServer(cwd);
    const result = await client.callTool({
      name: "manciple_review_decision",
      arguments: { task_id: "valid-task", action: "nuke" },
    });
    await client.close();

    // The MCP SDK surfaces zod schema validation failures as an isError result
    // with the typed enum options in the message.
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Input validation error");
    expect(text).toContain("Invalid enum value");
    expect(text).toContain("'approve' | 'request_changes' | 'reject' | 'block' | 'reopen'");

    // No mutation happened for the malformed action.
    expect(readTaskStatus(join(p.tasksActive, "valid-task.yaml"))).toBe("needs_review");
  });
});

describe("MCP review tools repo scoping", () => {
  it("scopes queue, packet, and decision tools to the repo argument", async () => {
    const server = makeRepo("manciple-mcp-review-server-root-");
    const target = makeRepo("manciple-mcp-review-target-root-");
    await initRepo(server.cwd);
    await initRepo(target.cwd);
    createTaskInReview(server.p, server.cwd, "server-task");
    createTaskInReview(target.p, target.cwd, "target-task");

    const client = await connectServer(server.cwd);
    const defaultQueue = await client.callTool({
      name: "manciple_list_review_queue",
      arguments: {},
    });
    const scopedQueue = await client.callTool({
      name: "manciple_list_review_queue",
      arguments: { repo: target.cwd },
    });
    const scopedPacket = await client.callTool({
      name: "manciple_get_review_packet",
      arguments: { repo: target.cwd, task_id: "target-task" },
    });
    const defaultPacketMissing = await client.callTool({
      name: "manciple_get_review_packet",
      arguments: { task_id: "target-task" },
    });
    await client.close();

    expect(
      JSON.parse(textOf(defaultQueue)).needsReview.rows.map(
        (row: { taskId: string }) => row.taskId,
      ),
    ).toEqual(["server-task"]);
    expect(
      JSON.parse(textOf(scopedQueue)).needsReview.rows.map((row: { taskId: string }) => row.taskId),
    ).toEqual(["target-task"]);
    expect(JSON.parse(textOf(scopedPacket)).taskId).toBe("target-task");
    expect(defaultPacketMissing.isError).toBe(true);
    expect(JSON.parse(textOf(defaultPacketMissing)).error).toBe("Task not found: target-task");
  });

  it("applies a scoped review decision in the target repo only", async () => {
    const server = makeRepo("manciple-mcp-review-scoped-decision-server-");
    const target = makeRepo("manciple-mcp-review-scoped-decision-target-");
    await initRepo(server.cwd);
    await initRepo(target.cwd);
    createTaskInReview(server.p, server.cwd, "server-task");
    createTaskInReview(target.p, target.cwd, "target-task");

    const client = await connectServer(server.cwd);
    const result = await client.callTool({
      name: "manciple_review_decision",
      arguments: { repo: target.cwd, task_id: "target-task", action: "approve" },
    });
    await client.close();

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toMatchObject({
      taskId: "target-task",
      outcome: "approved",
    });
    expect(existsSync(join(target.p.tasksCompleted, "target-task.yaml"))).toBe(true);
    // Server repo task is untouched.
    expect(readTaskStatus(join(server.p.tasksActive, "server-task.yaml"))).toBe("needs_review");
    expect(existsSync(join(server.p.tasksCompleted, "target-task.yaml"))).toBe(false);
  });
});
