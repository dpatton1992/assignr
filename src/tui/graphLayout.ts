import type {
  EdgeType,
  GraphEdge,
  GraphTaskNode,
  TaskGraphPacket,
  ReceiptHealth,
} from "../graph/taskGraphPacket.js";

/**
 * Deterministic, pure graph-model helpers for the review TUI graph view.
 *
 * These helpers only ever derive presentation state from a TaskGraphPacket:
 * dependency layering, display-only cycle breaking, lens metadata, neighbor
 * navigation, and badge/count summaries. No repository state (task YAML, run
 * logs, readiness, git) is read here.
 */

export type GraphLens = "dependencies" | "ownership" | "receipts" | "status";

export const LENS_ORDER: GraphLens[] = ["dependencies", "ownership", "receipts", "status"];

export const LENS_LABELS: Record<GraphLens, string> = {
  dependencies: "Dependencies",
  ownership: "Ownership",
  receipts: "Receipts",
  status: "Status",
};

export const EDGE_TYPE_ORDER: EdgeType[] = ["depends_on", "blocks", "conflicts_with", "ownership_overlap"];

export const EDGE_TYPE_LABELS: Record<EdgeType, string> = {
  depends_on: "depends_on",
  blocks: "blocks",
  conflicts_with: "conflicts_with",
  ownership_overlap: "ownership_overlap",
};

export const EDGE_GLYPHS: Record<EdgeType, string> = {
  depends_on: "─▶",
  blocks: "▸▶",
  conflicts_with: "══",
  ownership_overlap: "~~",
};

/**
 * Edge types whose lines are emphasized by each lens; the other edge lines
 * render dimmed. Every lens keeps the same topology — only emphasis, badges,
 * counts, warnings, and the detail panel change.
 */
export const LENS_EMPHASIZED_EDGES: Record<GraphLens, EdgeType[]> = {
  dependencies: ["depends_on", "blocks"],
  ownership: ["ownership_overlap"],
  receipts: EDGE_TYPE_ORDER,
  status: EDGE_TYPE_ORDER,
};

export interface PlacedNode {
  node: GraphTaskNode;
  /** Normalized dependency layer; 0-based, ascending with downstream depth. */
  column: number;
  /** Position within the layer, sorted by task id. */
  row: number;
}

export interface LayoutEdge {
  edge: GraphEdge;
  /** Source endpoint when present in the packet, otherwise null (dangling). */
  a: PlacedNode | null;
  /** Target endpoint when present in the packet, otherwise null (dangling). */
  b: PlacedNode | null;
}

export interface GraphLayout {
  placed: PlacedNode[];
  byId: Map<string, PlacedNode>;
  columnCount: number;
  maxRows: number;
  edges: LayoutEdge[];
  /** Display-only dependency/block cycles, each a closed task-id path. */
  cycles: string[][];
  dangling: string[];
}

/**
 * Break a directed dependency/block graph into display layers.
 *
 * Dependency depth determines the horizontal rank: for a `depends_on` edge
 * a -> b, b is one layer upstream (left) of a and a is one layer downstream
 * (right) of b. In focus mode the focus task anchors layer 0; otherwise the
 * dependency roots (tasks nothing depends on) anchor layer 0, falling back to
 * every node when the dependency graph has no roots (pure cycles).
 *
 * Cycles are broken deterministically for display only: the first layer
 * assignment wins, and all traversal orders are sorted by task id. The cycle
 * metadata itself is retained in `cycles` and rendered in the detail panel.
 */
export function computeLayout(packet: TaskGraphPacket, focusTask?: string): GraphLayout {
  const byNode = new Map(packet.nodes.map((node) => [node.taskId, node]));
  const anchored = focusTask !== undefined && byNode.has(focusTask);

  const dependsEdges = packet.edges.filter((edge) => edge.type === "depends_on");
  const prereqs = new Map<string, string[]>(); // a -> dependencies of a (upstream of a)
  const dependents = new Map<string, string[]>(); // b -> tasks depending on b (downstream of b)
  const collect = (map: Map<string, string[]>, key: string, value: string): void => {
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
  };
  for (const edge of dependsEdges) {
    collect(prereqs, edge.source, edge.target);
    collect(dependents, edge.target, edge.source);
  }
  for (const list of prereqs.values()) list.sort();
  for (const list of dependents.values()) list.sort();

  const layer = new Map<string, number>();
  const queue: string[] = [];

  if (anchored) {
    layer.set(focusTask, 0);
    queue.push(focusTask);
  } else {
    const incoming = new Set(dependsEdges.map((edge) => edge.target));
    const roots = packet.nodes
      .filter((node) => !incoming.has(node.taskId))
      .map((node) => node.taskId)
      .sort();
    const seeds = roots.length > 0 ? roots : packet.nodes.map((node) => node.taskId).sort();
    for (const id of seeds) {
      if (!layer.has(id)) {
        layer.set(id, 0);
        queue.push(id);
      }
    }
  }

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const currentLayer = layer.get(current) ?? 0;
    for (const dep of prereqs.get(current) ?? []) {
      if (!layer.has(dep)) {
        layer.set(dep, currentLayer - 1);
        queue.push(dep);
      }
    }
    for (const dependent of dependents.get(current) ?? []) {
      if (!layer.has(dependent)) {
        layer.set(dependent, currentLayer + 1);
        queue.push(dependent);
      }
    }
  }

  // Nodes unreachable through dependency edges (e.g. ownership-only neighbors)
  // share the focus/root layer deterministically.
  for (const node of packet.nodes) {
    if (!layer.has(node.taskId)) layer.set(node.taskId, 0);
  }

  const minLayer = packet.nodes.reduce(
    (min, node) => Math.min(min, layer.get(node.taskId) ?? 0),
    0
  );
  const columnOf = new Map<string, number>();
  for (const node of packet.nodes) {
    columnOf.set(node.taskId, (layer.get(node.taskId) ?? 0) - minLayer);
  }
  const columnCount =
    packet.nodes.reduce((max, node) => Math.max(max, columnOf.get(node.taskId) ?? 0), 0) + 1;

  const grouped = new Map<number, GraphTaskNode[]>();
  for (const node of packet.nodes) {
    const column = columnOf.get(node.taskId) ?? 0;
    const list = grouped.get(column) ?? [];
    list.push(node);
    grouped.set(column, list);
  }

  const placed: PlacedNode[] = [];
  const byId = new Map<string, PlacedNode>();
  for (const column of [...grouped.keys()].sort((a, b) => a - b)) {
    const nodes = grouped.get(column) ?? [];
    nodes.sort((a, b) => a.taskId.localeCompare(b.taskId));
    nodes.forEach((node, row) => {
      const entry: PlacedNode = { node, column, row };
      placed.push(entry);
      byId.set(node.taskId, entry);
    });
  }
  const maxRows = placed.reduce((max, entry) => Math.max(max, entry.row + 1), 0);

  const edges: LayoutEdge[] = packet.edges.map((edge) => ({
    edge,
    a: byId.get(edge.source) ?? null,
    b: byId.get(edge.target) ?? null,
  }));

  return {
    placed,
    byId,
    columnCount,
    maxRows,
    edges,
    cycles: findCycles(packet),
    dangling: packet.referencedButAbsent,
  };
}

/**
 * Find display-only cycles over directed depends_on and blocks edges.
 * Deterministic: nodes and adjacency lists are processed in sorted order, and
 * duplicate cycles are deduplicated by their sorted task-id signature.
 */
export function findCycles(packet: TaskGraphPacket): string[][] {
  const ids = packet.nodes.map((node) => node.taskId).sort();
  const adjacency = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of packet.edges) {
    if (edge.type !== "depends_on" && edge.type !== "blocks") continue;
    adjacency.get(edge.source)?.push(edge.target);
  }
  for (const list of adjacency.values()) list.sort();

  const cycles: string[][] = [];
  const seen = new Set<string>();
  const state = new Map<string, 0 | 1>(); // 0 = on the current DFS stack, 1 = done
  const stack: string[] = [];

  const visit = (node: string): void => {
    state.set(node, 0);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (next === node) {
        const signature = `${node},${node}`;
        if (!seen.has(signature)) {
          seen.add(signature);
          cycles.push([node, node]);
        }
        continue;
      }
      const nextState = state.get(next);
      if (nextState === 0) {
        const start = stack.indexOf(next);
        const cycle = [...stack.slice(start), next];
        const signature = [...cycle].sort().join(",");
        if (!seen.has(signature)) {
          seen.add(signature);
          cycles.push(cycle);
        }
      } else if (nextState === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 1);
  };

  for (const id of ids) {
    if (state.get(id) === undefined) visit(id);
  }
  return cycles;
}

/**
 * Visible dependency neighbors for h/l navigation. Upstream is what the
 * selected task depends on or is blocked by; downstream is what depends on or
 * is blocked by the selected task. Restricted to nodes present in the packet.
 */
export function upstreamNeighbors(packet: TaskGraphPacket, taskId: string): string[] {
  const visible = new Set(packet.nodes.map((node) => node.taskId));
  const result: string[] = [];
  for (const edge of packet.edges) {
    if (edge.type === "depends_on" && edge.source === taskId && visible.has(edge.target)) {
      result.push(edge.target);
    }
    if (edge.type === "blocks" && edge.target === taskId && visible.has(edge.source)) {
      result.push(edge.source);
    }
  }
  return [...new Set(result)].sort();
}

export function downstreamNeighbors(packet: TaskGraphPacket, taskId: string): string[] {
  const visible = new Set(packet.nodes.map((node) => node.taskId));
  const result: string[] = [];
  for (const edge of packet.edges) {
    if (edge.type === "depends_on" && edge.target === taskId && visible.has(edge.source)) {
      result.push(edge.source);
    }
    if (edge.type === "blocks" && edge.source === taskId && visible.has(edge.target)) {
      result.push(edge.target);
    }
  }
  return [...new Set(result)].sort();
}

export function statusColor(status: string): string {
  switch (status) {
    case "complete":
    case "approved":
      return "green";
    case "blocked":
    case "failed":
      return "red";
    case "needs_review":
    case "in_progress":
      return "yellow";
    case "pending":
    case "archived":
      return "gray";
    default:
      return "white";
  }
}

export function receiptColor(health: ReceiptHealth): string {
  switch (health) {
    case "passing":
      return "green";
    case "failing":
      return "red";
    case "incomplete":
      return "yellow";
    case "missing":
      return "gray";
  }
}

export type OwnershipSeverityLabel = "LOCKED" | "UNSAFE" | "touched" | "allowed";

export function ownershipSeverityLabel(
  kind: "allowed" | "touched" | "locked" | "unsafe_parallel_area"
): OwnershipSeverityLabel {
  switch (kind) {
    case "locked":
      return "LOCKED";
    case "unsafe_parallel_area":
      return "UNSAFE";
    case "touched":
      return "touched";
    case "allowed":
      return "allowed";
  }
}

export interface HealthCounts {
  missing: number;
  incomplete: number;
  passing: number;
  failing: number;
}

export function receiptHealthCounts(packet: TaskGraphPacket): HealthCounts {
  const counts: HealthCounts = { missing: 0, incomplete: 0, passing: 0, failing: 0 };
  for (const node of packet.nodes) {
    counts[node.receipt.health] += 1;
  }
  return counts;
}

/** Distinct status -> count over the packet nodes, sorted by status. */
export function statusCounts(packet: TaskGraphPacket): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of packet.nodes) {
    counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  }
  return new Map([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}
