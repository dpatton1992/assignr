import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { stringify } from "yaml";
import { render as inkTestRender, cleanup as inkTestingCleanup } from "ink-testing-library";
import { render as inkRender } from "ink";

import type {
  ReviewDecisionId,
  ReviewPacket,
  ReviewQueueRow,
  ReviewQueueSummary,
} from "../src/review/reviewPacket.js";
import type { ReviewService } from "../src/tui/service.js";
import type { GraphService } from "../src/tui/graphService.js";
import { createGraphService } from "../src/tui/graphService.js";
import { ReviewTui } from "../src/tui/app.js";
import type { ReviewTuiSession } from "../src/tui/app.js";
import { computeLayout, findCycles, upstreamNeighbors, downstreamNeighbors } from "../src/tui/graphLayout.js";
import type { GraphTaskNode, GraphEdge, EdgeType, TaskGraphOptions, TaskGraphPacket } from "../src/graph/taskGraphPacket.js";
import { TaskGraphError } from "../src/graph/taskGraphPacket.js";
import { initCommand } from "../src/commands/init.js";
import { newCommand } from "../src/commands/new.js";
import { getPaths } from "../src/utils/paths.js";

// ── Fixture helpers ───────────────────────────────────────────────────────

const FAKE_CWD = "/tmp/fake-repo";

function node(id: string, overrides: Partial<GraphTaskNode> = {}): GraphTaskNode {
  return {
    taskId: id,
    title: `Task ${id}`,
    domain: "core",
    priority: "medium",
    tier: "active",
    status: "needs_review",
    allowedPaths: [],
    forbiddenPaths: [],
    touchedPaths: [],
    lockedPaths: [],
    unsafeParallelAreas: [],
    receipt: { present: false, health: "missing", isLatestSuperseded: false },
    verification: { health: "missing", hasVerification: false, missingCommands: [], failedCommands: [] },
    risks: [],
    hasDetailedReviewPacket: true,
    ...overrides,
  };
}

function edge(type: EdgeType, source: string, target: string, overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    type,
    source,
    target,
    directed: type === "depends_on" || type === "blocks",
    ...overrides,
  };
}

function packet(nodes: GraphTaskNode[], edges: GraphEdge[], overrides: Partial<TaskGraphPacket> = {}): TaskGraphPacket {
  const byEdgeType: Record<EdgeType, number> = { depends_on: 0, blocks: 0, conflicts_with: 0, ownership_overlap: 0 };
  for (const entry of edges) byEdgeType[entry.type] += 1;
  return {
    nodes,
    edges,
    counts: { nodes: nodes.length, edges: edges.length, byEdgeType },
    filters: {
      traversalDepth: 2,
      tier: "active",
      edgeTypes: ["depends_on", "blocks", "conflicts_with", "ownership_overlap"],
      allTasksMode: false,
    },
    referencedButAbsent: [],
    ...overrides,
  };
}

function richNodes(): GraphTaskNode[] {
  return [
    node("alpha", {
      status: "needs_review",
      lockedPaths: ["src/shared/secret/**"],
      unsafeParallelAreas: ["src/unsafe/**"],
      receipt: { present: true, health: "passing", isLatestSuperseded: false, latestIdentifier: "alpha.md", result: "complete" },
      verification: { health: "passing", hasVerification: true, missingCommands: [], failedCommands: [] },
    }),
    node("beta", {
      status: "complete",
      receipt: { present: true, health: "passing", isLatestSuperseded: false, latestIdentifier: "beta.md", result: "complete" },
      verification: { health: "passing", hasVerification: true, missingCommands: [], failedCommands: [] },
    }),
    node("gamma", {
      status: "blocked",
      receipt: { present: true, health: "failing", isLatestSuperseded: false, latestIdentifier: "gamma.md", result: "failed" },
      verification: { health: "failing", hasVerification: true, missingCommands: [], failedCommands: ["pnpm test"] },
      risks: ["Flaky test observed."],
    }),
    node("delta", {
      status: "pending",
      receipt: { present: false, health: "missing", isLatestSuperseded: false },
      verification: { health: "missing", hasVerification: false, missingCommands: ["pnpm test"], failedCommands: [] },
    }),
    node("epsilon", {
      status: "needs_review",
      receipt: { present: true, health: "incomplete", isLatestSuperseded: false, latestIdentifier: "epsilon.md" },
      verification: { health: "incomplete", hasVerification: false, missingCommands: ["pnpm build"], failedCommands: [] },
    }),
    node("zeta", {
      status: "complete",
      tier: "completed",
      receipt: { present: true, health: "passing", isLatestSuperseded: false, latestIdentifier: "zeta.md", result: "complete" },
      verification: { health: "passing", hasVerification: true, missingCommands: [], failedCommands: [] },
    }),
    node("omega", {
      status: "needs_review",
      receipt: { present: false, health: "missing", isLatestSuperseded: false },
      verification: { health: "missing", hasVerification: false, missingCommands: [], failedCommands: [] },
    }),
  ];
}

function richEdges(): GraphEdge[] {
  return [
    edge("depends_on", "alpha", "beta"),
    edge("depends_on", "alpha", "gamma"),
    edge("depends_on", "delta", "alpha"),
    edge("depends_on", "alpha", "missing-ref"),
    edge("blocks", "alpha", "epsilon"),
    edge("conflicts_with", "alpha", "zeta"),
    edge("ownership_overlap", "alpha", "omega", {
      severity: "locked",
      matchedPaths: [
        {
          path: "src/shared/secret/**",
          otherPath: "src/shared/**",
          kind: "locked",
          reason: "alpha locks src/shared/secret/**; overlaps allowed path src/shared/** of omega",
        },
        {
          path: "src/unsafe/**",
          otherPath: "src/unsafe/**",
          kind: "unsafe_parallel_area",
          reason: "alpha flags unsafe parallel area src/unsafe/**; overlaps allowed path src/unsafe/** of omega",
        },
      ],
    }),
  ];
}

function richPacket(): TaskGraphPacket {
  return packet(richNodes(), richEdges(), { referencedButAbsent: ["missing-ref"] });
}

// ── Review service fake (mirrors tests/reviewTui.test.ts) ─────────────────

function reviewPacket(taskId: string): ReviewPacket {
  return {
    taskId,
    title: `Task ${taskId}`,
    status: "needs_review",
    tier: "active",
    domain: "core",
    priority: "high",
    goal: "Deliver the feature.",
    claimedScope: { allowedPaths: ["src/**"], forbiddenPaths: ["dist/**"] },
    changedFilesSource: "run-log",
    changedPaths: [{ path: "src/example.ts", source: "run-log", inAllowedPaths: true, inForbiddenPaths: false }],
    scopeDrift: {
      source: "run-log",
      changedPaths: ["src/example.ts"],
      outOfScopePaths: [],
      forbiddenPaths: [],
      declaredAllowedPatterns: ["src/**"],
      declaredForbiddenPatterns: ["dist/**"],
      hasDrift: false,
    },
    acceptanceCriteria: [{ criterion: "It works.", evidence: "Tests pass.", covered: true }],
    verification: {
      requiredCommands: ["pnpm test"],
      commandOutcomes: [{ command: "pnpm test", status: "passed" }],
      failedOrMissingChecks: [],
      hasVerification: true,
    },
    receipt: { result: "complete", hasVerificationReceipt: true, verificationReceipt: "ok: true" },
    workerNotes: { decisionsMade: [], followUps: [], risks: "none" },
    risks: [],
    warnings: [],
    blockers: [],
    dependencies: [],
    diffSummary: { changedFileCount: 1, source: "run-log", insertions: 3, deletions: 1 },
    availableDecisions: [
      { id: "approve", label: "Approve", enabled: true },
      { id: "request_changes", label: "Request changes", enabled: true },
      { id: "reject", label: "Reject", enabled: true },
      { id: "block", label: "Block", enabled: true },
    ],
    readiness: {
      taskId,
      ready: true,
      score: 80,
      checklist: [],
      humanReviewNeeded: false,
      humanReviewReasons: [],
      hasRunLog: true,
      hasChangedFiles: true,
      changedFiles: ["src/example.ts"],
      changedFilesSource: "run-log",
      overlappingFiles: [],
      hasVerificationCommands: true,
      hasVerificationResults: true,
      hasVerification: true,
      missingVerificationCommands: [],
      failedVerificationCommands: [],
      absentVerificationCommands: [],
      hasRisks: false,
      documentedRisks: [],
      missingReceiptFields: [],
      uncoveredAcceptanceCriteria: [],
      unmappedAcceptanceEvidence: [],
      missingEvidence: [],
    },
  };
}

function queueRow(taskId: string): ReviewQueueRow {
  return { taskId, title: `Task ${taskId}`, status: "needs_review", tier: "active", domain: "core", priority: "medium" };
}

function makeQueue(ids: string[]): ReviewQueueSummary {
  const rows = ids.map(queueRow);
  return {
    needsReview: { rows, count: rows.length },
    blocked: { rows: [], count: 0 },
    completed: { rows: [], count: 0 },
    total: rows.length,
  };
}

class FakeReviewService implements ReviewService {
  packets = new Map<string, ReviewPacket>();
  getPacketCalls: string[] = [];
  applyDecisionCalls: Array<{ action: ReviewDecisionId; taskId: string }> = [];

  constructor(ids: string[]) {
    for (const id of ids) this.packets.set(id, reviewPacket(id));
  }

  getQueue(): ReviewQueueSummary {
    return makeQueue([...this.packets.keys()]);
  }

  getPacket(taskId: string): ReviewPacket {
    this.getPacketCalls.push(taskId);
    const found = this.packets.get(taskId);
    if (!found) throw new Error(`Task not found: ${taskId}`);
    return found;
  }

  applyDecision(action: ReviewDecisionId, taskId: string): ReturnType<ReviewService["applyDecision"]> {
    this.applyDecisionCalls.push({ action, taskId });
    return { taskId, outcome: "approved", previousStatus: "needs_review", nextStatus: "complete", taskPath: `${taskId}.yaml` };
  }
}

// ── Graph service fake (mirrors getTaskGraphPacket semantics) ─────────────

class FakeGraphService implements GraphService {
  calls: TaskGraphOptions[] = [];

  constructor(
    private allNodes: GraphTaskNode[],
    private allEdges: GraphEdge[],
    private throwFor: (options: TaskGraphOptions) => boolean = () => false
  ) {}

  getGraph(options: TaskGraphOptions): TaskGraphPacket {
    this.calls.push(options);
    if (this.throwFor(options)) {
      throw new TaskGraphError(`Task not found in graph: ${options.focusTask ?? "?"}`);
    }

    let nodes = this.allNodes;
    if (options.status) nodes = nodes.filter((candidate) => candidate.status === options.status);
    if (options.domain) nodes = nodes.filter((candidate) => candidate.domain === options.domain);
    if (options.tier && options.tier !== "all") nodes = nodes.filter((candidate) => candidate.tier === options.tier);
    let edges = this.allEdges;
    if (options.edgeTypes) {
      const allowed = new Set(options.edgeTypes);
      edges = edges.filter((candidate) => allowed.has(candidate.type));
    }
    const nodeIds = new Set(nodes.map((candidate) => candidate.taskId));

    let selectedIds: Set<string>;
    if (options.focusTask) {
      if (!nodeIds.has(options.focusTask)) {
        throw new TaskGraphError(`Task not found in graph: ${options.focusTask}`);
      }
      selectedIds = neighborhood(options.focusTask, edges, options.depth ?? 2, nodeIds);
    } else {
      selectedIds = new Set(nodeIds);
    }

    nodes = nodes.filter((candidate) => selectedIds.has(candidate.taskId));
    const loaded = new Set(this.allNodes.map((candidate) => candidate.taskId));
    edges = edges.filter((candidate) => {
      const bothPresent = selectedIds.has(candidate.source) && selectedIds.has(candidate.target);
      const sourceDangling = selectedIds.has(candidate.source) && !loaded.has(candidate.target);
      const targetDangling = selectedIds.has(candidate.target) && !loaded.has(candidate.source);
      return bothPresent || sourceDangling || targetDangling;
    });

    const referenced = new Set<string>();
    for (const candidate of edges) {
      referenced.add(candidate.source);
      referenced.add(candidate.target);
    }
    const referencedButAbsent = [...referenced].filter((id) => !loaded.has(id)).sort();

    const byEdgeType: Record<EdgeType, number> = { depends_on: 0, blocks: 0, conflicts_with: 0, ownership_overlap: 0 };
    for (const candidate of edges) byEdgeType[candidate.type] += 1;

    return {
      nodes,
      edges,
      counts: { nodes: nodes.length, edges: edges.length, byEdgeType },
      filters: {
        ...(options.focusTask ? { focusTask: options.focusTask } : {}),
        traversalDepth: options.depth ?? 2,
        tier: options.tier ?? (options.allTasks === true ? "all" : "active"),
        ...(options.status ? { status: options.status } : {}),
        ...(options.domain ? { domain: options.domain } : {}),
        edgeTypes: options.edgeTypes ?? ["depends_on", "blocks", "conflicts_with", "ownership_overlap"],
        allTasksMode: options.allTasks === true,
      },
      referencedButAbsent,
    };
  }
}

function neighborhood(focus: string, edges: GraphEdge[], depth: number, nodeIds: Set<string>): Set<string> {
  const included = new Set<string>([focus]);
  let frontier = new Set<string>([focus]);
  let hops = 0;
  while (frontier.size > 0 && (depth < 0 || hops < depth)) {
    const next = new Set<string>();
    for (const candidate of edges) {
      if (frontier.has(candidate.source) && nodeIds.has(candidate.target) && !included.has(candidate.target)) {
        next.add(candidate.target);
      }
      if (frontier.has(candidate.target) && nodeIds.has(candidate.source) && !included.has(candidate.source)) {
        next.add(candidate.source);
      }
    }
    if (next.size === 0) break;
    for (const id of next) included.add(id);
    frontier = next;
    hops += 1;
  }
  return included;
}

// ── Render helpers ────────────────────────────────────────────────────────

function renderTui(review: FakeReviewService, graph: FakeGraphService, options: { session?: ReviewTuiSession } = {}) {
  const onOpenPager = vi.fn();
  const rendered = inkTestRender(
    React.createElement(ReviewTui, {
      service: review,
      graphService: graph,
      cwd: FAKE_CWD,
      onOpenPager,
      ...(options.session ? { session: options.session } : {}),
    })
  );
  return { ...rendered, onOpenPager };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function press(stdin: { write: (data: string) => void }, keys: string): Promise<void> {
  stdin.write(keys);
  // Let the full async chain settle: ink input dispatch, React state updates,
  // effect-triggered graph fetches, and the final re-render. A single
  // macrotask is unreliable when other test files run in parallel workers.
  for (let i = 0; i < 5; i += 1) {
    await tick();
  }
}

afterEach(() => {
  inkTestingCleanup();
});

// ── Pure layout/model tests ───────────────────────────────────────────────

describe("task graph TUI layout model", () => {
  it("lays out dependency depth as horizontal layers anchored on the focus task", () => {
    const layout = computeLayout(richPacket(), "alpha");
    const columnOf = (id: string): number => layout.byId.get(id)?.column ?? -1;

    // Prerequisites sit one layer upstream of the focus; dependents one layer downstream.
    expect(columnOf("alpha")).toBe(1);
    expect(columnOf("beta")).toBe(0);
    expect(columnOf("gamma")).toBe(0);
    expect(columnOf("delta")).toBe(2);
    // Non-dependency neighbors (blocks/conflict/ownership) share the focus layer.
    expect(columnOf("epsilon")).toBe(1);
    expect(columnOf("zeta")).toBe(1);
    expect(columnOf("omega")).toBe(1);
    expect(layout.columnCount).toBe(3);

    // Rows within a layer are sorted by task id.
    const focusLayer = layout.placed.filter((entry) => entry.column === 1);
    expect(focusLayer.map((entry) => entry.node.taskId)).toEqual(["alpha", "epsilon", "omega", "zeta"]);

    // Dangling dependency edges are retained as layout edges.
    const dangling = layout.edges.find((entry) => entry.edge.target === "missing-ref");
    expect(dangling).toBeDefined();
    expect(dangling!.b).toBeNull();
    expect(layout.dangling).toEqual(["missing-ref"]);
  });

  it("anchors unfocused layouts on dependency roots", () => {
    const nodes = [node("root-a"), node("root-b"), node("leaf", { status: "pending" })];
    const edges = [edge("depends_on", "leaf", "root-a"), edge("depends_on", "leaf", "root-b")];
    const layout = computeLayout(packet(nodes, edges), undefined);

    expect(layout.byId.get("root-a")!.column).toBe(0);
    expect(layout.byId.get("root-b")!.column).toBe(0);
    expect(layout.byId.get("leaf")!.column).toBe(1);
  });

  it("detects dependency and block cycles deterministically", () => {
    const nodes = [node("cyc-a"), node("cyc-b"), node("self-loop")];
    const edges = [
      edge("depends_on", "cyc-a", "cyc-b"),
      edge("depends_on", "cyc-b", "cyc-a"),
      edge("blocks", "self-loop", "self-loop"),
    ];
    const cycles = findCycles(packet(nodes, edges));
    expect(cycles.some((cycle) => cycle.join(",") === "cyc-a,cyc-b,cyc-a")).toBe(true);
    expect(cycles.some((cycle) => cycle.join(",") === "self-loop,self-loop")).toBe(true);
  });

  it("classifies upstream and downstream dependency neighbors", () => {
    const graphPacket = richPacket();
    // upstream: depends_on targets plus blocks sources; downstream: the reverse.
    expect(upstreamNeighbors(graphPacket, "alpha")).toEqual(["beta", "gamma"]);
    expect(downstreamNeighbors(graphPacket, "alpha")).toEqual(["delta", "epsilon"]);
    expect(upstreamNeighbors(graphPacket, "beta")).toEqual([]);
    expect(downstreamNeighbors(graphPacket, "beta")).toEqual(["alpha"]);
  });
});

// ── Integration: opening the graph ────────────────────────────────────────

describe("task graph TUI integration", () => {
  function harness() {
    const review = new FakeReviewService(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "omega"]);
    const graph = new FakeGraphService(richNodes(), richEdges());
    const rendered = renderTui(review, graph);
    return { review, graph, ...rendered };
  }

  it("pressing g in the queue opens a graph focused on the selected task with the default two-hop depth", async () => {
    const { graph, lastFrame, stdin } = harness();
    await tick();

    await press(stdin, "g");
    const frame = lastFrame();
    expect(frame).toContain("Task Graph");
    expect(frame).toContain("focus: alpha");
    expect(frame).toContain("Dependencies");
    expect(graph.calls[0]).toMatchObject({ focusTask: "alpha", depth: 2 });
  });

  it("pressing g in task detail opens a graph focused on the detail packet task", async () => {
    const { graph, lastFrame, stdin } = harness();
    await tick();
    await press(stdin, "\r"); // open alpha detail
    await press(stdin, "g");

    expect(lastFrame()).toContain("Task Graph");
    expect(lastFrame()).toContain("focus: alpha");
    expect(graph.calls[0]).toMatchObject({ focusTask: "alpha", depth: 2 });
  });

  it("Enter on a graph node opens that task's existing ReviewPacket detail without reassembling evidence", async () => {
    const { review, lastFrame, stdin } = harness();
    await tick();
    await press(stdin, "g");

    // Navigate selection from alpha to epsilon (layout order), then drill down.
    await press(stdin, "j");
    expect(lastFrame()).toContain("Detail — epsilon");
    await press(stdin, "\r");

    expect(lastFrame()).toContain("Reviewing: epsilon");
    expect(review.getPacketCalls).toContain("epsilon");
    // The graph is closed after drilling into the detail view.
    expect(lastFrame()).not.toContain("Task Graph");
  });

  it("Escape or g returns from the graph to the prior review view", async () => {
    const { lastFrame, stdin } = harness();
    await tick();

    await press(stdin, "g"); // opened from the queue
    await press(stdin, "\u001b");
    expect(lastFrame()).toContain("Review Dashboard");

    await press(stdin, "\r"); // open detail
    await press(stdin, "g"); // opened from detail
    expect(lastFrame()).toContain("Task Graph");
    await press(stdin, "g");
    expect(lastFrame()).toContain("Reviewing: alpha");
  });

  it("keeps the old dependency list view when no graph service is wired", async () => {
    const review = new FakeReviewService(["alpha"]);
    const onOpenPager = vi.fn();
    const rendered = inkTestRender(
      React.createElement(ReviewTui, { service: review, cwd: FAKE_CWD, onOpenPager })
    );
    await tick();
    await press(rendered.stdin, "\r");
    await press(rendered.stdin, "g");
    expect(rendered.lastFrame()).toContain("Dependencies — alpha");
  });
});

// ── Navigation, lenses, and layout ────────────────────────────────────────

describe("task graph TUI navigation and lenses", () => {
  function harness() {
    const review = new FakeReviewService(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "omega"]);
    const graph = new FakeGraphService(richNodes(), richEdges());
    const rendered = renderTui(review, graph);
    return { review, graph, ...rendered };
  }

  it("moves selection through visible nodes with j/k and arrow keys", async () => {
    const { lastFrame, stdin } = harness();
    await tick();
    await press(stdin, "g");
    expect(lastFrame()).toContain("Detail — alpha");

    await press(stdin, "j");
    expect(lastFrame()).toContain("Detail — epsilon");

    await press(stdin, "\u001b[B"); // down arrow
    expect(lastFrame()).toContain("Detail — omega");

    await press(stdin, "k");
    expect(lastFrame()).toContain("Detail — epsilon");

    await press(stdin, "\u001b[A"); // up arrow
    expect(lastFrame()).toContain("Detail — alpha");
  });

  it("h and l move between upstream and downstream dependency neighbors", async () => {
    const { lastFrame, stdin } = harness();
    await tick();
    await press(stdin, "g");

    await press(stdin, "l");
    expect(lastFrame()).toContain("Detail — delta");

    await press(stdin, "h");
    expect(lastFrame()).toContain("Detail — alpha");

    await press(stdin, "h");
    expect(lastFrame()).toContain("Detail — beta");
  });

  it("Tab cycles lenses while keeping the selected node and topology", async () => {
    const { lastFrame, stdin } = harness();
    await tick();
    await press(stdin, "g");

    // Dependencies
    expect(lastFrame()).toContain("Dependencies");
    expect(lastFrame()).toContain("upstream: beta, gamma");

    await press(stdin, "\t");
    expect(lastFrame()).toContain("Ownership");
    expect(lastFrame()).toContain("locked paths: src/shared/secret/**");
    expect(lastFrame()).toContain("[LOCKED] src/shared/secret/** ↔ src/shared/**");
    expect(lastFrame()).toContain("[UNSAFE] src/unsafe/** ↔ src/unsafe/**");
    expect(lastFrame()).toContain("Detail — alpha");

    await press(stdin, "\t");
    expect(lastFrame()).toContain("Receipts");
    expect(lastFrame()).toContain("receipt: passing");
    expect(lastFrame()).toContain("counts — passing 3 · failing 1 · incomplete 1 · missing 2");
    expect(lastFrame()).toContain("Detail — alpha");

    await press(stdin, "\t");
    expect(lastFrame()).toContain("Status");
    expect(lastFrame()).toContain("status: needs_review");
    expect(lastFrame()).toContain("tier: active");
    expect(lastFrame()).toContain("counts — blocked 1 · complete 2 · needs_review 3 · pending 1");

    await press(stdin, "\t");
    expect(lastFrame()).toContain("Dependencies");
    expect(lastFrame()).toContain("Detail — alpha");
  });

  it("renders the wide layered ASCII topology with badges, direction glyphs, and a legend", async () => {
    const { lastFrame, stdin } = harness();
    await tick();
    await press(stdin, "g");

    const frame = lastFrame();
    // Layered headers and focus marker.
    expect(frame).toContain("focus");
    expect(frame).toContain("up 1");
    expect(frame).toContain("down 1");
    expect(frame).toContain("★ alpha");
    // Status and receipt badges on every node.
    expect(frame).toContain("[needs_review] [passing]");
    expect(frame).toContain("[blocked] [failing]");
    expect(frame).toContain("[pending] [missing]");
    // Edge direction and distinct glyphs.
    expect(frame).toContain("alpha ─▶ beta");
    expect(frame).toContain("alpha ▸▶ epsilon");
    expect(frame).toContain("alpha ══ zeta");
    expect(frame).toContain("alpha ~~ omega [LOCKED] (2 overlap(s))");
    expect(frame).toContain("(dangling)");
    // Explanatory legend. The tail of the legend wraps at the default terminal
    // width, so assert the glyphs and labels individually.
    expect(frame).toContain("Legend:");
    expect(frame).toContain("─▶ depends_on (A depends on B)");
    expect(frame).toContain("▸▶ blocks (A blocks B)");
    expect(frame).toContain("══ conflicts_with");
    expect(frame).toContain("~~");
    expect(frame).toContain("ownership_overlap");
  });

  it("falls back to an indented focus list with explicit edge labels on narrow terminals", async () => {
    const review = new FakeReviewService(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "omega"]);
    const graph = new FakeGraphService(richNodes(), richEdges());
    const { instance, stdout, stdin } = renderNarrowGraph(review, graph, 60);
    await tick();
    await press(stdin, "g");

    const frame = stdout.lastFrame();
    // Indented focus list with explicit edge labels and direction.
    expect(frame).toContain("★ alpha [needs_review] [passing]");
    expect(frame).toContain("─▶ beta [complete] [passing]  depends_on →");
    expect(frame).toContain("▸▶ epsilon [needs_review] [incomplete]  blocks →");
    expect(frame).toContain("══ zeta [complete] [passing]  conflicts_with —");
    expect(frame).toContain("~~ omega [needs_review] [missing]  ownership_overlap —");
    // Lenses and lens detail still work on narrow terminals.
    await press(stdin, "\t");
    expect(stdout.lastFrame()).toContain("Ownership");
    expect(stdout.lastFrame()).toContain("locked paths: src/shared/secret/**");
    await press(stdin, "\t");
    expect(stdout.lastFrame()).toContain("receipt: passing");
    instance.unmount();
  });

  it("navigates and drills down on narrow terminals without clipping essential evidence", async () => {
    const review = new FakeReviewService(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "omega"]);
    const graph = new FakeGraphService(richNodes(), richEdges());
    const { instance, stdout, stdin } = renderNarrowGraph(review, graph, 60);
    await tick();
    await press(stdin, "g");

    // j walks the focus layer (sorted by task id): alpha -> epsilon.
    await press(stdin, "j");
    expect(stdout.lastFrame()).toContain("› epsilon [needs_review] [incomplete]");
    await press(stdin, "h");
    expect(stdout.lastFrame()).toContain("Detail — alpha");
    await press(stdin, "\r");
    expect(stdout.lastFrame()).toContain("Reviewing: alpha");
    instance.unmount();
  });
});

// ── Filters, depth, and reset ─────────────────────────────────────────────

describe("task graph TUI filters and depth", () => {
  function harness() {
    const review = new FakeReviewService(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "omega"]);
    const graph = new FakeGraphService(richNodes(), richEdges());
    const rendered = renderTui(review, graph);
    return { review, graph, ...rendered };
  }

  it("expands and contracts the neighborhood depth with +/- and =", async () => {
    const { graph, stdin } = harness();
    await tick();
    await press(stdin, "g");
    expect(graph.calls.at(-1)).toMatchObject({ focusTask: "alpha", depth: 2 });

    await press(stdin, "+");
    expect(graph.calls.at(-1)).toMatchObject({ depth: 3 });

    await press(stdin, "-");
    expect(graph.calls.at(-1)).toMatchObject({ depth: 2 });

    await press(stdin, "=");
    expect(graph.calls.at(-1)).toMatchObject({ depth: 3 });
  });

  it("toggles the all-active view and restores focus mode", async () => {
    const { graph, lastFrame, stdin } = harness();
    await tick();
    await press(stdin, "g");

    await press(stdin, "a");
    const allActiveCall = graph.calls.at(-1)!;
    expect(allActiveCall.allTasks).toBe(true);
    expect(allActiveCall.focusTask).toBeUndefined();
    expect(lastFrame()).toContain("all-active");

    await press(stdin, "a");
    expect(graph.calls.at(-1)).toMatchObject({ focusTask: "alpha", depth: 2 });
    expect(lastFrame()).toContain("focus");
  });

  it("cycles status, domain, tier, and edge-type filters through the service", async () => {
    const { graph, stdin } = harness();
    await tick();
    await press(stdin, "g");

    await press(stdin, "s");
    expect(graph.calls.at(-1)).toMatchObject({ status: "blocked" });

    await press(stdin, "d");
    expect(graph.calls.at(-1)).toMatchObject({ domain: "core" });

    await press(stdin, "t");
    expect(graph.calls.at(-1)).toMatchObject({ tier: "active" });
    await press(stdin, "t");
    expect(graph.calls.at(-1)).toMatchObject({ tier: "completed" });

    await press(stdin, "e");
    expect(graph.calls.at(-1)).toMatchObject({ edgeTypes: ["depends_on"] });
  });

  it("reset restores the default focus neighborhood without losing the selected task", async () => {
    const { graph, lastFrame, stdin } = harness();
    await tick();
    await press(stdin, "g");

    await press(stdin, "s");
    await press(stdin, "t");
    await press(stdin, "e");
    await press(stdin, "+");
    expect(graph.calls.at(-1)).not.toMatchObject({ focusTask: "alpha" });

    await press(stdin, "r");
    expect(graph.calls.at(-1)).toEqual({ depth: 2, focusTask: "alpha" });
    expect(lastFrame()).toContain("Detail — alpha");
  });

  it("falls back to an unfocused filtered query when filters exclude the focus task", async () => {
    // The queue selects alpha (first row); the graph opens focused on alpha.
    const review = new FakeReviewService(["alpha", "gamma"]);
    // throwFor simulates the real packet assembler rejecting a focus task that
    // the status filter removed.
    const graph = new FakeGraphService(richNodes(), richEdges(), (options) => {
      return options.status === "blocked" && options.focusTask === "alpha";
    });
    const { lastFrame, stdin } = renderTui(review, graph);
    await tick();
    await press(stdin, "g");
    expect(graph.calls.at(-1)).toMatchObject({ focusTask: "alpha" });

    await press(stdin, "s"); // status -> blocked (alpha filtered out)
    await tick();
    const calls = graph.calls;
    expect(calls.at(-1)).toMatchObject({ status: "blocked" });
    expect(calls.at(-1)!.focusTask).toBeUndefined();
    // The filtered node set is still rendered with a sensible selection.
    expect(lastFrame()).toContain("Detail — gamma");
  });

  it("renders an empty graph state without errors", async () => {
    const review = new FakeReviewService(["alpha"]);
    const graph = new FakeGraphService([], []);
    const { lastFrame, stdin } = renderTui(review, graph);
    await tick();
    await press(stdin, "g");
    expect(lastFrame()).toContain("No tasks match the current filters.");
    // Navigation stays safe on an empty graph.
    await press(stdin, "j");
    await press(stdin, "\r");
    expect(lastFrame()).toContain("No tasks match the current filters.");
  });

  it("shows cycle and dangling-reference warnings in the Dependencies lens", async () => {
    const review = new FakeReviewService(["cyc-a", "cyc-b"]);
    const nodes = [node("cyc-a"), node("cyc-b")];
    const edges = [edge("depends_on", "cyc-a", "cyc-b"), edge("depends_on", "cyc-b", "cyc-a")];
    const graph = new FakeGraphService(nodes, edges);
    const { lastFrame, stdin } = renderTui(review, graph);
    await tick();
    await press(stdin, "g");

    const frame = lastFrame();
    expect(frame).toContain("dependency cycle(s)");
    expect(frame).toContain("cyc-a ⇄ cyc-b");
  });

  it("distinguishes failing and missing receipt warnings in the Receipts lens", async () => {
    const { lastFrame, stdin } = harness();
    await tick();
    await press(stdin, "g");
    await press(stdin, "\t");
    await press(stdin, "\t"); // Receipts lens

    const frame = lastFrame();
    expect(frame).toContain("failing receipt(s): gamma");
    expect(frame).toContain("missing receipt(s): delta, omega");
  });

  it("truncates long task ids in the wide grid but keeps full ids in the detail panel", async () => {
    const longId = "a-very-long-task-identifier-that-overflows-1234567890";
    const review = new FakeReviewService([longId]);
    const graph = new FakeGraphService(
      [node(longId, { receipt: { present: true, health: "passing", isLatestSuperseded: false } })],
      []
    );
    const { lastFrame, stdin } = renderTui(review, graph);
    await tick();
    await press(stdin, "g");

    const frame = lastFrame();
    expect(frame).toContain("…");
    expect(frame).toContain(`Detail — ${longId}`);
  });
});

// ── Layout adaptation: disconnected components and resize events ──────────

describe("task graph TUI layout adaptation", () => {
  it("renders disconnected active components without collapsing topology", async () => {
    // Two unrelated dependency clusters sharing no edges.
    const nodes = [
      node("alpha", { status: "in_progress" }),
      node("beta", { status: "complete" }),
      node("gamma", { status: "needs_review" }),
      node("delta", { status: "pending" }),
    ];
    const edges = [edge("depends_on", "alpha", "beta"), edge("depends_on", "gamma", "delta")];
    const graph = new FakeGraphService(nodes, edges);
    const review = new FakeReviewService(["alpha", "beta", "gamma", "delta"]);
    const { lastFrame, stdin } = renderTui(review, graph);
    await tick();
    await press(stdin, "g");

    // Focus mode only reaches alpha's own cluster; the all-active view shows
    // every active component deterministically.
    await press(stdin, "a");
    const frame = lastFrame();
    expect(frame).toContain("all-active");
    expect(frame).toContain("alpha ─▶ beta");
    expect(frame).toContain("gamma ─▶ delta");
    // No synthetic cross edges or cycle/dangling warnings between the clusters.
    expect(frame).toContain("no cycle or dangling-reference warnings");
    // Navigation still walks the full placed set without errors.
    await press(stdin, "j");
    expect(lastFrame()).not.toContain("Graph error");
  });

  it("re-layouts from the wide grid to the narrow list and back on resize", async () => {
    const review = new FakeReviewService(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "omega"]);
    const graph = new FakeGraphService(richNodes(), richEdges());
    const { instance, stdout, stdin } = renderNarrowGraph(review, graph, 100);
    await tick();
    await press(stdin, "g");

    // Wide: layered columns with the focus marker.
    expect(stdout.lastFrame()).toContain("up 1");
    expect(stdout.lastFrame()).toContain("★ alpha");

    // Resize to a narrow terminal; ink re-renders into the indented list.
    stdout.columns = 60;
    stdout.emit("resize");
    await tick();
    let frame = stdout.lastFrame();
    expect(frame).toContain("★ alpha [needs_review] [passing]");
    expect(frame).toContain("─▶ beta [complete] [passing]  depends_on →");

    // Resize back to wide restores the layered topology.
    stdout.columns = 100;
    stdout.emit("resize");
    await tick();
    frame = stdout.lastFrame();
    expect(frame).toContain("up 1");
    expect(frame).toContain("alpha ─▶ beta");
    instance.unmount();
  });
});

// ── Narrow-terminal harness (ink render with configurable columns) ────────

type FakeStream = EventEmitter & {
  columns: number;
  rows: number;
  frames: string[];
  lastFrameValue?: string;
  write: (frame: string) => void;
  lastFrame: () => string | undefined;
};

function createFakeStream(columns: number): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  stream.columns = columns;
  stream.rows = 40;
  stream.frames = [];
  stream.write = (frame: string) => {
    stream.frames.push(frame);
    stream.lastFrameValue = frame;
  };
  stream.lastFrame = () => stream.lastFrameValue;
  return stream;
}

type FakeStdin = EventEmitter & {
  isTTY: boolean;
  data: unknown;
  write: (data: string) => void;
  setEncoding: () => void;
  setRawMode: () => void;
  resume: () => void;
  pause: () => void;
  ref: () => void;
  unref: () => void;
  read: () => unknown;
};

function createFakeStdin(): FakeStdin {
  const stdin = new EventEmitter() as FakeStdin;
  stdin.isTTY = true;
  stdin.data = null;
  stdin.write = (data: string) => {
    stdin.data = data;
    stdin.emit("readable");
    stdin.emit("data", data);
  };
  stdin.setEncoding = () => {};
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  stdin.read = () => {
    const data = stdin.data;
    stdin.data = null;
    return data;
  };
  return stdin;
}

function renderNarrowGraph(review: FakeReviewService, graph: FakeGraphService, columns: number) {
  const stdout = createFakeStream(columns);
  const stderr = createFakeStream(columns);
  const stdin = createFakeStdin();
  const onOpenPager = vi.fn();
  const instance = inkRender(
    React.createElement(ReviewTui, { service: review, graphService: graph, cwd: FAKE_CWD, onOpenPager }),
    { stdout, stderr, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
  );
  return { instance, stdout, stdin };
}

// ── Real service wiring ───────────────────────────────────────────────────

describe("createGraphService", () => {
  it("assembles a real TaskGraphPacket through the shared packet assembler", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "manciple-task-graph-tui-"));
    try {
      const p = getPaths(cwd, ".manciple");
      await initCommand({ force: false, cwd, root: ".manciple" });
      newCommand("Graph Hub", {
        type: "implementation",
        domain: "core",
        priority: "medium",
        cwd,
        activeDir: p.tasksActive,
      });
      newCommand("Graph Leaf", {
        type: "implementation",
        domain: "core",
        priority: "medium",
        cwd,
        activeDir: p.tasksActive,
      });
      // Wire a depends_on relationship via the active spec file. loadTasks
      // maps the specsTasksDir back to tasks/{tier}, so the relationship must
      // live in the active dir the shared assembler actually reads.
      const leafSpec = join(p.tasksActive, "graph-leaf.yaml");
      writeFileSync(
        leafSpec,
        stringify(
          {
            id: "graph-leaf",
            title: "Graph Leaf",
            status: "pending",
            type: "implementation",
            domain: "core",
            priority: "medium",
            depends_on: ["graph-hub"],
            blocks: [],
            conflicts_with: [],
            can_run_independently: false,
            allowed_paths: ["src/**"],
            forbidden_paths: ["dist/**"],
            path_ownership: { touched_paths: [], locked_paths: [], unsafe_parallel_areas: [] },
            goal: "Leaf goal.",
            acceptance_criteria: ["Leaf works."],
            implementation_notes: [],
            verification: { commands: ["pnpm test"] },
            outputs_required: ["files_changed"],
            notes: [],
          },
          { lineWidth: 0 }
        ),
        "utf-8"
      );

      const service = createGraphService(p, cwd);
      const result = service.getGraph({ focusTask: "graph-leaf", depth: 2 });
      const ids = result.nodes.map((entry) => entry.taskId).sort();
      expect(ids).toEqual(["graph-hub", "graph-leaf"]);
      expect(result.edges.filter((entry) => entry.type === "depends_on")).toEqual([
        { type: "depends_on", source: "graph-leaf", target: "graph-hub", directed: true },
      ]);
      expect(result.nodes.find((entry) => entry.taskId === "graph-leaf")).toMatchObject({
        domain: "core",
        status: "pending",
        tier: "active",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
