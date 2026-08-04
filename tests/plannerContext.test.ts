import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPlannerContext, plannerContextCommand } from "../src/commands/plannerContext.js";
import type { TaskTier } from "../src/specs/loadTasks.js";
import { getPaths } from "../src/utils/paths.js";

const tempDirs: string[] = [];

interface WriteTaskOptions {
  status?: string;
  type?: string;
  domain?: string;
  priority?: string;
  dependsOn?: string[];
  conflictsWith?: string[];
  allowedPaths?: string[];
  goal?: string;
  acceptanceCriteria?: string[];
  notes?: string[];
}

function yamlList(values: string[]): string[] {
  if (values.length === 0) return [" []"];
  return ["", ...values.map((value) => `  - ${value}`)];
}

function writeTask(root: string, tier: TaskTier, id: string, options: WriteTaskOptions = {}): void {
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
      `title: ${id} title`,
      `status: ${options.status ?? "pending"}`,
      `type: ${options.type ?? "implementation"}`,
      `domain: ${options.domain ?? "core"}`,
      `priority: ${options.priority ?? "medium"}`,
      `depends_on:${yamlList(options.dependsOn ?? []).join("\n")}`,
      "blocks: []",
      `conflicts_with:${yamlList(options.conflictsWith ?? []).join("\n")}`,
      `allowed_paths:${yamlList(options.allowedPaths ?? ["src/app.ts"]).join("\n")}`,
      "forbidden_paths: []",
      `goal: ${options.goal ?? `Complete ${id}.`}`,
      `acceptance_criteria:${yamlList(options.acceptanceCriteria ?? ["Full private criterion should stay out of compact context."]).join("\n")}`,
      "verification:",
      "  commands:",
      "    - pnpm test",
      "outputs_required:",
      "  - files_changed",
      `notes:${yamlList(options.notes ?? ["Private run-log style body should stay out."]).join("\n")}`,
      "",
    ].join("\n"),
    "utf-8",
  );
}

function makeRepo(): { root: string; paths: ReturnType<typeof getPaths> } {
  const root = mkdtempSync(join(tmpdir(), "manciple-planner-context-"));
  tempDirs.push(root);
  return { root, paths: getPaths(root, ".manciple") };
}

describe("buildPlannerContext", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to active tasks and omits completed and archived lifecycle tiers", () => {
    const { root, paths } = makeRepo();
    writeTask(root, "active", "active-task");
    writeTask(root, "completed", "completed-task", { status: "complete" });
    writeTask(root, "archived", "archived-task", { status: "blocked" });

    const result = buildPlannerContext(paths.specsTasks);

    expect(result.output).toContain("tier: active");
    expect(result.output).toContain("active-task");
    expect(result.output).not.toContain("completed-task");
    expect(result.output).not.toContain("archived-task");
  });

  it("includes completed or archived tasks only when explicitly requested", () => {
    const { root, paths } = makeRepo();
    writeTask(root, "active", "active-task");
    writeTask(root, "completed", "completed-task", { status: "complete" });
    writeTask(root, "archived", "archived-task", { status: "blocked" });

    const completed = buildPlannerContext(paths.specsTasks, { completed: true });
    const archived = buildPlannerContext(paths.specsTasks, { archived: true });
    const all = buildPlannerContext(paths.specsTasks, { all: true });

    expect(completed.output).toContain("completed-task");
    expect(completed.output).not.toContain("active-task");
    expect(archived.output).toContain("archived-task");
    expect(archived.output).not.toContain("active-task");
    expect(all.output).toContain("active-task");
    expect(all.output).toContain("completed-task");
    expect(all.output).toContain("archived-task");
  });

  it("prints compact index fields without full task bodies", () => {
    const { root, paths } = makeRepo();
    writeTask(root, "active", "compact-task", {
      status: "in_progress",
      type: "test",
      domain: "payments",
      priority: "critical",
      dependsOn: ["upstream-a", "upstream-b"],
      conflictsWith: ["other-task"],
      allowedPaths: ["src/payments/", "tests/payments.test.ts", "docs/payments.md", "README.md"],
      goal: "Ship a focused planner summary.",
      acceptanceCriteria: ["This acceptance criterion is intentionally not planner context."],
      notes: ["Run log body should not appear in planner context."],
    });

    const result = buildPlannerContext(paths.specsTasks);

    expect(result.output).toContain(
      "compact-task [in_progress/test/payments/critical] deps:2 conflicts:1",
    );
    expect(result.output).toContain(
      "paths:src/payments/, tests/payments.test.ts, docs/payments.md (+1)",
    );
    expect(result.output).toContain("goal: Ship a focused planner summary.");
    expect(result.output).not.toContain(
      "This acceptance criterion is intentionally not planner context.",
    );
    expect(result.output).not.toContain("Run log body should not appear in planner context.");
    expect(result.output).not.toContain("verification:");
  });

  it("highlights likely allowed-path overlaps by task id and path summary", () => {
    const { root, paths } = makeRepo();
    writeTask(root, "active", "api-task", {
      allowedPaths: ["src/api/"],
    });
    writeTask(root, "active", "api-test-task", {
      allowedPaths: ["src/api/users.ts", "tests/api.test.ts"],
    });
    writeTask(root, "active", "docs-task", {
      allowedPaths: ["docs/"],
    });

    const result = buildPlannerContext(paths.specsTasks);

    expect(result.output).toContain("Likely overlaps:");
    expect(result.output).toContain("api-task <-> api-test-task");
    expect(result.output).toContain("paths:src/api/");
    expect(result.output).not.toContain("api-task <-> docs-task");
  });

  it("truncates and warns when a character budget is exceeded", () => {
    const { root, paths } = makeRepo();
    writeTask(root, "active", "alpha-task", {
      goal: "Alpha task has a reasonably long goal for budget testing.",
    });
    writeTask(root, "active", "bravo-task", {
      goal: "Bravo task should be omitted when the context budget is small.",
    });

    const result = buildPlannerContext(paths.specsTasks, { maxChars: 380 });

    expect(result.truncated).toBe(true);
    expect(result.output).toContain("Estimated context size:");
    expect(result.output).toContain("Warning: Planner context truncated");
    expect(result.output).toContain("alpha-task");
    expect(result.output).not.toContain("bravo-task");
  });

  it("converts token budgets using the documented four character estimate", () => {
    const { root, paths } = makeRepo();
    writeTask(root, "active", "alpha-task");
    writeTask(root, "active", "bravo-task");

    const result = buildPlannerContext(paths.specsTasks, { maxTokens: 65 });

    expect(result.budgetChars).toBe(260);
    expect(result.output).toContain("4 chars/token");
  });
});

describe("plannerContextCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits in strict mode when budget truncation occurs", () => {
    const { root, paths } = makeRepo();
    writeTask(root, "active", "alpha-task");
    writeTask(root, "active", "bravo-task");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    expect(() =>
      plannerContextCommand(paths.specsTasks, root, { maxChars: 320, strict: true }),
    ).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy.mock.calls.flat().join("\n")).toContain("Warning: Planner context truncated");
  });
});
