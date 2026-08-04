import { Box, Text, useInput, useStdout } from "ink";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import type {
  EdgeType,
  GraphTaskTier,
  TaskGraphOptions,
  TaskGraphPacket,
} from "../graph/taskGraphPacket.js";
import { TaskGraphError } from "../graph/taskGraphPacket.js";
import type { GraphLayout, GraphLens, PlacedNode } from "./graphLayout.js";
import {
  computeLayout,
  downstreamNeighbors,
  EDGE_GLYPHS,
  EDGE_TYPE_LABELS,
  EDGE_TYPE_ORDER,
  LENS_EMPHASIZED_EDGES,
  LENS_LABELS,
  LENS_ORDER,
  ownershipSeverityLabel,
  receiptColor,
  receiptHealthCounts,
  statusColor,
  statusCounts,
  truncate,
  upstreamNeighbors,
} from "./graphLayout.js";
import type { GraphService } from "./graphService.js";

/**
 * GraphView is the interactive task-graph overlay of the review TUI.
 *
 * Data boundary: the component consumes TaskGraphPacket exclusively through
 * the injected GraphService. It never reads task YAML, run logs, readiness
 * reports, or path-ownership state; every node, edge, badge, and warning is
 * derived from the packet returned by getGraph(). Entering a node delegates
 * back to the existing ReviewPacket detail flow, so repository evidence is
 * never reassembled inside the UI.
 */

export interface GraphViewProps {
  graphService: GraphService;
  /** Task id the graph opens focused on. */
  focusTask: string;
  /** Opens the selected task's existing ReviewPacket detail. */
  onDrillDown: (taskId: string) => void;
  /** Escape / g / q: return to the prior review view. */
  onExit: () => void;
}

export interface ViewLine {
  text: string;
  color?: string;
  dim?: boolean;
  inverse?: boolean;
  bold?: boolean;
}

interface GraphViewState {
  lens: GraphLens;
  depth: number;
  allActive: boolean;
  statusFilter: string | null;
  domainFilter: string | null;
  tierFilter: GraphTaskTier | "all";
  edgeTypeFilter: EdgeType | "all";
  focusTask: string;
}

const FOOTER =
  "j/k move · h/l dep nav · Tab lens · enter detail · +/- depth · a all-active · s status · d domain · t tier · e edges · r reset · g/esc back";

const WIDE_TERMINAL_MIN_WIDTH = 68;

function depthLabel(depth: number): string {
  return depth === -1 ? "∞" : String(depth);
}

function buildHeaderLines(state: GraphViewState, packet: TaskGraphPacket): ViewLine[] {
  const filters =
    [
      state.statusFilter ? `status:${state.statusFilter}` : null,
      state.domainFilter ? `domain:${state.domainFilter}` : null,
      state.tierFilter !== "all" ? `tier:${state.tierFilter}` : null,
      state.edgeTypeFilter !== "all" ? `edges:${state.edgeTypeFilter}` : null,
    ]
      .filter((value): value is string => value !== null)
      .join(" ") || "none";
  return [
    {
      text: `Task Graph — focus: ${state.focusTask} — ${LENS_LABELS[state.lens]} — depth ${depthLabel(
        state.depth,
      )} — ${state.allActive ? "all-active" : "focus"}`,
      bold: true,
    },
    {
      text: `filters: ${filters} · nodes ${packet.counts.nodes} · edges ${packet.counts.edges}`,
      dim: true,
    },
    {
      text: "Legend: ─▶ depends_on (A depends on B) · ▸▶ blocks (A blocks B) · ══ conflicts_with · ~~ ownership_overlap",
      dim: true,
    },
  ];
}

function buildWideGrid(
  layout: GraphLayout,
  selectedId: string | null,
  focusTask: string,
): ViewLine[] {
  const { placed, columnCount, maxRows, byId } = layout;
  if (placed.length === 0) {
    return [{ text: "No tasks match the current filters.", dim: true }];
  }
  const anchorColumn = byId.get(focusTask)?.column ?? 0;
  const cap = 26;
  const sep = " │ ";

  const nodeLine = (entry: PlacedNode): string => {
    const node = entry.node;
    const selectedMark = node.taskId === selectedId ? "›" : " ";
    const focusMark = node.taskId === focusTask ? "★" : " ";
    return `${selectedMark}${focusMark} ${truncate(node.taskId, Math.max(4, cap - 4))}`;
  };
  const badgeLine = (entry: PlacedNode): string => {
    const node = entry.node;
    return `[${truncate(node.status, 12)}] [${node.receipt.health}]`;
  };

  const cellWidth = (column: number): number => {
    let max = 0;
    for (const entry of placed) {
      if (entry.column !== column) continue;
      max = Math.max(max, nodeLine(entry).length, badgeLine(entry).length);
    }
    return Math.min(max, cap);
  };
  const widths = Array.from({ length: columnCount }, (_, column) => cellWidth(column));

  const headerCells: string[] = [];
  for (let column = 0; column < columnCount; column += 1) {
    const layer = column - anchorColumn;
    const label = layer === 0 ? "focus" : layer < 0 ? `up ${-layer}` : `down ${layer}`;
    headerCells.push(truncate(label, widths[column]).padEnd(widths[column]));
  }

  const lines: ViewLine[] = [{ text: headerCells.join(sep), bold: true }];
  for (let row = 0; row < maxRows; row += 1) {
    const idCells: string[] = [];
    const badgeCells: string[] = [];
    for (let column = 0; column < columnCount; column += 1) {
      const entry = placed.find(
        (candidate) => candidate.column === column && candidate.row === row,
      );
      idCells.push(entry ? nodeLine(entry).padEnd(widths[column]) : "".padEnd(widths[column]));
      badgeCells.push(entry ? badgeLine(entry).padEnd(widths[column]) : "".padEnd(widths[column]));
    }
    lines.push({ text: idCells.join(sep) });
    lines.push({ text: badgeCells.join(sep) });
  }
  return lines;
}

function buildEdgeLines(layout: GraphLayout, lens: GraphLens): ViewLine[] {
  const emphasized = new Set(LENS_EMPHASIZED_EDGES[lens]);
  const ordered = [...layout.edges].sort((a, b) => {
    const typeA = EDGE_TYPE_ORDER.indexOf(a.edge.type);
    const typeB = EDGE_TYPE_ORDER.indexOf(b.edge.type);
    if (typeA !== typeB) return typeA - typeB;
    return a.edge.source.localeCompare(b.edge.source) || a.edge.target.localeCompare(b.edge.target);
  });

  const lines: ViewLine[] = [];
  if (ordered.length === 0) {
    return [{ text: "No edges match the current filters.", dim: true }];
  }
  lines.push({ text: "Edges:", bold: true });
  for (const entry of ordered) {
    const { edge } = entry;
    const type = edge.type;
    const aId = entry.a?.node.taskId ?? edge.source;
    const bId = entry.b?.node.taskId ?? edge.target;
    const dangling = !entry.a || !entry.b;
    const parts = [`${aId} ${EDGE_GLYPHS[type]} ${bId}`];
    if (type === "ownership_overlap" && edge.severity) {
      parts.push(`[${ownershipSeverityLabel(edge.severity)}]`);
      if (edge.matchedPaths && edge.matchedPaths.length > 0) {
        parts.push(`(${edge.matchedPaths.length} overlap(s))`);
      }
    }
    if (dangling) parts.push("(dangling)");
    parts.push(EDGE_TYPE_LABELS[type]);

    const isEmphasized = emphasized.has(type);
    let color: string | undefined;
    if (type === "ownership_overlap") color = "magenta";
    else if (type === "conflicts_with") color = "cyan";
    lines.push({
      text: `  ${parts.join(" ")}`,
      color,
      dim: !isEmphasized,
    });
  }
  return lines;
}

function buildNarrowList(
  layout: GraphLayout,
  selectedId: string | null,
  focusTask: string,
): ViewLine[] {
  const selected = selectedId ? layout.byId.get(selectedId) : undefined;
  if (!selected) {
    return [{ text: "No tasks match the current filters.", dim: true }];
  }
  const node = selected.node;
  const lines: ViewLine[] = [
    {
      text: `${node.taskId === focusTask ? "★" : "›"} ${node.taskId} [${node.status}] [${node.receipt.health}]`,
      inverse: true,
    },
  ];
  const incident = layout.edges
    .filter((entry) => entry.edge.source === selectedId || entry.edge.target === selectedId)
    .sort((a, b) => {
      const typeA = EDGE_TYPE_ORDER.indexOf(a.edge.type);
      const typeB = EDGE_TYPE_ORDER.indexOf(b.edge.type);
      if (typeA !== typeB) return typeA - typeB;
      return (
        a.edge.source.localeCompare(b.edge.source) || a.edge.target.localeCompare(b.edge.target)
      );
    });
  for (const entry of incident) {
    const { edge } = entry;
    const fromSelected = edge.source === selectedId;
    const neighborId = fromSelected ? edge.target : edge.source;
    const neighborPlaced = fromSelected ? entry.b : entry.a;
    const neighbor = neighborPlaced?.node;
    const badges = neighbor ? ` [${neighbor.status}] [${neighbor.receipt.health}]` : "";
    const direction = edge.directed ? (fromSelected ? "→" : "←") : "—";
    lines.push({
      text: `  ${EDGE_GLYPHS[edge.type]} ${neighborId}${badges}  ${EDGE_TYPE_LABELS[edge.type]} ${direction}${
        neighbor ? "" : " (dangling)"
      }`,
      dim: false,
    });
  }
  if (incident.length === 0) {
    lines.push({ text: "  no incident edges", dim: true });
  }
  return lines;
}

function buildWarningLines(
  packet: TaskGraphPacket,
  layout: GraphLayout,
  lens: GraphLens,
): ViewLine[] {
  const lines: ViewLine[] = [];
  switch (lens) {
    case "dependencies": {
      if (layout.cycles.length > 0) {
        lines.push({
          text: `⚠ ${layout.cycles.length} dependency cycle(s): ${layout.cycles
            .map((cycle) => cycle.join(" ⇄ "))
            .join("; ")}`,
          color: "red",
        });
      }
      if (layout.dangling.length > 0) {
        lines.push({
          text: `⚠ dangling reference(s): ${layout.dangling.join(", ")}`,
          color: "yellow",
        });
      }
      if (lines.length === 0)
        lines.push({ text: "no cycle or dangling-reference warnings", dim: true });
      break;
    }
    case "ownership": {
      const locked = new Set<string>();
      const unsafe = new Set<string>();
      for (const entry of layout.edges) {
        if (entry.edge.type !== "ownership_overlap") continue;
        for (const match of entry.edge.matchedPaths ?? []) {
          if (match.kind === "locked") locked.add(match.path);
          if (match.kind === "unsafe_parallel_area") unsafe.add(match.path);
        }
      }
      if (locked.size > 0) {
        lines.push({
          text: `⚠ ${locked.size} locked-path collision(s): ${[...locked].join(", ")}`,
          color: "red",
        });
      }
      if (unsafe.size > 0) {
        lines.push({
          text: `⚠ ${unsafe.size} unsafe-parallel collision(s): ${[...unsafe].join(", ")}`,
          color: "red",
        });
      }
      if (lines.length === 0) lines.push({ text: "no ownership collisions", dim: true });
      break;
    }
    case "receipts": {
      const counts = receiptHealthCounts(packet);
      const failing = packet.nodes
        .filter((node) => node.receipt.health === "failing")
        .map((node) => node.taskId);
      const missing = packet.nodes
        .filter((node) => node.receipt.health === "missing")
        .map((node) => node.taskId);
      if (counts.failing > 0) {
        lines.push({
          text: `⚠ ${counts.failing} failing receipt(s): ${failing.join(", ")}`,
          color: "red",
        });
      }
      if (counts.missing > 0) {
        lines.push({
          text: `⚠ ${counts.missing} missing receipt(s): ${missing.join(", ")}`,
          color: "yellow",
        });
      }
      if (lines.length === 0) lines.push({ text: "no failing or missing receipts", dim: true });
      break;
    }
    case "status": {
      const blocked = packet.nodes
        .filter((node) => node.status === "blocked")
        .map((node) => node.taskId);
      if (blocked.length > 0) {
        lines.push({
          text: `⚠ ${blocked.length} blocked task(s): ${blocked.join(", ")}`,
          color: "red",
        });
      } else {
        lines.push({ text: "no blocked tasks", dim: true });
      }
      break;
    }
  }
  return lines;
}

function buildDetailLines(
  packet: TaskGraphPacket,
  layout: GraphLayout,
  lens: GraphLens,
  selectedId: string | null,
): ViewLine[] {
  if (!selectedId) return [];
  const selectedNode = packet.nodes.find((node) => node.taskId === selectedId);
  if (!selectedNode) return [];

  const lines: ViewLine[] = [{ text: `Detail — ${selectedId}`, bold: true }];

  switch (lens) {
    case "dependencies": {
      const upstream = upstreamNeighbors(packet, selectedId);
      const downstream = downstreamNeighbors(packet, selectedId);
      lines.push({ text: `  upstream: ${upstream.length > 0 ? upstream.join(", ") : "none"}` });
      lines.push({
        text: `  downstream: ${downstream.length > 0 ? downstream.join(", ") : "none"}`,
      });
      const cycles = layout.cycles.filter((cycle) => cycle.includes(selectedId));
      if (cycles.length > 0) {
        lines.push({
          text: `  cycles: ${cycles.map((cycle) => cycle.join(" ⇄ ")).join("; ")}`,
          color: "red",
        });
      }
      const incidentDangling = layout.edges
        .filter(
          (entry) =>
            (entry.edge.source === selectedId && !entry.b) ||
            (entry.edge.target === selectedId && !entry.a),
        )
        .map((entry) => (entry.edge.source === selectedId ? entry.edge.target : entry.edge.source));
      if (incidentDangling.length > 0) {
        lines.push({
          text: `  dangling references: ${incidentDangling.join(", ")}`,
          color: "yellow",
        });
      }
      break;
    }
    case "ownership": {
      lines.push({
        text: `  locked paths: ${selectedNode.lockedPaths.length > 0 ? selectedNode.lockedPaths.join(", ") : "none"}`,
        color: selectedNode.lockedPaths.length > 0 ? "red" : undefined,
      });
      lines.push({
        text: `  unsafe parallel areas: ${
          selectedNode.unsafeParallelAreas.length > 0
            ? selectedNode.unsafeParallelAreas.join(", ")
            : "none"
        }`,
        color: selectedNode.unsafeParallelAreas.length > 0 ? "red" : undefined,
      });
      const overlaps = layout.edges.filter(
        (entry) =>
          entry.edge.type === "ownership_overlap" &&
          (entry.edge.source === selectedId || entry.edge.target === selectedId),
      );
      if (overlaps.length === 0) {
        lines.push({ text: "  no ownership overlaps" });
      } else {
        lines.push({ text: `  overlaps (${overlaps.length}):` });
        for (const entry of overlaps) {
          const other = entry.edge.source === selectedId ? entry.edge.target : entry.edge.source;
          for (const match of entry.edge.matchedPaths ?? []) {
            const label = ownershipSeverityLabel(match.kind);
            const color =
              match.kind === "locked" || match.kind === "unsafe_parallel_area"
                ? "red"
                : match.kind === "touched"
                  ? "yellow"
                  : undefined;
            lines.push({ text: `    [${label}] ${match.path} ↔ ${match.otherPath}`, color });
          }
          if ((entry.edge.matchedPaths?.length ?? 0) === 0) {
            lines.push({ text: `    ${other} (no matched paths recorded)`, dim: true });
          }
        }
      }
      break;
    }
    case "receipts": {
      const receipt = selectedNode.receipt;
      lines.push({ text: `  receipt: ${receipt.health}`, color: receiptColor(receipt.health) });
      if (receipt.latestIdentifier)
        lines.push({ text: `  latest run log: ${receipt.latestIdentifier}` });
      if (receipt.result) lines.push({ text: `  result: ${receipt.result}` });
      if (receipt.isLatestSuperseded) {
        lines.push({ text: "  latest run log is superseded", color: "yellow" });
      }
      const verification = selectedNode.verification;
      lines.push({
        text: `  verification: ${verification.health}`,
        color: receiptColor(
          verification.health as "missing" | "incomplete" | "passing" | "failing",
        ),
      });
      if (verification.missingCommands.length > 0) {
        lines.push({
          text: `  missing commands: ${verification.missingCommands.join(", ")}`,
          color: "yellow",
        });
      }
      if (verification.failedCommands.length > 0) {
        lines.push({
          text: `  failed commands: ${verification.failedCommands.join(", ")}`,
          color: "red",
        });
      }
      const counts = receiptHealthCounts(packet);
      lines.push({
        text: `  counts — passing ${counts.passing} · failing ${counts.failing} · incomplete ${counts.incomplete} · missing ${counts.missing}`,
      });
      break;
    }
    case "status": {
      lines.push({
        text: `  status: ${selectedNode.status}`,
        color: statusColor(selectedNode.status),
      });
      lines.push({ text: `  tier: ${selectedNode.tier}` });
      const summary = [...statusCounts(packet).entries()]
        .map(([status, count]) => `${status} ${count}`)
        .join(" · ");
      lines.push({ text: `  counts — ${summary || "none"}` });
      break;
    }
  }
  return lines;
}

function buildGraphLines(
  state: GraphViewState,
  packet: TaskGraphPacket,
  layout: GraphLayout,
  selectedId: string | null,
  wide: boolean,
): ViewLine[] {
  const lines: ViewLine[] = [];
  lines.push(...buildHeaderLines(state, packet));
  lines.push(
    ...(wide
      ? buildWideGrid(layout, selectedId, state.focusTask)
      : buildNarrowList(layout, selectedId, state.focusTask)),
  );
  if (wide) {
    lines.push({ text: "", dim: true });
    lines.push(...buildEdgeLines(layout, state.lens));
  }
  lines.push({ text: "", dim: true });
  lines.push({ text: "Warnings:", bold: true });
  lines.push(...buildWarningLines(packet, layout, state.lens));
  const detail = buildDetailLines(packet, layout, state.lens, selectedId);
  if (detail.length > 0) {
    lines.push({ text: "", dim: true });
    lines.push(...detail);
  }
  lines.push({ text: "", dim: true });
  lines.push({ text: FOOTER, dim: true });
  return lines;
}

export function GraphView(props: GraphViewProps): React.ReactElement {
  const { graphService, focusTask, onDrillDown, onExit } = props;
  const { stdout } = useStdout();
  const [terminalWidth, setTerminalWidth] = useState(stdout.columns || 80);

  // Keep the wide/narrow layout decision in sync with terminal resize events.
  // Ink only re-flows the yoga tree on resize (it does not re-run component
  // logic), so the graph subscribes itself to switch between the layered grid
  // and the indented focus list as soon as the terminal width changes.
  useEffect(() => {
    const onResize = (): void => setTerminalWidth(stdout.columns || 80);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const [lens, setLens] = useState<GraphLens>("dependencies");
  const [depth, setDepth] = useState(2);
  const [allActive, setAllActive] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [domainFilter, setDomainFilter] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<GraphTaskTier | "all">("all");
  const [edgeTypeFilter, setEdgeTypeFilter] = useState<EdgeType | "all">("all");
  const [selectedId, setSelectedId] = useState(focusTask);
  const [packet, setPacket] = useState<TaskGraphPacket | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const buildOptions = (): TaskGraphOptions => {
      const options: TaskGraphOptions = { depth };
      if (allActive) {
        options.allTasks = true;
      } else {
        options.focusTask = focusTask;
      }
      if (statusFilter) options.status = statusFilter;
      if (domainFilter) options.domain = domainFilter;
      if (tierFilter !== "all") options.tier = tierFilter;
      if (edgeTypeFilter !== "all") options.edgeTypes = [edgeTypeFilter];
      return options;
    };

    const apply = (): void => {
      try {
        const fetched = graphService.getGraph(buildOptions());
        if (!cancelled) {
          setPacket(fetched);
          setGraphError(null);
        }
      } catch (error) {
        // When the active filters exclude the focus task entirely, fall back to
        // the same filters without focus so the reviewer still sees the filtered
        // node set instead of an error.
        if (error instanceof TaskGraphError && !allActive) {
          const fallback = buildOptions();
          delete fallback.focusTask;
          try {
            const fetched = graphService.getGraph(fallback);
            if (!cancelled) {
              setPacket(fetched);
              setGraphError(null);
            }
            return;
          } catch {
            // Fall through to the error path below.
          }
        }
        if (!cancelled) {
          setPacket(null);
          setGraphError(error instanceof Error ? error.message : String(error));
        }
      }
    };

    apply();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    graphService,
    focusTask,
    depth,
    allActive,
    statusFilter,
    domainFilter,
    tierFilter,
    edgeTypeFilter,
  ]);

  const layout = useMemo(
    () => (packet ? computeLayout(packet, allActive ? undefined : focusTask) : null),
    [packet, allActive, focusTask],
  );

  const visibleIds = layout ? layout.placed.map((entry) => entry.node.taskId) : [];
  const effectiveSelected = ((): string | null => {
    if (visibleIds.length === 0) return null;
    if (visibleIds.includes(selectedId)) return selectedId;
    if (visibleIds.includes(focusTask)) return focusTask;
    return visibleIds[0];
  })();

  const moveSelection = (delta: number): void => {
    if (visibleIds.length === 0) return;
    const current = visibleIds.indexOf(effectiveSelected ?? "");
    const next = Math.max(0, Math.min(current + delta, visibleIds.length - 1));
    setSelectedId(visibleIds[next]);
  };

  const gotoNeighbor = (direction: "upstream" | "downstream"): void => {
    if (!packet || !effectiveSelected) return;
    const neighbors =
      direction === "upstream"
        ? upstreamNeighbors(packet, effectiveSelected)
        : downstreamNeighbors(packet, effectiveSelected);
    if (neighbors.length > 0) setSelectedId(neighbors[0]);
  };

  const cycleLens = (): void => {
    setLens((current) => LENS_ORDER[(LENS_ORDER.indexOf(current) + 1) % LENS_ORDER.length]);
  };

  const expandDepth = (): void => {
    setDepth((current) => (current === -1 ? -1 : current >= 5 ? -1 : current + 1));
  };

  const contractDepth = (): void => {
    setDepth((current) => (current === -1 ? 5 : Math.max(1, current - 1)));
  };

  const cycleStatus = (): void => {
    if (!packet) return;
    const statuses = [...new Set(packet.nodes.map((node) => node.status))].sort();
    const list = ["all", ...statuses];
    const index = list.indexOf(statusFilter ?? "all");
    const next = list[(index + 1) % list.length];
    setStatusFilter(next === "all" ? null : next);
  };

  const cycleDomain = (): void => {
    if (!packet) return;
    const domains = [...new Set(packet.nodes.map((node) => node.domain))].sort();
    const list = ["all", ...domains];
    const index = list.indexOf(domainFilter ?? "all");
    const next = list[(index + 1) % list.length];
    setDomainFilter(next === "all" ? null : next);
  };

  const cycleTier = (): void => {
    const list: Array<GraphTaskTier | "all"> = ["all", "active", "completed", "archived"];
    const index = list.indexOf(tierFilter);
    setTierFilter(list[(index + 1) % list.length]);
  };

  const cycleEdgeType = (): void => {
    const list: Array<EdgeType | "all"> = [
      "all",
      "depends_on",
      "blocks",
      "conflicts_with",
      "ownership_overlap",
    ];
    const index = list.indexOf(edgeTypeFilter);
    setEdgeTypeFilter(list[(index + 1) % list.length]);
  };

  const resetFilters = (): void => {
    setDepth(2);
    setAllActive(false);
    setStatusFilter(null);
    setDomainFilter(null);
    setTierFilter("all");
    setEdgeTypeFilter("all");
  };

  useInput((input, key) => {
    if (key.tab) {
      cycleLens();
      return;
    }
    if (input === "j" || key.downArrow) {
      moveSelection(1);
      return;
    }
    if (input === "k" || key.upArrow) {
      moveSelection(-1);
      return;
    }
    if (input === "h") {
      gotoNeighbor("upstream");
      return;
    }
    if (input === "l") {
      gotoNeighbor("downstream");
      return;
    }
    if (key.return) {
      if (effectiveSelected) onDrillDown(effectiveSelected);
      return;
    }
    if (input === "g" || input === "q" || key.escape) {
      onExit();
      return;
    }
    if (input === "+" || input === "=") {
      expandDepth();
      return;
    }
    if (input === "-" || input === "_") {
      contractDepth();
      return;
    }
    if (input === "a") {
      setAllActive((value) => !value);
      return;
    }
    if (input === "s") {
      cycleStatus();
      return;
    }
    if (input === "d") {
      cycleDomain();
      return;
    }
    if (input === "t") {
      cycleTier();
      return;
    }
    if (input === "e") {
      cycleEdgeType();
      return;
    }
    if (input === "r") {
      resetFilters();
      return;
    }
  });

  let lines: ViewLine[];
  if (graphError) {
    lines = [
      { text: `Task Graph — focus: ${focusTask}`, bold: true },
      { text: `Graph error: ${graphError}`, color: "red" },
      { text: "g or Escape to return", dim: true },
    ];
  } else if (!packet || !layout) {
    lines = [
      { text: `Task Graph — focus: ${focusTask}`, bold: true },
      { text: "Loading task graph…", dim: true },
    ];
  } else {
    const wide = terminalWidth >= WIDE_TERMINAL_MIN_WIDTH;
    lines = buildGraphLines(
      { lens, depth, allActive, statusFilter, domainFilter, tierFilter, edgeTypeFilter, focusTask },
      packet,
      layout,
      effectiveSelected,
      wide,
    );
  }

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: rendered graph rows have no stable id and identical text repeats (separators, blank rows); index is the stable key.
          key={index}
          color={line.color}
          dimColor={line.dim}
          inverse={line.inverse}
          bold={line.bold}
        >
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
