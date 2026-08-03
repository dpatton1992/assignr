import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { getPaths } from "../src/utils/paths.js";

const dirs: string[] = [];

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();
}

function setupRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "manciple-mcp-worktree-"));
  dirs.push(cwd);
  const p = getPaths(cwd, ".manciple");
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "tests@example.com"]);
  git(cwd, ["config", "user.name", "Manciple Tests"]);
  mkdirSync(p.tasksActive, { recursive: true });
  writeFileSync(p.config, "root: .manciple\nworktrees:\n  enabled: true\n", "utf-8");
  writeFileSync(
    join(p.tasksActive, "mcp-managed-task.yaml"),
    `id: mcp-managed-task
title: MCP managed task
status: pending
type: implementation
domain: core
priority: medium
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
goal: Exercise MCP worktree tools.
acceptance_criteria:
  - Worktree tools return structured records.
verification:
  commands:
    - test -f feature.txt
outputs_required:
  - files_changed
notes: []
`,
    "utf-8",
  );
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "initial"]);
  return cwd;
}

async function connect(cwd: string): Promise<Client> {
  const tsxBin = join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );
  const client = new Client({ name: "manciple-worktree-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: tsxBin,
      args: [join(process.cwd(), "src", "mcp.ts")],
      cwd,
    }),
  );
  return client;
}

// The parsed MCP result shape is asserted at each call site.
// biome-ignore lint/suspicious/noExplicitAny: JSON-parsed MCP tool content; shape asserted at call sites.
function payload(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((entry) => entry.type === "text")?.text;
  return JSON.parse(text ?? "null");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("MCP managed worktree tools", () => {
  it("prepares, reports, releases, and removes a task worktree", async () => {
    const cwd = setupRepo();
    const client = await connect(cwd);
    try {
      const prepared = payload(
        await client.callTool({
          name: "manciple_prepare_worktree",
          arguments: { task_id: "mcp-managed-task" },
        }),
      );
      expect(prepared).toMatchObject({
        task_id: "mcp-managed-task",
        branch: "manciple/mcp-managed-task",
        claim_state: "assigned",
      });

      const prematureCompletion = await client.callTool({
        name: "manciple_set_status",
        arguments: { task_id: "mcp-managed-task", status: "complete" },
      });
      expect(prematureCompletion.isError).toBe(true);
      expect(payload(prematureCompletion).error).toContain("must be approved");

      const unsafeModeSwitch = await client.callTool({
        name: "manciple_prepare_worktree",
        arguments: { task_id: "mcp-managed-task", use_worktrees: false },
      });
      expect(unsafeModeSwitch.isError).toBe(true);
      expect(payload(unsafeModeSwitch).error).toContain("already has a managed worktree");

      writeFileSync(join(prepared.workspace_path, "feature.txt"), "implemented\n", "utf-8");
      git(prepared.workspace_path, ["add", "feature.txt"]);
      git(prepared.workspace_path, ["commit", "-m", "implement feature"]);
      const runLog = payload(
        await client.callTool({
          name: "manciple_run_log",
          arguments: {
            task_id: "mcp-managed-task",
            workspace: prepared.workspace_path,
            result: "complete",
          },
        }),
      );
      expect(readFileSync(runLog.path, "utf-8")).toContain("- feature.txt");

      const listed = payload(
        await client.callTool({ name: "manciple_list_worktrees", arguments: {} }),
      );
      expect(listed).toHaveLength(1);

      const released = payload(
        await client.callTool({
          name: "manciple_release_worktree",
          arguments: { task_id: "mcp-managed-task" },
        }),
      );
      expect(released.claim_state).toBe("available");

      const removed = payload(
        await client.callTool({
          name: "manciple_remove_worktree",
          arguments: { task_id: "mcp-managed-task", force: true },
        }),
      );
      expect(removed.task_id).toBe("mcp-managed-task");

      const pruned = payload(
        await client.callTool({
          name: "manciple_prune_worktrees",
          arguments: { dry_run: true },
        }),
      );
      expect(pruned).toEqual({ removed_records: [], pruned_git_metadata: false });
    } finally {
      await client.close();
    }
  });
});
