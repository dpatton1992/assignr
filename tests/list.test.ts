import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listCommand } from "../src/commands/list.js";
import type { TaskTier } from "../src/specs/loadTasks.js";
import { getPaths } from "../src/utils/paths.js";

const tempDirs: string[] = [];

function writeTask(
  root: string,
  tier: TaskTier,
  id: string,
  status = "pending",
  overrides?: Partial<{ domain: string; type: string; priority: string }>,
): void {
  const paths = getPaths(root, ".manciple");
  const dirByTier = {
    active: paths.tasksActive,
    completed: paths.tasksCompleted,
    archived: paths.tasksArchived,
  };
  const dir = dirByTier[tier];
  mkdirSync(dir, { recursive: true });
  const domain = overrides?.domain ?? "core";
  const type = overrides?.type ?? "implementation";
  const priority = overrides?.priority ?? "medium";
  writeFileSync(
    join(dir, `${id}.yaml`),
    [
      `id: ${id}`,
      `title: ${id} title`,
      `status: ${status}`,
      `type: ${type}`,
      `domain: ${domain}`,
      `priority: ${priority}`,
      "depends_on: []",
      "allowed_paths:",
      "  - src/**",
      "forbidden_paths: []",
      `goal: Complete ${id}.`,
      "acceptance_criteria:",
      "  - It works.",
      "verification:",
      "  commands:",
      "    - pnpm test",
      "outputs_required:",
      "  - files_changed",
      "notes: []",
      "",
    ].join("\n"),
    "utf-8",
  );
}

function makeRepo(): { root: string; paths: ReturnType<typeof getPaths> } {
  const root = mkdtempSync(join(tmpdir(), "manciple-list-"));
  tempDirs.push(root);
  return { root, paths: getPaths(root, ".manciple") };
}

describe("listCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a missing selected lifecycle tier as empty when task storage exists", () => {
    const { root, paths } = makeRepo();
    mkdirSync(paths.tasksCompleted, { recursive: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    listCommand(paths.specsTasks, root);

    expect(logSpy.mock.calls.flat().join("\n")).toContain("No tasks found.");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("shows active tasks by default without completed or archived tasks", () => {
    const { root, paths } = makeRepo();
    writeTask(root, "active", "active-task");
    writeTask(root, "completed", "completed-task", "complete");
    writeTask(root, "archived", "archived-task", "blocked");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    listCommand(paths.specsTasks, root);

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("active-task");
    expect(output).not.toContain("completed-task");
    expect(output).not.toContain("archived-task");
  });

  it("requires explicit flags to show completed or archived lifecycle tiers", () => {
    const { root, paths } = makeRepo();
    writeTask(root, "active", "active-task");
    writeTask(root, "completed", "completed-task", "complete");
    writeTask(root, "archived", "archived-task", "blocked");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    listCommand(paths.specsTasks, root, { completed: true });
    listCommand(paths.specsTasks, root, { archived: true });

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("completed-task");
    expect(output).toContain("archived-task");
  });

  it("shows flat table unchanged without --group-by", () => {
    const { root, paths } = makeRepo();
    writeTask(root, "active", "task-one", "pending");
    writeTask(root, "active", "task-two", "complete");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    listCommand(paths.specsTasks, root);

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("ID");
    expect(output).toContain("TITLE");
    expect(output).toContain("STATUS");
    expect(output).toContain("task-one");
    expect(output).toContain("task-two");
    // No group section headers when --group-by is absent
    expect(output).not.toContain("Status:");
    expect(output).not.toContain("Domain:");
  });

  it("groups tasks by status with styled section headers", () => {
    const { root, paths } = makeRepo();
    writeTask(root, "active", "task-pending", "pending");
    writeTask(root, "active", "task-in-progress", "in_progress");
    writeTask(root, "active", "task-complete", "complete");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    listCommand(paths.specsTasks, root, { groupBy: "status" });

    const output = logSpy.mock.calls.flat().join("\n");
    // Column header present
    expect(output).toContain("ID");
    expect(output).toContain("TITLE");
    expect(output).toContain("STATUS");
    // Group headers for each distinct status
    expect(output).toContain("Status: pending");
    expect(output).toContain("Status: in_progress");
    expect(output).toContain("Status: complete");
    // Tasks appear under their groups
    expect(output).toContain("task-pending");
    expect(output).toContain("task-in-progress");
    expect(output).toContain("task-complete");
  });

  it("groups tasks by domain with styled section headers", () => {
    const { root, paths } = makeRepo();
    writeTask(root, "active", "task-core", "pending", { domain: "core" });
    writeTask(root, "active", "task-api", "pending", { domain: "api" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    listCommand(paths.specsTasks, root, { groupBy: "domain" });

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Domain: core");
    expect(output).toContain("Domain: api");
    expect(output).toContain("task-core");
    expect(output).toContain("task-api");
  });

  it("groups tasks by tier with --all flag", () => {
    const { root, paths } = makeRepo();
    writeTask(root, "active", "active-task", "pending");
    writeTask(root, "completed", "completed-task", "complete");
    writeTask(root, "archived", "archived-task", "blocked");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    listCommand(paths.specsTasks, root, { all: true, groupBy: "tier" });

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Tier: active");
    expect(output).toContain("Tier: completed");
    expect(output).toContain("Tier: archived");
    expect(output).toContain("active-task");
    expect(output).toContain("completed-task");
    expect(output).toContain("archived-task");
  });

  it("applies --status filter before grouping by domain", () => {
    const { root, paths } = makeRepo();
    writeTask(root, "active", "task-core-pending", "pending", { domain: "core" });
    writeTask(root, "active", "task-core-complete", "complete", { domain: "core" });
    writeTask(root, "active", "task-api-pending", "pending", { domain: "api" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    listCommand(paths.specsTasks, root, { status: "pending", groupBy: "domain" });

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Domain: core");
    expect(output).toContain("Domain: api");
    expect(output).toContain("task-core-pending");
    expect(output).toContain("task-api-pending");
    // Filtered-out tasks should not appear
    expect(output).not.toContain("task-core-complete");
  });
});
