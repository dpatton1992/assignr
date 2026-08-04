import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LoadedTask } from "../src/specs/schema.js";
import { validateTasks } from "../src/specs/validateTasks.js";

function makeTask(overrides: Partial<LoadedTask["spec"]> = {}): LoadedTask {
  return {
    filePath: `/fake/${overrides.id ?? "test-task"}.yaml`,
    spec: {
      id: "test-task",
      title: "Test Task",
      status: "pending",
      type: "implementation",
      domain: "core",
      priority: "medium",
      depends_on: [],
      blocks: [],
      conflicts_with: [],
      can_run_independently: false,
      allowed_paths: ["src/**"],
      forbidden_paths: ["src/auth/**"],
      path_ownership: {
        touched_paths: [],
        locked_paths: [],
        unsafe_parallel_areas: [],
      },
      goal: "Do something.",
      acceptance_criteria: ["It works."],
      verification: { commands: ["pnpm test"] },
      outputs_required: ["files_changed"],
      implementation_notes: ["Preserve existing behavior."],
      notes: ["Keep it simple."],
      ...overrides,
    },
  };
}

describe("validateTasks", () => {
  it("returns valid tasks with no issues", () => {
    const tasks = [makeTask(), makeTask({ id: "other-task", title: "Other" })];
    const { valid, invalid, warnings, counts } = validateTasks(tasks);
    expect(valid).toHaveLength(2);
    expect(invalid).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(counts.tasksChecked).toBe(2);
    expect(counts.domainsChecked).toBe(0);
    expect(counts.contractsChecked).toBeGreaterThan(0);
  });

  it("reports duplicate task ids", () => {
    const tasks = [
      makeTask({ id: "dup" }),
      { filePath: "/fake/dup-2.yaml", spec: { ...makeTask({ id: "dup" }).spec } },
    ];
    const { invalid } = validateTasks(tasks);
    // The second file with a duplicate id should be flagged
    const dupError = invalid.find((i) => i.errors.some((e) => e.message.includes("Duplicate")));
    expect(dupError).toBeDefined();
  });

  it("reports missing dependency", () => {
    const tasks = [makeTask({ id: "child", depends_on: ["missing-parent"] })];
    const { invalid } = validateTasks(tasks);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].errors[0].message).toContain("missing-parent");
  });

  it("passes when dependency exists", () => {
    const tasks = [makeTask({ id: "parent" }), makeTask({ id: "child", depends_on: ["parent"] })];
    const { valid, invalid } = validateTasks(tasks);
    expect(invalid).toHaveLength(0);
    expect(valid).toHaveLength(2);
  });

  it("passes valid graph declarations and independent tasks", () => {
    const tasks = [
      makeTask({ id: "setup" }),
      makeTask({ id: "deploy" }),
      makeTask({
        id: "graph-task",
        depends_on: ["setup"],
        blocks: ["deploy"],
        conflicts_with: ["deploy"],
        can_run_independently: true,
      }),
      makeTask({
        id: "solo-task",
        can_run_independently: true,
      }),
    ];

    const { valid, invalid, warnings } = validateTasks(tasks);

    expect(invalid).toHaveLength(0);
    expect(valid).toHaveLength(4);
    expect(warnings.map((warning) => warning.field)).not.toContain("depends_on");
  });

  it("reports missing graph references on field-specific errors", () => {
    const tasks = [
      makeTask({
        id: "graph-task",
        blocks: ["missing-blocked-task"],
        conflicts_with: ["missing-conflict-task"],
      }),
    ];

    const { invalid } = validateTasks(tasks);

    expect(invalid).toHaveLength(1);
    expect(invalid[0].errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "blocks",
          message: expect.stringContaining("missing-blocked-task"),
        }),
        expect.objectContaining({
          field: "conflicts_with",
          message: expect.stringContaining("missing-conflict-task"),
        }),
      ]),
    );
  });

  it("reports self-conflicts on conflicts_with", () => {
    const tasks = [
      makeTask({
        id: "graph-task",
        conflicts_with: ["graph-task"],
      }),
    ];

    const { invalid } = validateTasks(tasks);

    expect(invalid).toHaveLength(1);
    expect(invalid[0].errors).toEqual([
      expect.objectContaining({
        field: "conflicts_with",
        message: expect.stringContaining("cannot conflict with itself"),
      }),
    ]);
  });

  it("accepts path ownership metadata", () => {
    const tasks = [
      makeTask({
        id: "owner-task",
        path_ownership: {
          touched_paths: ["src/specs/schema.ts"],
          locked_paths: ["src/specs/validateTasks.ts"],
          unsafe_parallel_areas: ["tests/validateTasks.test.ts"],
        },
      }),
    ];

    const { valid, invalid } = validateTasks(tasks);

    expect(invalid).toHaveLength(0);
    expect(valid[0].spec.path_ownership).toEqual({
      touched_paths: ["src/specs/schema.ts"],
      locked_paths: ["src/specs/validateTasks.ts"],
      unsafe_parallel_areas: ["tests/validateTasks.test.ts"],
    });
  });

  it("reports missing domain references when a domains directory is provided", () => {
    const domainsDir = mkdtempSync(join(tmpdir(), "manciple-domains-"));
    const tasks = [makeTask({ id: "child", domain: "missing-domain" })];

    try {
      const { invalid } = validateTasks(tasks, { specsDomainsDir: domainsDir });

      expect(invalid).toHaveLength(1);
      expect(invalid[0].errors[0].field).toBe("domain");
      expect(invalid[0].errors[0].message).toContain("child");
      expect(invalid[0].errors[0].message).toContain("missing-domain");
    } finally {
      rmSync(domainsDir, { recursive: true, force: true });
    }
  });

  it("passes when domain references resolve", () => {
    const domainsDir = mkdtempSync(join(tmpdir(), "manciple-domains-"));
    writeFileSync(join(domainsDir, "core.yaml"), "id: core\n");

    try {
      const { valid, invalid, counts } = validateTasks([makeTask()], {
        specsDomainsDir: domainsDir,
      });

      expect(invalid).toHaveLength(0);
      expect(valid).toHaveLength(1);
      expect(counts.domainsChecked).toBe(1);
    } finally {
      rmSync(domainsDir, { recursive: true, force: true });
    }
  });

  it("warns about empty optional fields (not depends_on)", () => {
    const tasks = [
      makeTask({
        allowed_paths: [],
        forbidden_paths: [],
        outputs_required: [],
        implementation_notes: [],
        notes: [],
      }),
    ];
    const { warnings } = validateTasks(tasks);
    expect(warnings.length).toBeGreaterThan(0);
    const fields = warnings.map((w) => w.field);
    expect(fields).toContain("allowed_paths");
    expect(fields).toContain("forbidden_paths");
    expect(fields).toContain("outputs_required");
    expect(fields).toContain("implementation_notes");
    expect(fields).toContain("notes");
    // depends_on is not warned about — having no dependencies is valid.
    expect(fields).not.toContain("depends_on");
  });
});
