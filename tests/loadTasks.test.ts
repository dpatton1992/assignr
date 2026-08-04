import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskTier } from "../src/specs/loadTasks.js";
import { loadTasks } from "../src/specs/loadTasks.js";
import { getPaths } from "../src/utils/paths.js";

function makeTaskYaml(id: string, status = "pending"): string {
  return [
    `id: ${id}`,
    `title: ${id} title`,
    `status: ${status}`,
    "type: implementation",
    "domain: core",
    "priority: medium",
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
  ].join("\n");
}

function writeTask(paths: ReturnType<typeof getPaths>, tier: TaskTier, id: string): void {
  const dirByTier = {
    active: paths.tasksActive,
    completed: paths.tasksCompleted,
    archived: paths.tasksArchived,
  };
  const dir = dirByTier[tier];
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.yaml`), makeTaskYaml(id));
}

describe("getPaths", () => {
  it("exposes lifecycle task tier directories and keeps specsTasks", () => {
    const paths = getPaths("/repo", ".manciple");

    expect(paths.specsTasks).toBe(join("/repo", ".manciple", "specs", "tasks"));
    expect(paths.tasksActive).toBe(join("/repo", ".manciple", "tasks", "active"));
    expect(paths.tasksCompleted).toBe(join("/repo", ".manciple", "tasks", "completed"));
    expect(paths.tasksArchived).toBe(join("/repo", ".manciple", "tasks", "archived"));
  });
});

describe("loadTasks", () => {
  it("defaults to active tasks only and includes the tier", () => {
    const cwd = mkdtempSync(join(tmpdir(), "manciple-load-tasks-"));
    const paths = getPaths(cwd, ".manciple");

    try {
      writeTask(paths, "active", "active-task");
      writeTask(paths, "completed", "completed-task");

      const { tasks, errors } = loadTasks(paths.specsTasks);

      expect(errors).toEqual([]);
      expect(tasks.map((task) => task.spec.id)).toEqual(["active-task"]);
      expect(tasks[0].tier).toBe("active");
      expect(tasks[0].filePath).toBe(join(paths.tasksActive, "active-task.yaml"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("loads a requested task tier", () => {
    const cwd = mkdtempSync(join(tmpdir(), "manciple-load-tasks-"));
    const paths = getPaths(cwd, ".manciple");

    try {
      writeTask(paths, "active", "active-task");
      writeTask(paths, "completed", "completed-task");

      const { tasks, errors } = loadTasks(paths.specsTasks, "completed");

      expect(errors).toEqual([]);
      expect(tasks.map((task) => task.spec.id)).toEqual(["completed-task"]);
      expect(tasks[0].tier).toBe("completed");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("loads archived tasks only when the archived tier is requested", () => {
    const cwd = mkdtempSync(join(tmpdir(), "manciple-load-tasks-"));
    const paths = getPaths(cwd, ".manciple");

    try {
      writeTask(paths, "active", "active-task");
      writeTask(paths, "archived", "archived-task");

      const { tasks, errors } = loadTasks(paths.specsTasks, "archived");

      expect(errors).toEqual([]);
      expect(tasks.map((task) => task.spec.id)).toEqual(["archived-task"]);
      expect(tasks[0].tier).toBe("archived");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("loads all task tiers and skips missing directories", () => {
    const cwd = mkdtempSync(join(tmpdir(), "manciple-load-tasks-"));
    const paths = getPaths(cwd, ".manciple");

    try {
      writeTask(paths, "active", "active-task");
      writeTask(paths, "archived", "archived-task");

      const { tasks, errors } = loadTasks(paths.specsTasks, "all");

      expect(errors).toEqual([]);
      expect(tasks.map((task) => task.spec.id)).toEqual(["active-task", "archived-task"]);
      expect(tasks.map((task) => task.tier)).toEqual(["active", "archived"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("loads legacy tasks without implementation_notes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "manciple-load-tasks-"));
    const paths = getPaths(cwd, ".manciple");

    try {
      writeTask(paths, "active", "legacy-task");

      const { tasks, errors } = loadTasks(paths.specsTasks);

      expect(errors).toEqual([]);
      expect(tasks[0].spec.implementation_notes).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
