import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { completeCommand } from "../src/commands/complete.js";
import { initCommand } from "../src/commands/init.js";
import { runLogCommand } from "../src/commands/runLog.js";
import {
  getTaskGraphNeighborhood,
  getTaskGraphPacket,
  TaskGraphError,
} from "../src/graph/taskGraphPacket.js";
import type { TaskSpec } from "../src/specs/schema.js";
import { getPaths } from "../src/utils/paths.js";

let cwd: string;
let p: ReturnType<typeof getPaths>;

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-task-graph-"));
  p = getPaths(cwd, ".manciple");
  await initCommand({ force: false, cwd, root: ".manciple" });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function defaultTask(id: string, overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id,
    title: id,
    status: "needs_review",
    type: "implementation",
    domain: "core",
    priority: "medium",
    depends_on: [],
    blocks: [],
    conflicts_with: [],
    can_run_independently: false,
    allowed_paths: [`src/${id}/**`],
    forbidden_paths: ["dist/"],
    path_ownership: {
      touched_paths: [],
      locked_paths: [],
      unsafe_parallel_areas: [],
    },
    goal: "Assemble a task graph packet for presentation clients.",
    acceptance_criteria: ["The graph packet is fully assembled."],
    implementation_notes: [],
    verification: { commands: ["pnpm test"] },
    outputs_required: ["files_changed", "tests_run", "decisions_made", "risks"],
    notes: [],
    ...overrides,
  };
}

function writeTask(id: string, overrides: Partial<TaskSpec> = {}): void {
  mkdirSync(p.tasksActive, { recursive: true });
  writeFileSync(
    join(p.tasksActive, `${id}.yaml`),
    stringify(defaultTask(id, overrides), { lineWidth: 0 }),
    "utf-8",
  );
}

function writeArchivedTask(id: string, overrides: Partial<TaskSpec> = {}): void {
  mkdirSync(p.tasksArchived, { recursive: true });
  writeFileSync(
    join(p.tasksArchived, `${id}.yaml`),
    stringify(defaultTask(id, { status: "archived", ...overrides }), { lineWidth: 0 }),
    "utf-8",
  );
}

function createCompletedTask(id: string): void {
  writeTask(id, { status: "pending" });
  completeCommand(id, { specsTasksDir: p.specsTasks, completedDir: p.tasksCompleted, cwd });
}

function writeRunLog(taskId: string, options: Parameters<typeof runLogCommand>[5] = {}): void {
  runLogCommand(taskId, p.specsTasks, p.runs, p.promptsGenerated, cwd, options);
}

function graphContext(): { specsTasksDir: string; cwd: string } {
  return { specsTasksDir: p.specsTasks, cwd };
}

describe("getTaskGraphPacket", () => {
  it("assembles fully populated nodes with receipt and verification health", () => {
    writeTask("alpha-node", {
      domain: "core",
      priority: "high",
      allowed_paths: ["src/a.ts", "src/b/**"],
      forbidden_paths: ["dist/", "secret/"],
      path_ownership: {
        touched_paths: ["src/a.ts"],
        locked_paths: ["src/b/locked.ts"],
        unsafe_parallel_areas: ["src/b/unsafe/"],
      },
    });
    writeRunLog("alpha-node", {
      result: "complete",
      filesChanged: ["src/a.ts"],
      commandsRun: ["pnpm test"],
      testsRun: ["pnpm test"],
      decisionsMade: ["Assembled the graph packet."],
      risks: "none",
      followUps: ["none"],
      acceptanceCriteriaEvidence: ["The graph packet is fully assembled.: covered by unit tests."],
      verifyReceipt: JSON.stringify({
        ok: true,
        commands_run: [{ command: "pnpm test", ok: true, exit_code: 0 }],
      }),
    });

    const packet = getTaskGraphPacket({}, graphContext());
    const node = packet.nodes.find((n) => n.taskId === "alpha-node");
    expect(node).toBeDefined();
    expect(node).toMatchObject({
      taskId: "alpha-node",
      title: "alpha-node",
      domain: "core",
      priority: "high",
      tier: "active",
      status: "needs_review",
      allowedPaths: ["src/a.ts", "src/b/**"],
      forbiddenPaths: ["dist/", "secret/"],
      touchedPaths: ["src/a.ts"],
      lockedPaths: ["src/b/locked.ts"],
      unsafeParallelAreas: ["src/b/unsafe/"],
      risks: [],
      hasDetailedReviewPacket: true,
    });
    expect(node?.receipt.present).toBe(true);
    expect(node?.receipt.health).toBe("passing");
    expect(node?.receipt.isLatestSuperseded).toBe(false);
    expect(node?.receipt.latestIdentifier).toMatch(/alpha-node\.md$/);
    expect(node?.receipt.result).toBe("complete");
    expect(node?.verification.health).toBe("passing");
    expect(node?.verification.hasVerification).toBe(true);
    expect(node?.verification.missingCommands).toEqual([]);
    expect(node?.verification.failedCommands).toEqual([]);
  });

  it("includes active tasks plus referenced completed and archived tasks and reports dangling references", () => {
    createCompletedTask("dep-done");
    createCompletedTask("unreferenced-done");
    writeArchivedTask("arch-ref");
    writeTask("other-active");
    writeTask("conflict-task");
    writeTask("main-task", {
      depends_on: ["dep-done", "arch-ref", "missing-ref"],
      blocks: ["other-active"],
      conflicts_with: ["conflict-task"],
    });

    const packet = getTaskGraphPacket({}, graphContext());
    const ids = packet.nodes.map((n) => n.taskId);

    expect(ids).toEqual(["arch-ref", "conflict-task", "dep-done", "main-task", "other-active"]);
    expect(ids).not.toContain("unreferenced-done");
    expect(packet.referencedButAbsent).toEqual(["missing-ref"]);

    expect(packet.nodes.find((n) => n.taskId === "dep-done")).toMatchObject({
      tier: "completed",
      status: "complete",
    });
    expect(packet.nodes.find((n) => n.taskId === "arch-ref")).toMatchObject({
      tier: "archived",
      status: "archived",
    });

    expect(packet.edges.filter((e) => e.type === "depends_on")).toEqual([
      { type: "depends_on", source: "main-task", target: "arch-ref", directed: true },
      { type: "depends_on", source: "main-task", target: "dep-done", directed: true },
      { type: "depends_on", source: "main-task", target: "missing-ref", directed: true },
    ]);
    expect(packet.edges.filter((e) => e.type === "blocks")).toEqual([
      { type: "blocks", source: "main-task", target: "other-active", directed: true },
    ]);
    expect(packet.edges.filter((e) => e.type === "conflicts_with")).toEqual([
      { type: "conflicts_with", source: "conflict-task", target: "main-task", directed: false },
    ]);

    expect(packet.counts).toEqual({
      nodes: 5,
      edges: 5,
      byEdgeType: {
        depends_on: 3,
        blocks: 1,
        conflicts_with: 1,
        ownership_overlap: 0,
      },
    });
    expect(packet.filters).toEqual({
      traversalDepth: 2,
      tier: "active",
      edgeTypes: ["depends_on", "blocks", "conflicts_with", "ownership_overlap"],
      allTasksMode: false,
    });
  });

  it("preserves direction for depends_on and blocks edges and emits conflict pairs exactly once", () => {
    writeTask("edge-a", { depends_on: ["edge-b"], blocks: ["edge-b"], conflicts_with: ["edge-b"] });
    writeTask("edge-b", { conflicts_with: ["edge-a"] });

    const packet = getTaskGraphPacket({}, graphContext());

    expect(packet.edges.filter((e) => e.type === "depends_on")).toEqual([
      { type: "depends_on", source: "edge-a", target: "edge-b", directed: true },
    ]);
    expect(packet.edges.filter((e) => e.type === "blocks")).toEqual([
      { type: "blocks", source: "edge-a", target: "edge-b", directed: true },
    ]);
    expect(packet.edges.filter((e) => e.type === "conflicts_with")).toEqual([
      { type: "conflicts_with", source: "edge-a", target: "edge-b", directed: false },
    ]);
  });

  it("emits ownership-overlap edges with concrete patterns and strength classification", () => {
    writeTask("owner-a", {
      allowed_paths: ["src/shared/**"],
      path_ownership: {
        touched_paths: ["src/touched/**"],
        locked_paths: ["src/shared/secret/**"],
        unsafe_parallel_areas: ["src/unsafe/**"],
      },
    });
    writeTask("owner-b", {
      allowed_paths: ["src/shared/**", "src/touched/**", "src/unsafe/**"],
    });

    const packet = getTaskGraphPacket({}, graphContext());
    const edge = packet.edges.find((e) => e.type === "ownership_overlap");
    expect(edge).toBeDefined();
    expect(edge?.source).toBe("owner-a");
    expect(edge?.target).toBe("owner-b");
    expect(edge?.directed).toBe(false);
    expect(edge?.severity).toBe("locked");
    expect(edge?.matchedPaths).toBeDefined();

    const kinds = edge?.matchedPaths?.map((m) => m.kind);
    expect(kinds).toContain("allowed");
    expect(kinds).toContain("touched");
    expect(kinds).toContain("locked");
    expect(kinds).toContain("unsafe_parallel_area");

    // Strongest collisions sort first.
    expect(edge?.matchedPaths?.[0].kind).toBe("locked");

    // Ordinary allowed-path overlap is classified as allowed, not touched.
    const plainAllowed = edge?.matchedPaths?.find(
      (m) => m.path === "src/shared/**" && m.otherPath === "src/shared/**",
    );
    expect(plainAllowed?.kind).toBe("allowed");

    for (const match of edge?.matchedPaths ?? []) {
      expect(match.path.length).toBeGreaterThan(0);
      expect(match.otherPath.length).toBeGreaterThan(0);
      expect(match.reason).toContain("owner-a");
      expect(match.reason).toContain("owner-b");
    }
  });

  it("distinguishes missing, incomplete, passing, and failing receipt health", () => {
    writeTask("health-missing");

    writeTask("health-incomplete");
    writeRunLog("health-incomplete", {
      filesChanged: ["src/health-incomplete/x.ts"],
      commandsRun: ["pnpm test"],
      testsRun: ["pnpm test"],
    });

    writeTask("health-passing");
    writeRunLog("health-passing", {
      result: "complete",
      filesChanged: ["src/health-passing/x.ts"],
      commandsRun: ["pnpm test"],
      testsRun: ["pnpm test"],
      risks: "none",
      verifyReceipt: JSON.stringify({
        ok: true,
        commands_run: [{ command: "pnpm test", ok: true, exit_code: 0 }],
      }),
    });

    writeTask("health-failing");
    writeRunLog("health-failing", {
      result: "failed",
      filesChanged: ["src/health-failing/x.ts"],
      commandsRun: ["pnpm test"],
      testsRun: ["pnpm test"],
      risks: "Flaky integration test observed.",
    });

    const packet = getTaskGraphPacket({}, graphContext());

    const missing = packet.nodes.find((n) => n.taskId === "health-missing");
    expect(missing?.receipt).toEqual({
      present: false,
      health: "missing",
      isLatestSuperseded: false,
    });
    expect(missing?.verification.health).toBe("missing");

    const incomplete = packet.nodes.find((n) => n.taskId === "health-incomplete");
    expect(incomplete?.receipt.present).toBe(true);
    expect(incomplete?.receipt.health).toBe("incomplete");
    expect(incomplete?.receipt.result).toBeUndefined();
    // A command mention without a recorded result is not classified as passing.
    expect(incomplete?.verification.health).toBe("incomplete");
    expect(incomplete?.verification.hasVerification).toBe(false);

    const passing = packet.nodes.find((n) => n.taskId === "health-passing");
    expect(passing?.receipt.health).toBe("passing");
    expect(passing?.verification.health).toBe("passing");
    expect(passing?.risks).toEqual([]);

    const failing = packet.nodes.find((n) => n.taskId === "health-failing");
    expect(failing?.receipt.health).toBe("failing");
    expect(failing?.verification.health).toBe("failing");
    expect(failing?.verification.failedCommands).toEqual(["pnpm test"]);
    expect(failing?.risks).toEqual(["Flaky integration test observed."]);
  });

  it("bases receipt health on the latest non-superseded run log", () => {
    writeTask("receipt-seq");

    writeRunLog("receipt-seq", {
      result: "complete",
      filesChanged: ["src/receipt-seq/x.ts"],
      commandsRun: ["pnpm test"],
      testsRun: ["pnpm test"],
      risks: "none",
      verifyReceipt: JSON.stringify({
        ok: true,
        commands_run: [{ command: "pnpm test", ok: true, exit_code: 0 }],
      }),
    });
    writeRunLog("receipt-seq", {
      result: "failed",
      filesChanged: ["src/receipt-seq/x.ts"],
      commandsRun: ["pnpm test"],
      testsRun: ["pnpm test"],
    });

    const runLogFiles = readdirSync(p.runs)
      .filter((file) => file.endsWith("receipt-seq.md"))
      .sort();
    expect(runLogFiles).toHaveLength(2);

    let packet = getTaskGraphPacket({}, graphContext());
    let node = packet.nodes.find((n) => n.taskId === "receipt-seq");
    expect(node?.receipt.present).toBe(true);
    expect(node?.receipt.isLatestSuperseded).toBe(false);
    expect(node?.receipt.health).toBe("failing");
    expect(node?.receipt.latestIdentifier).toBe(runLogFiles[1]);

    // A newest run log that is itself superseded is skipped in favor of the
    // latest non-superseded receipt.
    const supersededNewest = "2999-12-31-00-00-00-receipt-seq.md";
    writeFileSync(
      join(p.runs, supersededNewest),
      [
        "# Run Log: receipt-seq",
        "",
        "## Metadata",
        "",
        "- Task ID: receipt-seq",
        "- Latest: true",
        `- Superseded by: ${runLogFiles[1]}`,
        "",
        "## Result",
        "",
        "failed",
        "",
      ].join("\n"),
      "utf-8",
    );

    packet = getTaskGraphPacket({}, graphContext());
    node = packet.nodes.find((n) => n.taskId === "receipt-seq");
    expect(node?.receipt.isLatestSuperseded).toBe(true);
    expect(node?.receipt.health).toBe("failing");
    expect(node?.receipt.latestIdentifier).toBe(runLogFiles[1]);
    expect(node?.receipt.result).toBe("failed");
  });

  it("supports all-tasks mode and tier, status, and domain filters", () => {
    writeTask("filter-a", { domain: "core", status: "pending" });
    writeTask("filter-b", { domain: "api", status: "needs_review" });
    createCompletedTask("filter-done");
    writeArchivedTask("filter-arch");

    const defaults = getTaskGraphPacket({}, graphContext());
    expect(defaults.nodes.map((n) => n.taskId).sort()).toEqual(["filter-a", "filter-b"]);
    expect(defaults.filters.allTasksMode).toBe(false);
    expect(defaults.filters.tier).toBe("active");

    const all = getTaskGraphPacket({ allTasks: true }, graphContext());
    expect(all.nodes.map((n) => n.taskId).sort()).toEqual([
      "filter-a",
      "filter-arch",
      "filter-b",
      "filter-done",
    ]);
    expect(all.filters.allTasksMode).toBe(true);
    expect(all.filters.tier).toBe("all");

    const completed = getTaskGraphPacket({ allTasks: true, tier: "completed" }, graphContext());
    expect(completed.nodes.map((n) => n.taskId)).toEqual(["filter-done"]);
    expect(completed.filters.tier).toBe("completed");

    const statusFiltered = getTaskGraphPacket({ status: "needs_review" }, graphContext());
    expect(statusFiltered.nodes.map((n) => n.taskId)).toEqual(["filter-b"]);
    expect(statusFiltered.filters.status).toBe("needs_review");

    const domainFiltered = getTaskGraphPacket({ domain: "core" }, graphContext());
    expect(domainFiltered.nodes.map((n) => n.taskId)).toEqual(["filter-a"]);
    expect(domainFiltered.filters.domain).toBe("core");
  });

  it("returns an empty graph when no tasks match", () => {
    const packet = getTaskGraphPacket({}, graphContext());

    expect(packet.nodes).toEqual([]);
    expect(packet.edges).toEqual([]);
    expect(packet.referencedButAbsent).toEqual([]);
    expect(packet.counts).toEqual({
      nodes: 0,
      edges: 0,
      byEdgeType: {
        depends_on: 0,
        blocks: 0,
        conflicts_with: 0,
        ownership_overlap: 0,
      },
    });
  });

  it("handles dependency and block cycles without unbounded traversal", () => {
    writeTask("cyc-a", { depends_on: ["cyc-b"], blocks: ["cyc-b"] });
    writeTask("cyc-b", { depends_on: ["cyc-a"], blocks: ["cyc-a"] });

    const packet = getTaskGraphPacket({}, graphContext());
    expect(packet.nodes.map((n) => n.taskId)).toEqual(["cyc-a", "cyc-b"]);
    expect(packet.edges.filter((e) => e.type === "depends_on")).toEqual([
      { type: "depends_on", source: "cyc-a", target: "cyc-b", directed: true },
      { type: "depends_on", source: "cyc-b", target: "cyc-a", directed: true },
    ]);

    const neighborhood = getTaskGraphNeighborhood("cyc-a", { depth: 10 }, graphContext());
    expect(neighborhood.nodes.map((n) => n.taskId)).toEqual(["cyc-a", "cyc-b"]);
    expect(neighborhood.counts.edges).toBe(4);
  });

  it("orders nodes, edges, and metadata deterministically and stays JSON-safe", () => {
    writeTask("det-a", { depends_on: ["det-b"] });
    writeTask("det-b");
    writeTask("det-c", { conflicts_with: ["det-a"] });

    const first = getTaskGraphPacket({}, graphContext());
    const second = getTaskGraphPacket({}, graphContext());

    expect(second).toEqual(first);
    expect(first.nodes.map((n) => n.taskId)).toEqual([...first.nodes.map((n) => n.taskId)].sort());
    expect(first.edges.map((e) => `${e.type}:${e.source}->${e.target}`)).toEqual([
      "depends_on:det-a->det-b",
      "conflicts_with:det-a->det-c",
    ]);

    expect(() => JSON.stringify(first)).not.toThrow();
    expect(JSON.stringify(first)).not.toContain(cwd);
  });

  it("supports edge-type filtering in the full graph", () => {
    writeTask("typed-a", { depends_on: ["typed-b"], conflicts_with: ["typed-c"] });
    writeTask("typed-b");
    writeTask("typed-c");

    const packet = getTaskGraphPacket({ edgeTypes: ["depends_on"] }, graphContext());
    expect(packet.filters.edgeTypes).toEqual(["depends_on"]);
    expect(packet.edges).toEqual([
      { type: "depends_on", source: "typed-a", target: "typed-b", directed: true },
    ]);
  });
});

describe("getTaskGraphNeighborhood", () => {
  it("traverses both incoming and outgoing edges up to the requested depth", () => {
    writeTask("hub", { depends_on: ["mid"] });
    writeTask("mid", { depends_on: ["leaf"] });
    writeTask("leaf");
    writeTask("incoming", { depends_on: ["hub"] });

    const depthOne = getTaskGraphNeighborhood("hub", { depth: 1 }, graphContext());
    expect(depthOne.nodes.map((n) => n.taskId)).toEqual(["hub", "incoming", "mid"]);
    expect(depthOne.filters.traversalDepth).toBe(1);

    const depthTwo = getTaskGraphNeighborhood("hub", { depth: 2 }, graphContext());
    expect(depthTwo.nodes.map((n) => n.taskId)).toEqual(["hub", "incoming", "leaf", "mid"]);
    expect(depthTwo.filters.traversalDepth).toBe(2);

    const unbounded = getTaskGraphNeighborhood("hub", { depth: -1 }, graphContext());
    expect(unbounded.nodes.map((n) => n.taskId)).toEqual(["hub", "incoming", "leaf", "mid"]);
    expect(unbounded.filters.traversalDepth).toBe(-1);
  });

  it("restricts neighborhood traversal to selected edge types", () => {
    writeTask("hub", { depends_on: ["mid"], conflicts_with: ["rival"] });
    writeTask("mid");
    writeTask("rival");

    const packet = getTaskGraphNeighborhood(
      "hub",
      { depth: 2, edgeTypes: ["depends_on"] },
      graphContext(),
    );
    expect(packet.nodes.map((n) => n.taskId)).toEqual(["hub", "mid"]);
    expect(packet.edges.every((e) => e.type === "depends_on")).toBe(true);
  });

  it("throws for a focus task that is not part of the graph", () => {
    writeTask("only-task");

    expect(() => getTaskGraphNeighborhood("ghost", {}, graphContext())).toThrow(TaskGraphError);
    expect(() => getTaskGraphNeighborhood("ghost", {}, graphContext())).toThrow(
      "Task not found in graph: ghost",
    );
  });

  it("records the focus task and depth in filter metadata", () => {
    writeTask("hub", { depends_on: ["mid"] });
    writeTask("mid");

    const packet = getTaskGraphNeighborhood("hub", { depth: 1 }, graphContext());
    expect(packet.filters.focusTask).toBe("hub");
    expect(packet.filters.traversalDepth).toBe(1);
  });
});
