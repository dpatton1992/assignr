import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  findLatestRunLogPath,
  isRunLogSuperseded,
  parseRunLogEvidence,
} from "../review/evidence.js";
import type { ReviewReadinessReport, ReviewReadinessRunLog } from "../review/readiness.js";
import { evaluateReviewReadiness } from "../review/readiness.js";
import { getTaskReviewPacket } from "../review/reviewPacket.js";
import type { LoadedTaskWithTier, PathOwnershipWarning, TaskTier } from "../specs/loadTasks.js";
import { loadTasks, pathOwnershipWarningsForTask } from "../specs/loadTasks.js";
import type { TaskSpec } from "../specs/schema.js";
import { normalizePath } from "../utils/pathUtils.js";

/**
 * TaskGraphPacket is the read-only application boundary for graph presentation.
 * CLI, TUI, MCP, and web clients consume this assembled object instead of
 * coordinating direct reads of task YAML, run logs, readiness reports, and
 * ReviewPacket contracts themselves.
 *
 * The packet is presentation-neutral (nodes, edges, counts, filter metadata),
 * deterministic, and JSON-safe: every exposed path is repo-relative and no raw
 * absolute filesystem path or full run-log body is embedded.
 */

export type GraphTaskTier = TaskTier;

export type ReceiptHealth = "missing" | "incomplete" | "passing" | "failing";

export type VerificationHealth = "missing" | "incomplete" | "passing" | "failing";

export type EdgeType = "depends_on" | "blocks" | "conflicts_with" | "ownership_overlap";

/** Strength classification for an ownership overlap; higher is stronger. */
export type OwnershipOverlapKind = "allowed" | "touched" | "locked" | "unsafe_parallel_area";

export interface GraphReceiptSummary {
  /** Whether at least one run log exists for the task. */
  present: boolean;
  /**
   * Explicit health based on the latest non-superseded run log and its recorded
   * verification evidence. A command mention without a recorded result is never
   * classified as passing.
   */
  health: ReceiptHealth;
  /** Whether the newest run log file (by latest-receipt selection) is superseded. */
  isLatestSuperseded: boolean;
  /** Repo-relative identifier (file name) of the latest non-superseded run log. */
  latestIdentifier?: string;
  /** Recorded result of the latest non-superseded run log, when present. */
  result?: string;
}

export interface GraphVerificationSummary {
  health: VerificationHealth;
  hasVerification: boolean;
  missingCommands: string[];
  failedCommands: string[];
}

export interface GraphTaskNode {
  taskId: string;
  title: string;
  domain: string;
  priority: string;
  tier: GraphTaskTier;
  status: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  touchedPaths: string[];
  lockedPaths: string[];
  unsafeParallelAreas: string[];
  receipt: GraphReceiptSummary;
  verification: GraphVerificationSummary;
  /** Documented residual risks from the latest non-superseded run log. */
  risks: string[];
  /** Whether the detailed ReviewPacket contract can be assembled for this task. */
  hasDetailedReviewPacket: boolean;
}

export interface OwnershipOverlapMatch {
  /** Normalized pattern on the first endpoint side of the overlap. */
  path: string;
  /** Normalized pattern on the second endpoint side of the overlap. */
  otherPath: string;
  kind: OwnershipOverlapKind;
  /** Human-readable explanation of the overlap, including both task ids. */
  reason: string;
}

export interface GraphEdge {
  type: EdgeType;
  /** Declaring task id for directed edges; lexicographically smaller endpoint for undirected edges. */
  source: string;
  /** Referenced task id for directed edges; lexicographically larger endpoint for undirected edges. */
  target: string;
  directed: boolean;
  /** Concrete overlapping patterns; only present on ownership_overlap edges. */
  matchedPaths?: OwnershipOverlapMatch[];
  /** Strongest ownership collision on the edge; only present on ownership_overlap edges. */
  severity?: OwnershipOverlapKind;
}

export interface GraphCounts {
  nodes: number;
  edges: number;
  byEdgeType: Record<EdgeType, number>;
}

export interface GraphFilterMetadata {
  focusTask?: string;
  /** Effective traversal depth; -1 means unbounded. */
  traversalDepth: number;
  tier: GraphTaskTier | "all";
  status?: string;
  domain?: string;
  /** Edge types included in this packet, in canonical order. */
  edgeTypes: EdgeType[];
  allTasksMode: boolean;
}

export interface TaskGraphPacket {
  nodes: GraphTaskNode[];
  edges: GraphEdge[];
  counts: GraphCounts;
  filters: GraphFilterMetadata;
  /** Task ids referenced by included edges that are not present as nodes (dangling or filtered out). */
  referencedButAbsent: string[];
}

export interface TaskGraphContext {
  specsTasksDir: string;
  cwd: string;
  generatedDir?: string;
  activeDir?: string;
  completedDir?: string;
  archivedDir?: string;
}

export interface TaskGraphOptions {
  /** Restrict the packet to the neighborhood of this task. */
  focusTask?: string;
  /** Traversal depth for a focused neighborhood; default 2; -1 or Infinity for unbounded. */
  depth?: number;
  /** Lifecycle tier filter; "all" enables all-tiers loading. */
  tier?: GraphTaskTier | "all";
  /** Status filter applied to the node set. */
  status?: string;
  /** Domain filter applied to the node set. */
  domain?: string;
  /** Edge types to include; defaults to all four. */
  edgeTypes?: EdgeType[];
  /** Explicit all-tasks mode: load every tier instead of active plus referenced tasks. */
  allTasks?: boolean;
}

export class TaskGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskGraphError";
  }
}

const DEFAULT_DEPTH = 2;

const EDGE_TYPE_ORDER: EdgeType[] = ["depends_on", "blocks", "conflicts_with", "ownership_overlap"];

const OVERLAP_SEVERITY: Record<OwnershipOverlapKind, number> = {
  allowed: 0,
  touched: 1,
  unsafe_parallel_area: 2,
  locked: 3,
};

function sorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

/**
 * Candidate run log files for a task, mirroring the repository's own latest
 * receipt selection layout: a nested `.manciple/runs/<taskId>/` directory when
 * present, otherwise flat `.manciple/runs/<timestamp>-<taskId>.md` files.
 */
function runLogCandidates(cwd: string, taskId: string): string[] {
  const runsDir = join(cwd, ".manciple", "runs");
  const taskRunLogDir = join(runsDir, taskId);

  if (existsSync(taskRunLogDir)) {
    return readdirSync(taskRunLogDir)
      .filter((file) => file.endsWith(".md"))
      .sort()
      .map((file) => join(taskRunLogDir, file));
  }
  if (existsSync(runsDir)) {
    return readdirSync(runsDir)
      .filter((file) => file.endsWith(`-${taskId}.md`))
      .sort()
      .map((file) => join(runsDir, file));
  }
  return [];
}

/**
 * Select the latest non-superseded run log for a task. Uses the repository's
 * latest receipt selection (`findLatestRunLogPath`) as the primary source and
 * only walks back over superseded candidates when the selected latest file is
 * itself superseded.
 */
function latestNonSupersededRunLog(
  cwd: string,
  taskId: string,
): { path: string; content: string } | undefined {
  const latestPath = findLatestRunLogPath(cwd, taskId);
  if (!latestPath) return undefined;

  const latestContent = readFileSync(latestPath, "utf-8").trim();
  if (!isRunLogSuperseded(latestContent)) {
    return { path: latestPath, content: latestContent };
  }

  for (const file of [...runLogCandidates(cwd, taskId)].reverse()) {
    const content = readFileSync(file, "utf-8").trim();
    if (!isRunLogSuperseded(content)) {
      return { path: file, content };
    }
  }
  return undefined;
}

function receiptHealthFor(
  logs: ReviewReadinessRunLog[],
  readiness: ReviewReadinessReport,
): ReceiptHealth {
  if (logs.length === 0) return "missing";
  const latestResult = (logs[0]?.result ?? "").toLowerCase();
  if (
    /\b(?:failed|blocked)\b/.test(latestResult) ||
    readiness.failedVerificationCommands.length > 0
  ) {
    return "failing";
  }
  if (readiness.hasVerification) return "passing";
  return "incomplete";
}

function verificationHealthFor(readiness: ReviewReadinessReport): VerificationHealth {
  if (!readiness.hasRunLog) return "missing";
  if (readiness.failedVerificationCommands.length > 0) return "failing";
  if (readiness.hasVerification) return "passing";
  return "incomplete";
}

function receiptAndReadiness(
  cwd: string,
  taskId: string,
  spec: TaskSpec,
): { receipt: GraphReceiptSummary; readiness: ReviewReadinessReport } {
  const latestPath = findLatestRunLogPath(cwd, taskId);

  if (!latestPath) {
    return {
      receipt: { present: false, health: "missing", isLatestSuperseded: false },
      readiness: evaluateReviewReadiness(spec, {}),
    };
  }

  const latestContent = readFileSync(latestPath, "utf-8").trim();
  const isLatestSuperseded = isRunLogSuperseded(latestContent);
  const selection = latestNonSupersededRunLog(cwd, taskId);
  const logs = selection ? parseRunLogEvidence(selection.content) : [];
  const readiness = evaluateReviewReadiness(spec, { runLogs: logs });

  return {
    receipt: {
      present: true,
      health: logs.length === 0 ? "incomplete" : receiptHealthFor(logs, readiness),
      isLatestSuperseded,
      ...(selection ? { latestIdentifier: basename(selection.path) } : {}),
      ...(logs[0]?.result ? { result: logs[0].result } : {}),
    },
    readiness,
  };
}

function detailedReviewPacketAvailable(taskId: string, context: TaskGraphContext): boolean {
  try {
    getTaskReviewPacket(taskId, {
      specsTasksDir: context.specsTasksDir,
      cwd: context.cwd,
      generatedDir: context.generatedDir,
      activeDir: context.activeDir,
      completedDir: context.completedDir,
      archivedDir: context.archivedDir,
    });
    return true;
  } catch {
    return false;
  }
}

function nodeFor(task: LoadedTaskWithTier, context: TaskGraphContext): GraphTaskNode {
  const spec = task.spec;
  const { receipt, readiness } = receiptAndReadiness(context.cwd, spec.id, spec);

  return {
    taskId: spec.id,
    title: spec.title,
    domain: spec.domain,
    priority: spec.priority,
    tier: task.tier,
    status: spec.status,
    allowedPaths: sorted(spec.allowed_paths ?? []),
    forbiddenPaths: sorted(spec.forbidden_paths ?? []),
    touchedPaths: sorted(spec.path_ownership.touched_paths),
    lockedPaths: sorted(spec.path_ownership.locked_paths),
    unsafeParallelAreas: sorted(spec.path_ownership.unsafe_parallel_areas),
    receipt,
    verification: {
      health: verificationHealthFor(readiness),
      hasVerification: readiness.hasVerification,
      missingCommands: readiness.absentVerificationCommands,
      failedCommands: readiness.failedVerificationCommands,
    },
    risks: readiness.documentedRisks,
    hasDetailedReviewPacket: detailedReviewPacketAvailable(spec.id, context),
  };
}

function canonicalPair(a: string, b: string): { source: string; target: string } {
  return a <= b ? { source: a, target: b } : { source: b, target: a };
}

function overlapVerb(kind: OwnershipOverlapKind): string {
  switch (kind) {
    case "locked":
      return "locks";
    case "unsafe_parallel_area":
      return "flags unsafe parallel area";
    case "touched":
      return "touches";
    case "allowed":
      return "claims";
  }
}

/**
 * Classify a repository path-ownership warning. The loader emits kind "touched"
 * for both explicit touched claims and the allowed-path fallback; the fallback
 * (owner declares no touched paths) is ordinary allowed overlap and is weaker.
 */
function classifyOverlap(
  warning: PathOwnershipWarning,
  owner: LoadedTaskWithTier,
): OwnershipOverlapKind {
  if (warning.kind === "locked") return "locked";
  if (warning.kind === "unsafe_parallel_area") return "unsafe_parallel_area";
  if (warning.kind === "touched") {
    return (owner.spec.path_ownership.touched_paths ?? []).length > 0 ? "touched" : "allowed";
  }
  return "allowed";
}

function ownershipMatchesForPair(
  first: LoadedTaskWithTier,
  second: LoadedTaskWithTier,
): OwnershipOverlapMatch[] {
  const warnings: Array<{
    warning: PathOwnershipWarning;
    target: LoadedTaskWithTier;
    owner: LoadedTaskWithTier;
  }> = [
    ...pathOwnershipWarningsForTask(first, [second]).map((warning) => ({
      warning,
      target: first,
      owner: second,
    })),
    ...pathOwnershipWarningsForTask(second, [first]).map((warning) => ({
      warning,
      target: second,
      owner: first,
    })),
  ];

  return warnings
    .map(({ warning, target, owner }) => {
      const kind = classifyOverlap(warning, owner);
      const affectedPath = normalizePath(warning.affected_path);
      const ownerPath = normalizePath(warning.owner_path);
      return {
        path: affectedPath,
        otherPath: ownerPath,
        kind,
        reason: `${warning.owner_task_id} ${overlapVerb(kind)} ${ownerPath}; overlaps allowed path ${affectedPath} of ${target.spec.id}`,
      };
    })
    .sort((a, b) => {
      const severityDiff = OVERLAP_SEVERITY[b.kind] - OVERLAP_SEVERITY[a.kind];
      if (severityDiff !== 0) return severityDiff;
      return a.path.localeCompare(b.path) || a.otherPath.localeCompare(b.otherPath);
    });
}

function strongestKind(matches: OwnershipOverlapMatch[]): OwnershipOverlapKind {
  return matches.reduce<OwnershipOverlapKind>(
    (best, match) => (OVERLAP_SEVERITY[match.kind] > OVERLAP_SEVERITY[best] ? match.kind : best),
    "allowed",
  );
}

function compareEdges(a: GraphEdge, b: GraphEdge): number {
  const typeDiff = EDGE_TYPE_ORDER.indexOf(a.type) - EDGE_TYPE_ORDER.indexOf(b.type);
  if (typeDiff !== 0) return typeDiff;
  return a.source.localeCompare(b.source) || a.target.localeCompare(b.target);
}

function buildEdges(baseTasks: LoadedTaskWithTier[], edgeTypes: Set<EdgeType>): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (edge: GraphEdge): void => {
    const key = `${edge.type}\u0000${edge.source}\u0000${edge.target}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  for (const task of baseTasks) {
    if (edgeTypes.has("depends_on")) {
      for (const depId of task.spec.depends_on ?? []) {
        addEdge({ type: "depends_on", source: task.spec.id, target: depId, directed: true });
      }
    }
    if (edgeTypes.has("blocks")) {
      for (const blockedId of task.spec.blocks ?? []) {
        addEdge({ type: "blocks", source: task.spec.id, target: blockedId, directed: true });
      }
    }
    if (edgeTypes.has("conflicts_with")) {
      for (const conflictId of task.spec.conflicts_with ?? []) {
        const { source, target } = canonicalPair(task.spec.id, conflictId);
        addEdge({ type: "conflicts_with", source, target, directed: false });
      }
    }
  }

  if (edgeTypes.has("ownership_overlap")) {
    const ids = baseTasks.map((task) => task.spec.id).sort();
    const byId = new Map(baseTasks.map((task) => [task.spec.id, task]));
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const first = byId.get(ids[i]);
        const second = byId.get(ids[j]);
        if (!first || !second) continue;
        const matches = ownershipMatchesForPair(first, second);
        if (matches.length > 0) {
          addEdge({
            type: "ownership_overlap",
            source: ids[i],
            target: ids[j],
            directed: false,
            matchedPaths: matches,
            severity: strongestKind(matches),
          });
        }
      }
    }
  }

  return edges.sort(compareEdges);
}

function resolveBaseTasks(
  context: TaskGraphContext,
  options: TaskGraphOptions,
): LoadedTaskWithTier[] {
  const { tasks } = loadTasks(context.specsTasksDir, "all");
  const allTasksMode = options.allTasks === true || options.tier === "all";

  let base: LoadedTaskWithTier[];
  if (allTasksMode) {
    base = tasks;
  } else {
    const active = tasks.filter((task) => task.tier === "active");
    const referencedIds = new Set<string>();
    for (const task of active) {
      for (const id of task.spec.depends_on ?? []) referencedIds.add(id);
      for (const id of task.spec.blocks ?? []) referencedIds.add(id);
      for (const id of task.spec.conflicts_with ?? []) referencedIds.add(id);
    }
    base = [
      ...active,
      ...tasks.filter((task) => task.tier !== "active" && referencedIds.has(task.spec.id)),
    ];
  }

  return base.filter((task) => {
    if (options.tier && options.tier !== "all" && task.tier !== options.tier) return false;
    if (options.status && task.spec.status !== options.status) return false;
    if (options.domain && task.spec.domain !== options.domain) return false;
    return true;
  });
}

function resolveDepth(depth: number | undefined): number {
  if (depth === undefined) return DEFAULT_DEPTH;
  if (depth === -1 || depth === Infinity) return -1;
  if (depth < 0 || Number.isNaN(depth)) {
    throw new TaskGraphError(`Invalid traversal depth: ${depth}`);
  }
  return Math.floor(depth);
}

function resolveEdgeTypes(types: EdgeType[] | undefined): EdgeType[] {
  if (!types) return [...EDGE_TYPE_ORDER];
  const selected = new Set<EdgeType>();
  for (const type of types) {
    if (!EDGE_TYPE_ORDER.includes(type)) {
      throw new TaskGraphError(`Unknown edge type: ${String(type)}`);
    }
    selected.add(type);
  }
  return EDGE_TYPE_ORDER.filter((type) => selected.has(type));
}

/**
 * Traverse both incoming and outgoing edges from the focus task up to the
 * requested depth. Depth -1 means unbounded. Only ids that are actual graph
 * nodes join the frontier; dangling references stay as edge endpoints.
 */
function neighborhoodNodeIds(
  focusTask: string,
  edges: GraphEdge[],
  depth: number,
  nodeIds: Set<string>,
): Set<string> {
  const included = new Set<string>([focusTask]);
  let frontier = new Set<string>([focusTask]);
  let hops = 0;

  while (frontier.size > 0 && (depth < 0 || hops < depth)) {
    const next = new Set<string>();
    for (const edge of edges) {
      if (frontier.has(edge.source) && nodeIds.has(edge.target) && !included.has(edge.target)) {
        next.add(edge.target);
      }
      if (frontier.has(edge.target) && nodeIds.has(edge.source) && !included.has(edge.source)) {
        next.add(edge.source);
      }
    }
    if (next.size === 0) break;
    for (const id of next) included.add(id);
    frontier = next;
    hops += 1;
  }

  return included;
}

/**
 * Assemble a deterministic, JSON-safe TaskGraphPacket.
 *
 * By default the node set contains all active tasks plus completed or archived
 * tasks directly referenced by them (via depends_on, blocks, or conflicts_with).
 * Pass `allTasks: true` (or `tier: "all"`) to load every tier.
 *
 * When `options.focusTask` is set, nodes and edges are restricted to the
 * focused neighborhood traversing both incoming and outgoing edges up to
 * `options.depth` (default 2, -1 or Infinity for unbounded).
 */
export function getTaskGraphPacket(
  options: TaskGraphOptions,
  context: TaskGraphContext,
): TaskGraphPacket {
  const allTasksMode = options.allTasks === true || options.tier === "all";
  const depth = resolveDepth(options.depth);
  const edgeTypes = resolveEdgeTypes(options.edgeTypes);
  const edgeTypeSet = new Set(edgeTypes);
  const baseTasks = resolveBaseTasks(context, options);

  const nodes = baseTasks
    .map((task) => nodeFor(task, context))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
  const loadedNodeIds = new Set(nodes.map((node) => node.taskId));
  const edges = buildEdges(baseTasks, edgeTypeSet);

  let selectedIds: Set<string>;
  if (options.focusTask) {
    if (!loadedNodeIds.has(options.focusTask)) {
      throw new TaskGraphError(`Task not found in graph: ${options.focusTask}`);
    }
    selectedIds = neighborhoodNodeIds(options.focusTask, edges, depth, loadedNodeIds);
  } else {
    selectedIds = new Set(loadedNodeIds);
  }

  const selectedNodes = nodes.filter((node) => selectedIds.has(node.taskId));
  const selectedEdges = edges.filter((edge) => {
    const sourceSelected = selectedIds.has(edge.source);
    const targetSelected = selectedIds.has(edge.target);
    if (sourceSelected && targetSelected) return true;
    // Keep edges that reference a task absent from the packet entirely (dangling
    // references or tasks excluded by node filters).
    const sourceLoaded = loadedNodeIds.has(edge.source);
    const targetLoaded = loadedNodeIds.has(edge.target);
    return (sourceSelected && !targetLoaded) || (targetSelected && !sourceLoaded);
  });

  const referencedIds = new Set<string>();
  for (const edge of selectedEdges) {
    referencedIds.add(edge.source);
    referencedIds.add(edge.target);
  }
  const referencedButAbsent = [...referencedIds].filter((id) => !loadedNodeIds.has(id)).sort();

  const byEdgeType: Record<EdgeType, number> = {
    depends_on: 0,
    blocks: 0,
    conflicts_with: 0,
    ownership_overlap: 0,
  };
  for (const edge of selectedEdges) {
    byEdgeType[edge.type] += 1;
  }

  return {
    nodes: selectedNodes,
    edges: selectedEdges,
    counts: {
      nodes: selectedNodes.length,
      edges: selectedEdges.length,
      byEdgeType,
    },
    filters: {
      ...(options.focusTask ? { focusTask: options.focusTask } : {}),
      traversalDepth: depth,
      tier: options.tier ?? (allTasksMode ? "all" : "active"),
      ...(options.status ? { status: options.status } : {}),
      ...(options.domain ? { domain: options.domain } : {}),
      edgeTypes,
      allTasksMode,
    },
    referencedButAbsent,
  };
}

/**
 * Convenience wrapper for a focused neighborhood: assembles the graph and
 * restricts it to the tasks reachable from `taskId` in both directions up to
 * the requested depth (default 2; -1 or Infinity for unbounded).
 */
export function getTaskGraphNeighborhood(
  taskId: string,
  options: TaskGraphOptions,
  context: TaskGraphContext,
): TaskGraphPacket {
  return getTaskGraphPacket({ ...options, focusTask: taskId }, context);
}
