import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse } from "yaml";
import { listTasksForMcp } from "../src/mcpList.js";
import { getPaths } from "../src/utils/paths.js";
import type { TaskTier } from "../src/specs/loadTasks.js";

const tempDirs: string[] = [];

function writeTask(
  root: string,
  tier: TaskTier,
  id: string,
  status = "pending",
  implementationNotes: string[] = []
): void {
  const implementationNoteLines =
    implementationNotes.length > 0
      ? ["implementation_notes:", ...implementationNotes.map((note) => `  - ${note}`)]
      : ["implementation_notes: []"];
  const paths = getPaths(root, ".manciple");
  const dirByTier = {
    active: paths.tasksActive,
    completed: paths.tasksCompleted,
    archived: paths.tasksArchived,
  };
  const dir = dirByTier[tier];
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.yaml`),
    [
      `id: ${id}`,
      `title: ${id}`,
      `status: ${status}`,
      "type: implementation",
      "domain: core",
      "priority: medium",
      "depends_on: []",
      "goal: Test task.",
      "acceptance_criteria:",
      "  - It works.",
      ...implementationNoteLines,
      "allowed_paths:",
      "  - src/**",
      "forbidden_paths: []",
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
}

describe("listTasksForMcp", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats status=active as a lifecycle tier filter", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-mcp-list-"));
    tempDirs.push(root);
    const paths = getPaths(root, ".manciple");
    writeTask(root, "active", "active-task");
    writeTask(root, "completed", "completed-task", "complete");

    const tasks = listTasksForMcp(paths.specsTasks, root, { status: "active" });

    expect(tasks).toEqual([
      expect.objectContaining({
        id: "active-task",
        status: "pending",
        tier: "active",
      }),
    ]);
  });

  it("keeps task status filters for real statuses", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-mcp-list-"));
    tempDirs.push(root);
    const paths = getPaths(root, ".manciple");
    writeTask(root, "active", "pending-task");
    writeTask(root, "active", "review-task", "needs_review");

    const tasks = listTasksForMcp(paths.specsTasks, root, { status: "needs_review" });

    expect(tasks.map((task) => task.id)).toEqual(["review-task"]);
  });

  it("lists active lifecycle tasks independently of task status", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-mcp-list-"));
    tempDirs.push(root);
    const paths = getPaths(root, ".manciple");
    writeTask(root, "active", "pending-task");
    writeTask(root, "active", "review-task", "needs_review");
    writeTask(root, "active", "blocked-task", "blocked");
    writeTask(root, "completed", "completed-task", "complete");

    const tasks = listTasksForMcp(paths.specsTasks, root, { tier: "active" });

    expect(tasks.map((task) => [task.id, task.status, task.tier]).sort()).toEqual([
      ["blocked-task", "blocked", "active"],
      ["pending-task", "pending", "active"],
      ["review-task", "needs_review", "active"],
    ]);
  });

  it("finds completed tasks when filtering by complete status", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-mcp-list-"));
    tempDirs.push(root);
    const paths = getPaths(root, ".manciple");
    writeTask(root, "active", "pending-task");
    writeTask(root, "completed", "completed-task", "complete");

    const tasks = listTasksForMcp(paths.specsTasks, root, { status: "complete" });

    expect(tasks.map((task) => [task.id, task.tier])).toEqual([
      ["completed-task", "completed"],
    ]);
  });

  it("can list every lifecycle tier with status=all", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-mcp-list-"));
    tempDirs.push(root);
    const paths = getPaths(root, ".manciple");
    writeTask(root, "active", "active-task");
    writeTask(root, "archived", "archived-task", "blocked");

    const tasks = listTasksForMcp(paths.specsTasks, root, { status: "all" });

    expect(tasks.map((task) => [task.id, task.tier])).toEqual([
      ["active-task", "active"],
      ["archived-task", "archived"],
    ]);
  });

  it("returns structured path ownership warnings in MCP compile results", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-mcp-list-"));
    tempDirs.push(root);
    const paths = getPaths(root, ".manciple");
    mkdirSync(paths.tasksActive, { recursive: true });
    mkdirSync(paths.specsDomains, { recursive: true });
    writeFileSync(join(paths.specsDomains, "core.yaml"), "id: core\nname: Core\n", "utf-8");

    writeTask(root, "active", "target-task", "pending", ["Preserve packet parity."]);
    writeFileSync(
      join(paths.tasksActive, "owner-task.yaml"),
      [
        "id: owner-task",
        "title: owner-task",
        "status: in_progress",
        "type: implementation",
        "domain: core",
        "priority: medium",
        "depends_on: []",
        "goal: Test owner.",
        "acceptance_criteria:",
        "  - It works.",
        "implementation_notes: []",
        "allowed_paths:",
        "  - src/**",
        "forbidden_paths: []",
        "path_ownership:",
        "  touched_paths:",
        "    - src/mcp.ts",
        "  locked_paths:",
        "    - src/utils/paths.ts",
        "  unsafe_parallel_areas:",
        "    - src/specs/",
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
    writeFileSync(
      join(paths.tasksActive, "target-task.yaml"),
      [
        "id: target-task",
        "title: target-task",
        "status: pending",
        "type: implementation",
        "domain: core",
        "priority: medium",
        "depends_on: []",
        "goal: Test target.",
        "acceptance_criteria:",
        "  - It works.",
        "implementation_notes:",
        "  - Preserve packet parity.",
        "allowed_paths:",
        "  - src/mcp.ts",
        "  - src/utils/paths.ts",
        "  - src/specs/loadTasks.ts",
        "forbidden_paths: []",
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

    const tsxBin = join(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx"
    );
    const transport = new StdioClientTransport({
      command: tsxBin,
      args: [join(process.cwd(), "src", "mcp.ts")],
      cwd: root,
    });
    const client = new Client({ name: "manciple-test", version: "0.0.0" });

    await client.connect(transport);
    const result = await client.callTool({
      name: "manciple_compile",
      arguments: { task_id: "target-task" },
    });
    await client.close();

    const text = result.content.find((part) => part.type === "text")?.text;
    expect(text).toBeDefined();
    const payload = JSON.parse(text!);
    const warnings = payload.path_ownership_warnings;

    expect(payload.content).toContain("## Domain Context");
    expect(payload.content).toContain("# Agent Task: target-task");
    expect(warnings).toEqual(
      expect.arrayContaining([
        {
          kind: "touched",
          owner_task_id: "owner-task",
          affected_path: "src/mcp.ts",
          owner_path: "src/mcp.ts",
        },
        {
          kind: "locked",
          owner_task_id: "owner-task",
          affected_path: "src/utils/paths.ts",
          owner_path: "src/utils/paths.ts",
        },
        {
          kind: "unsafe_parallel_area",
          owner_task_id: "owner-task",
          affected_path: "src/specs/loadTasks.ts",
          owner_path: "src/specs/",
        },
      ])
    );
    expect(existsSync(join(paths.promptsGenerated, "target-task.md"))).toBe(true);
  });

  it("returns compact task packets over MCP without writing compiled prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-mcp-packet-"));
    tempDirs.push(root);
    const paths = getPaths(root, ".manciple");
    mkdirSync(paths.tasksActive, { recursive: true });
    writeTask(root, "active", "target-task", "pending", ["Preserve packet parity."]);
    writeFileSync(
      join(paths.tasksActive, "owner-task.yaml"),
      [
        "id: owner-task",
        "title: owner-task",
        "status: in_progress",
        "type: implementation",
        "domain: core",
        "priority: medium",
        "depends_on: []",
        "goal: Test owner.",
        "acceptance_criteria:",
        "  - It works.",
        "allowed_paths:",
        "  - src/**",
        "forbidden_paths: []",
        "path_ownership:",
        "  locked_paths:",
        "    - src/**",
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

    const tsxBin = join(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx"
    );
    const transport = new StdioClientTransport({
      command: tsxBin,
      args: [join(process.cwd(), "src", "mcp.ts")],
      cwd: root,
    });
    const client = new Client({ name: "manciple-test", version: "0.0.0" });

    await client.connect(transport);
    const result = await client.callTool({
      name: "manciple_create",
      arguments: {
        title: "MCP Design Contract",
        type: "implementation",
        domain: "core",
        goal: "Create a task with design guidance.",
        acceptance_criteria: ["It records design guidance."],
        implementation_notes: ["Preserve CLI and MCP parity."],
        verification_commands: ["pnpm test"],
      },
    });
    await client.close();

    const text = result.content.find((part) => part.type === "text")?.text;
    expect(text).toBeDefined();
    expect(JSON.parse(text!)).toMatchObject({
      id: "mcp-design-contract",
      file_path: ".manciple/tasks/active/mcp-design-contract.yaml",
    });
    const raw = readFileSync(join(root, ".manciple", "tasks", "active", "mcp-design-contract.yaml"), "utf-8");
    expect((parse(raw) as Record<string, unknown>)["implementation_notes"]).toEqual([
      "Preserve CLI and MCP parity.",
    ]);
  });

  it("formats one task over MCP with a structured response", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-mcp-format-task-"));
    tempDirs.push(root);
    writeTask(root, "active", "format-task");

    const tsxBin = join(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx"
    );
    const transport = new StdioClientTransport({
      command: tsxBin,
      args: [join(process.cwd(), "src", "mcp.ts")],
      cwd: root,
    });
    const client = new Client({ name: "manciple-test", version: "0.0.0" });

    await client.connect(transport);
    const result = await client.callTool({
      name: "manciple_format_task",
      arguments: { task_id: "format-task", check_only: true },
    });
    await client.close();

    const text = result.content.find((part) => part.type === "text")?.text;
    expect(text).toBeDefined();
    expect(JSON.parse(text!)).toEqual({
      checked: true,
      changed: false,
      file: ".manciple/tasks/active/format-task.yaml",
      errors: [],
    });
  });

  it("validates tasks over MCP with structured counts", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-mcp-validate-"));
    tempDirs.push(root);
    const paths = getPaths(root, ".manciple");
    mkdirSync(paths.specsDomains, { recursive: true });
    writeFileSync(join(paths.specsDomains, "core.yaml"), "id: core\nname: Core\n", "utf-8");
    writeTask(root, "active", "valid-task");
    writeTask(root, "active", "other-task", "needs_review");

    const tsxBin = join(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx"
    );
    const transport = new StdioClientTransport({
      command: tsxBin,
      args: [join(process.cwd(), "src", "mcp.ts")],
      cwd: root,
    });
    const client = new Client({ name: "manciple-test", version: "0.0.0" });

    await client.connect(transport);
    const result = await client.callTool({
      name: "manciple_validate",
      arguments: {},
    });
    await client.close();

    const text = result.content.find((part) => part.type === "text")?.text;
    expect(text).toBeDefined();
    const payload = JSON.parse(text!);

    expect(payload).toMatchObject({
      valid_count: 2,
      error_count: 0,
      counts: {
        tasks_checked: 2,
        domains_checked: 1,
      },
      errors: [],
    });
  });

  it("creates run logs over MCP with separated audit evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-mcp-run-log-"));
    tempDirs.push(root);
    const paths = getPaths(root, ".manciple");
    writeTask(root, "active", "run-log-task");

    const tsxBin = join(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx"
    );
    const transport = new StdioClientTransport({
      command: tsxBin,
      args: [join(process.cwd(), "src", "mcp.ts")],
      cwd: root,
    });
    const client = new Client({ name: "manciple-test", version: "0.0.0" });

    await client.connect(transport);
    const result = await client.callTool({
      name: "manciple_run_log",
      arguments: {
        task_id: "run-log-task",
        task_status: "needs_review",
        files_changed: ["src/commands/runLog.ts"],
        commands_run: ["pnpm build"],
        tests_run: ["pnpm test -- runLog"],
        acceptance_criteria_evidence: ["Acceptance evidence recorded."],
        decisions_made: ["Separated non-test commands from verification evidence."],
        follow_ups: ["none"],
        verify_receipt: '{"ok":true,"profile":"worker"}',
        result: "complete",
        risks: "No known risks.",
      },
    });
    await client.close();

    const text = result.content.find((part) => part.type === "text")?.text;
    expect(text).toBeDefined();
    const payload = JSON.parse(text!);
    expect(existsSync(payload.path)).toBe(true);

    const files = readdirSync(paths.runs).filter((file) => file.endsWith(".md")).sort();
    const content = readFileSync(join(paths.runs, files.at(-1) ?? ""), "utf-8");

    expect(content).toContain("- Status: needs_review");
    expect(content).toContain("- src/commands/runLog.ts");
    expect(content).toContain("- pnpm build");
    expect(content).toContain("- pnpm test -- runLog");
    expect(content).toContain("Acceptance evidence recorded.");
    expect(content).toContain("Separated non-test commands from verification evidence.");
    expect(content).toContain("- none");
    expect(content).toContain('{"ok":true,"profile":"worker"}');
    expect(content).toContain("No known risks.");
  });

  it("exposes the deterministic dispatch plan over MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-mcp-dispatch-"));
    tempDirs.push(root);
    const paths = getPaths(root, ".manciple");
    writeTask(root, "active", "ready-task");
    writeTask(root, "active", "blocked-task", "blocked");

    const tsxBin = join(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx"
    );
    const transport = new StdioClientTransport({
      command: tsxBin,
      args: [join(process.cwd(), "src", "mcp.ts")],
      cwd: root,
    });
    const client = new Client({ name: "manciple-test", version: "0.0.0" });

    await client.connect(transport);
    const result = await client.callTool({
      name: "manciple_dispatch_plan",
      arguments: { use_worktrees: false },
    });
    await client.close();

    const text = result.content.find((part) => part.type === "text")?.text;
    expect(text).toBeDefined();
    const payload = JSON.parse(text!);

    expect(payload).toMatchObject({
      worker_cap: 1,
      recommended_batch_size: 1,
      assignments: [
        {
          task_id: "ready-task",
          ownership_boundary: {
            allowed_paths: ["src/**"],
            forbidden_paths: [],
          },
        },
      ],
      do_not_dispatch: [
        {
          task_id: "blocked-task",
          section: "blocked",
          reason: "blocked status",
        },
      ],
      stop_after_batch: {
        required: true,
      },
      verification_plan: {
        batch_commands: ["pnpm test"],
      },
    });
  });

  it("returns compact deterministic verify receipts over MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-mcp-verify-"));
    tempDirs.push(root);

    const tsxBin = join(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx"
    );
    const transport = new StdioClientTransport({
      command: tsxBin,
      args: [join(process.cwd(), "src", "mcp.ts")],
      cwd: root,
    });
    const client = new Client({ name: "manciple-test", version: "0.0.0" });

    await client.connect(transport);
    const result = await client.callTool({
      name: "manciple_verify",
      arguments: { profile: "coordinator" },
    });
    await client.close();

    const text = result.content.find((part) => part.type === "text")?.text;
    expect(text).toBeDefined();
    const payload = JSON.parse(text!);

    expect(payload).toMatchObject({
      ok: false,
      profile: "coordinator",
      commands_run: [
        { command: "pnpm typecheck", ok: false },
        { command: "pnpm test -- coordinator", ok: false },
        { command: "pnpm test -- mcpList", ok: false },
      ],
      output: {
        included: "failures_only",
        max_chars_per_stream: 2000,
      },
    });
    expect(payload.failures).toHaveLength(3);
    expect(payload.failures[0]).toMatchObject({
      command: "pnpm typecheck",
      ok: false,
      output: {
        stdout_truncated: false,
        stderr_truncated: false,
      },
    });
    expect(payload.failures[0].output.stdout ?? payload.failures[0].output.stderr).toBeTruthy();
  });

  it("scopes MCP list calls to the repo argument instead of the server cwd", async () => {
    const serverRoot = await mkdtemp(join(tmpdir(), "manciple-mcp-server-root-"));
    const targetRoot = await mkdtemp(join(tmpdir(), "manciple-mcp-target-root-"));
    tempDirs.push(serverRoot, targetRoot);
    writeTask(serverRoot, "active", "server-task", "pending");
    writeTask(targetRoot, "active", "target-task", "needs_review");

    const tsxBin = join(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx"
    );
    const transport = new StdioClientTransport({
      command: tsxBin,
      args: [join(process.cwd(), "src", "mcp.ts")],
      cwd: serverRoot,
    });
    const client = new Client({ name: "manciple-test", version: "0.0.0" });

    await client.connect(transport);
    const defaultResult = await client.callTool({
      name: "manciple_list",
      arguments: { status: "all" },
    });
    const scopedResult = await client.callTool({
      name: "manciple_list",
      arguments: { repo: targetRoot, status: "all" },
    });
    await client.close();

    const defaultText = defaultResult.content.find((part) => part.type === "text")?.text;
    const scopedText = scopedResult.content.find((part) => part.type === "text")?.text;
    expect(defaultText).toBeDefined();
    expect(scopedText).toBeDefined();

    expect(JSON.parse(defaultText!).map((task: { id: string }) => task.id)).toEqual(["server-task"]);
    expect(JSON.parse(scopedText!).map((task: { id: string }) => task.id)).toEqual(["target-task"]);
  });

  it("scopes MCP write calls to the repo argument instead of the server cwd", async () => {
    const serverRoot = await mkdtemp(join(tmpdir(), "manciple-mcp-write-server-root-"));
    const targetRoot = await mkdtemp(join(tmpdir(), "manciple-mcp-write-target-root-"));
    tempDirs.push(serverRoot, targetRoot);

    const tsxBin = join(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx"
    );
    const transport = new StdioClientTransport({
      command: tsxBin,
      args: [join(process.cwd(), "src", "mcp.ts")],
      cwd: serverRoot,
    });
    const client = new Client({ name: "manciple-test", version: "0.0.0" });

    await client.connect(transport);
    const result = await client.callTool({
      name: "manciple_create",
      arguments: {
        repo: targetRoot,
        title: "Scoped MCP Task",
        type: "implementation",
        domain: "core",
        goal: "Create a task in the requested repo.",
        acceptance_criteria: ["It writes to the requested repo."],
        verification_commands: ["pnpm test"],
      },
    });
    await client.close();

    const text = result.content.find((part) => part.type === "text")?.text;
    expect(text).toBeDefined();
    expect(JSON.parse(text!)).toMatchObject({
      id: "scoped-mcp-task",
      file_path: ".manciple/tasks/active/scoped-mcp-task.yaml",
    });
    expect(existsSync(join(targetRoot, ".manciple", "tasks", "active", "scoped-mcp-task.yaml"))).toBe(true);
    expect(existsSync(join(serverRoot, ".manciple", "tasks", "active", "scoped-mcp-task.yaml"))).toBe(false);
  });
});
