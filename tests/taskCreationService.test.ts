/**
 * Service-level tests for the shared task-creation service.
 *
 * These exercise the service directly (typed results, no printing, no exit)
 * rather than through CLI or MCP adapters.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { loadTasks } from "../src/specs/loadTasks.js";
import type { CreateTaskInput } from "../src/tasks/taskCreationService.js";
import { createTask } from "../src/tasks/taskCreationService.js";
import { getPaths } from "../src/utils/paths.js";

let cwd: string;
let p: ReturnType<typeof getPaths>;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-task-create-"));
  p = getPaths(cwd, ".manciple");
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function baseInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    title: "License expiration reminders",
    type: "implementation",
    domain: "credentialing",
    priority: "high",
    goal: "Add expiration reminder support for provider licenses.",
    activeDir: p.tasksActive,
    ...overrides,
  };
}

/** Write a schema-valid spec directly into a lifecycle tier. */
function writeTierCopy(
  id: string,
  title: string,
  tier: "completed" | "archived",
  status: string,
): void {
  const dir = tier === "completed" ? p.tasksCompleted : p.tasksArchived;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.yaml`),
    [
      `id: ${id}`,
      `title: ${title}`,
      `status: ${status}`,
      "type: implementation",
      "domain: core",
      "priority: medium",
      "depends_on: []",
      "allowed_paths: []",
      "forbidden_paths: []",
      "goal: Pre-existing copy used for duplicate detection.",
      "acceptance_criteria:",
      "  - It exists.",
      "implementation_notes: []",
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

describe("taskCreationService", () => {
  it("creates a task with a slugified id and writes the YAML spec", () => {
    const result = createTask(baseInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.id).toBe("license-expiration-reminders");
    const taskFile = join(p.tasksActive, "license-expiration-reminders.yaml");
    expect(result.filePath).toBe(taskFile);
    expect(existsSync(taskFile)).toBe(true);

    const spec = parse(readFileSync(taskFile, "utf-8")) as Record<string, unknown>;
    expect(spec.id).toBe("license-expiration-reminders");
    expect(spec.title).toBe("License expiration reminders");
    expect(spec.status).toBe("pending");
    expect(spec.type).toBe("implementation");
    expect(spec.domain).toBe("credentialing");
    expect(spec.priority).toBe("high");
    expect(spec.goal).toBe("Add expiration reminder support for provider licenses.");
  });

  it("applies canonical defaults for omitted optional fields", () => {
    const result = createTask({
      title: "Minimal defaults task",
      type: "implementation",
      domain: "core",
      activeDir: p.tasksActive,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const spec = parse(readFileSync(result.filePath, "utf-8")) as Record<string, unknown>;
    expect(spec.priority).toBe("medium");
    expect(spec.depends_on).toEqual([]);
    expect(spec.allowed_paths).toEqual([]);
    expect(spec.forbidden_paths).toEqual([]);
    expect(spec.outputs_required).toEqual(["files_changed", "tests_run", "risks"]);
    expect(spec.notes).toEqual([]);
  });

  it("preserves caller-provided optional fields", () => {
    const result = createTask({
      title: "Rich options task",
      type: "implementation",
      domain: "core",
      priority: "critical",
      goal: "Create a richly specified task.",
      dependsOn: ["other-task"],
      acceptanceCriteria: ["It records design guidance."],
      implementationNotes: ["Preserve CLI and MCP parity."],
      verificationCommands: ["pnpm test"],
      allowedPaths: ["src/tasks/**"],
      forbiddenPaths: ["dist/**"],
      outputsRequired: ["files_changed", "risks"],
      notes: ["A free-form note."],
      activeDir: p.tasksActive,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const spec = parse(readFileSync(result.filePath, "utf-8")) as Record<string, unknown>;
    expect(spec.priority).toBe("critical");
    expect(spec.depends_on).toEqual(["other-task"]);
    expect(spec.allowed_paths).toEqual(["src/tasks/**"]);
    expect(spec.forbidden_paths).toEqual(["dist/**"]);
    expect(spec.outputs_required).toEqual(["files_changed", "risks"]);
    expect(spec.notes).toEqual(["A free-form note."]);
    expect(spec.implementation_notes).toEqual(["Preserve CLI and MCP parity."]);
  });

  it("creates the active directory when it does not exist", () => {
    expect(existsSync(p.tasksActive)).toBe(false);
    const result = createTask(baseInput());
    expect(result.ok).toBe(true);
    expect(existsSync(p.tasksActive)).toBe(true);
  });

  it("detects a duplicate id in the active tier", () => {
    const first = createTask(baseInput());
    expect(first.ok).toBe(true);

    const second = createTask(baseInput());
    expect(second.ok).toBe(false);
    if (second.ok) return;
    if (second.code !== "duplicate") return;
    expect(second.code).toBe("duplicate");
    expect(second.id).toBe("license-expiration-reminders");
    expect(second.existingTier).toBe("active");
    expect(second.existingPath).toBe(join(p.tasksActive, "license-expiration-reminders.yaml"));
  });

  it("detects a duplicate id in the completed tier", () => {
    writeTierCopy(
      "license-expiration-reminders",
      "License expiration reminders",
      "completed",
      "complete",
    );

    const result = createTask(baseInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.code !== "duplicate") return;
    expect(result.code).toBe("duplicate");
    expect(result.existingTier).toBe("completed");
  });

  it("detects a duplicate id in the archived tier", () => {
    writeTierCopy(
      "license-expiration-reminders",
      "License expiration reminders",
      "archived",
      "archived",
    );

    const result = createTask(baseInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.code !== "duplicate") return;
    expect(result.code).toBe("duplicate");
    expect(result.existingTier).toBe("archived");
  });

  it("fails when the title cannot generate an id", () => {
    const result = createTask(baseInput({ title: "!!!" }));
    expect(result).toEqual({
      ok: false,
      code: "invalid_id",
      message: "could not generate a valid id from the provided title.",
    });
    expect(existsSync(join(p.tasksActive, "!.yaml"))).toBe(false);
  });

  it("fails when the goal is whitespace-only", () => {
    const result = createTask(baseInput({ goal: "   " }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("empty_goal");
  });

  it("fails for an invalid task type", () => {
    const result = createTask(baseInput({ type: "not-a-type" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_type");
    expect(result.message).toContain('Invalid type: "not-a-type"');
  });

  it("fails for an invalid priority", () => {
    const result = createTask(baseInput({ priority: "urgent" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_priority");
    expect(result.message).toContain('Invalid priority: "urgent"');
  });

  it("fails when the spec fails schema validation", () => {
    const result = createTask(baseInput({ acceptanceCriteria: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_spec");
    expect(result.message).toContain("Invalid task spec");
    expect(existsSync(join(p.tasksActive, "license-expiration-reminders.yaml"))).toBe(false);
  });

  it("never prints, warns, or exits", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    try {
      const ok = createTask(baseInput());
      expect(ok.ok).toBe(true);
      const duplicate = createTask(baseInput());
      expect(duplicate.ok).toBe(false);
      const invalid = createTask(baseInput({ title: "!!!" }));
      expect(invalid.ok).toBe(false);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("produces tasks discoverable by loadTasks across the canonical tiers", () => {
    const result = createTask(baseInput());
    expect(result.ok).toBe(true);

    const { tasks, errors } = loadTasks(p.specsTasks, "all");
    expect(errors).toEqual([]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].spec.id).toBe("license-expiration-reminders");
    expect(tasks[0].tier).toBe("active");
  });
});
