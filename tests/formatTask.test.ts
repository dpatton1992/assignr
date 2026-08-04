import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { formatTaskById } from "../src/commands/formatTask.js";
import { setStatusCommand } from "../src/commands/setStatus.js";
import type { TaskTier } from "../src/specs/loadTasks.js";
import { getPaths } from "../src/utils/paths.js";
import { formatYamlDocument } from "../src/utils/yamlFormat.js";

const tempDirs: string[] = [];

function writeTask(root: string, tier: TaskTier, id: string, status = "pending"): string {
  const paths = getPaths(root, ".manciple");
  const dirs = {
    active: paths.tasksActive,
    completed: paths.tasksCompleted,
    archived: paths.tasksArchived,
  };
  mkdirSync(dirs[tier], { recursive: true });
  const filePath = join(dirs[tier], `${id}.yaml`);
  writeFileSync(
    filePath,
    [
      `id: ${id}`,
      `title: ${id}`,
      `status: ${status}`,
      "type: implementation",
      "domain: core",
      "priority: medium",
      "depends_on: []",
      "allowed_paths: [src/alpha.ts, src/beta.ts, src/gamma.ts]",
      "forbidden_paths: []",
      "goal: Keep task YAML deterministic.",
      "acceptance_criteria: [Task YAML is formatted deterministically.]",
      "implementation_notes: []",
      "verification: { commands: [pnpm test -- format] }",
      "outputs_required: [files_changed, tests_run, risks]",
      "notes: []",
      "",
    ].join("\n"),
    "utf-8",
  );
  return filePath;
}

describe("formatTaskById", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("formats one active task YAML file by task id", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-format-task-"));
    tempDirs.push(root);
    const paths = getPaths(root, ".manciple");
    const filePath = writeTask(root, "active", "active-task");

    const result = formatTaskById("active-task", {
      specsTasksDir: paths.specsTasks,
      cwd: root,
    });

    const raw = readFileSync(filePath, "utf-8");
    expect(result).toEqual({
      checked: true,
      changed: true,
      file: ".manciple/tasks/active/active-task.yaml",
      errors: [],
    });
    expect(raw).toBe(formatYamlDocument(parse(raw)));
  });

  it("reports check-only failures without writing changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-format-task-check-"));
    tempDirs.push(root);
    const paths = getPaths(root, ".manciple");
    const filePath = writeTask(root, "active", "check-task");
    const original = readFileSync(filePath, "utf-8");

    const result = formatTaskById("check-task", {
      specsTasksDir: paths.specsTasks,
      cwd: root,
      checkOnly: true,
    });

    expect(result.changed).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe(original);
  });

  it("finds completed and archived tasks across lifecycle tiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-format-task-tiers-"));
    tempDirs.push(root);
    const paths = getPaths(root, ".manciple");
    const completedPath = writeTask(root, "completed", "completed-task", "complete");
    const archivedPath = writeTask(root, "archived", "archived-task", "archived");

    expect(
      formatTaskById("completed-task", {
        specsTasksDir: paths.specsTasks,
        cwd: root,
      }),
    ).toMatchObject({ changed: true, file: ".manciple/tasks/completed/completed-task.yaml" });
    expect(
      formatTaskById("archived-task", {
        specsTasksDir: paths.specsTasks,
        cwd: root,
      }),
    ).toMatchObject({ changed: true, file: ".manciple/tasks/archived/archived-task.yaml" });
    expect(readFileSync(completedPath, "utf-8")).toBe(
      formatYamlDocument(parse(readFileSync(completedPath, "utf-8"))),
    );
    expect(readFileSync(archivedPath, "utf-8")).toBe(
      formatYamlDocument(parse(readFileSync(archivedPath, "utf-8"))),
    );
  });

  it("returns a missing task error", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-format-task-missing-"));
    tempDirs.push(root);
    const paths = getPaths(root, ".manciple");
    writeTask(root, "active", "present-task");

    expect(() =>
      formatTaskById("missing-task", {
        specsTasksDir: paths.specsTasks,
        cwd: root,
      }),
    ).toThrow("Task not found: missing-task");
  });

  it("CLI check targets only the requested task", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-format-task-cli-"));
    tempDirs.push(root);
    writeTask(root, "active", "dirty-task");
    const cleanPath = writeTask(root, "active", "clean-task");
    writeFileSync(cleanPath, formatYamlDocument(parse(readFileSync(cleanPath, "utf-8"))), "utf-8");

    const tsxBin = join(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx",
    );
    const result = spawnSync(
      tsxBin,
      [join(process.cwd(), "src", "cli.ts"), "format-task", "clean-task", "--check"],
      {
        cwd: root,
        encoding: "utf-8",
        shell: process.platform === "win32",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Checked: .manciple/tasks/active/clean-task.yaml");
  });

  it("keeps set-status writes on the canonical YAML formatter", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-format-task-status-"));
    tempDirs.push(root);
    const paths = getPaths(root, ".manciple");
    const filePath = writeTask(root, "active", "status-task");

    setStatusCommand("status-task", "in_progress", paths.specsTasks, root);

    const raw = readFileSync(filePath, "utf-8");
    expect(raw).toBe(formatYamlDocument(parse(raw)));
    expect((parse(raw) as Record<string, unknown>).status).toBe("in_progress");
  });

  it("CLI new writes implementation notes when provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-new-task-"));
    tempDirs.push(root);
    const tsxBin = join(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx",
    );

    const result = spawnSync(
      tsxBin,
      [
        join(process.cwd(), "src", "cli.ts"),
        "new",
        "Design Contract",
        "--goal",
        "Create a task with design guidance.",
        "--implementation-note",
        "Preserve CLI and MCP parity.",
      ],
      {
        cwd: root,
        encoding: "utf-8",
        shell: process.platform === "win32",
      },
    );

    expect(result.status).toBe(0);
    const raw = readFileSync(
      join(root, ".manciple", "tasks", "active", "design-contract.yaml"),
      "utf-8",
    );
    expect((parse(raw) as Record<string, unknown>).implementation_notes).toEqual([
      "Preserve CLI and MCP parity.",
    ]);
  });
});
