import { spawnSync } from "child_process";
import { basename, dirname, join, relative } from "path";
import { loadTasks } from "../specs/loadTasks.js";
import type { LoadedTaskWithTier, TaskTier } from "../specs/loadTasks.js";
import type { TaskSpec } from "../specs/schema.js";
import { evaluateReviewReadiness, verificationCommandsMatch } from "./readiness.js";
import type {
  ReviewReadinessReport,
  ReviewReadinessRunLog,
} from "./readiness.js";
import {
  parseRunLogEvidence,
  readGitChangedFiles,
  readLatestRunLogContent,
} from "./evidence.js";
import { evaluateDeterministicReviewGate } from "./deterministicGate.js";
import type { DeterministicReviewBlocker } from "./deterministicGate.js";
import { pathMatchesPattern } from "../utils/pathUtils.js";
import { getManagedWorktree, isGitRepository } from "../worktrees/manager.js";
import type { ManagedWorktreeRecord } from "../worktrees/manager.js";

/**
 * ReviewPacket is the read-only application boundary for review presentation.
 * Presentation clients receive this assembled object instead of coordinating
 * direct reads of separate YAML, run-log, prompt, and git sources.
 *
 * All paths exposed here are repo-relative and JSON-safe.
 */

export type ChangedPathSource = "run-log" | "git-status" | "unavailable";

export type ReviewCommandStatus = "passed" | "failed" | "skipped" | "missing";

export interface ReviewChangedPath {
  path: string;
  source: Exclude<ChangedPathSource, "unavailable">;
  inAllowedPaths: boolean;
  inForbiddenPaths: boolean;
  forbiddenPattern?: string;
}

export interface ReviewCommandOutcome {
  command: string;
  status: ReviewCommandStatus;
  detail?: string;
}

export interface ReviewAcceptanceCriterion {
  criterion: string;
  evidence?: string;
  covered: boolean;
}

export interface ReviewDependencyStatus {
  taskId: string;
  status: string;
  complete: boolean;
}

export interface ReviewReceipt {
  result?: string;
  hasVerificationReceipt: boolean;
  verificationReceipt?: string;
  receiptParseError?: string;
}

export interface ReviewWorkerNotes {
  decisionsMade: string[];
  followUps: string[];
  risks?: string;
  notes?: string;
}

export interface ReviewDiffSummary {
  changedFileCount: number;
  source: ChangedPathSource;
  insertions?: number;
  deletions?: number;
}

export type ReviewDecisionId =
  | "approve"
  | "request_changes"
  | "reject"
  | "block"
  | "reopen";

export interface ReviewDecision {
  id: ReviewDecisionId;
  label: string;
  enabled: boolean;
  reason?: string;
}

export interface ReviewScopeDrift {
  /** Overall source of the concrete changed paths considered for drift. */
  source: ChangedPathSource;
  /** Concrete changed paths observed from the run log, git status, or both. */
  changedPaths: string[];
  /** Changed paths matching no declared allowed pattern (when allowed patterns exist). */
  outOfScopePaths: string[];
  /** Changed paths matching a declared forbidden pattern, with the matched pattern. */
  forbiddenPaths: Array<{ path: string; pattern: string }>;
  declaredAllowedPatterns: string[];
  declaredForbiddenPatterns: string[];
  hasDrift: boolean;
}

export interface ReviewPacket {
  taskId: string;
  title: string;
  status: string;
  tier: TaskTier;
  domain: string;
  priority: string;
  goal: string;
  worktree: {
    managed: boolean;
    workspacePath: string;
    branch?: string;
    baseSha?: string;
    headSha?: string;
    claimState?: string;
    dirty: boolean;
  };
  claimedScope: {
    allowedPaths: string[];
    forbiddenPaths: string[];
  };
  /** Overall source of the changed paths included below. */
  changedFilesSource: ChangedPathSource;
  changedPaths: ReviewChangedPath[];
  scopeDrift: ReviewScopeDrift;
  acceptanceCriteria: ReviewAcceptanceCriterion[];
  verification: {
    requiredCommands: string[];
    commandOutcomes: ReviewCommandOutcome[];
    failedOrMissingChecks: ReviewCommandOutcome[];
    hasVerification: boolean;
  };
  receipt: ReviewReceipt;
  workerNotes: ReviewWorkerNotes;
  risks: string[];
  warnings: string[];
  blockers: DeterministicReviewBlocker[];
  dependencies: ReviewDependencyStatus[];
  diffSummary: ReviewDiffSummary;
  availableDecisions: ReviewDecision[];
  readiness: ReviewReadinessReport;
}

export interface ReviewPacketContext {
  specsTasksDir: string;
  cwd: string;
  generatedDir?: string;
  activeDir?: string;
  completedDir?: string;
  archivedDir?: string;
}

export interface ReviewQueueRow {
  taskId: string;
  title: string;
  status: string;
  tier: TaskTier;
  domain: string;
  priority: string;
}

export interface ReviewQueueBucket {
  rows: ReviewQueueRow[];
  count: number;
}

export interface ReviewQueueSummary {
  needsReview: ReviewQueueBucket;
  blocked: ReviewQueueBucket;
  completed: ReviewQueueBucket;
  total: number;
}

export interface ReviewScopeDriftReport extends ReviewScopeDrift {
  taskId: string;
}

export class ReviewPacketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewPacketError";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function present(values: readonly (string | null | undefined)[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value?.trim()).filter(Boolean) as string[])];
}

function runLogChangedFiles(runLogs: readonly ReviewReadinessRunLog[]): string[] {
  return present(runLogs.flatMap((log) => log.filesChanged ?? []));
}

function changedPathsFor(
  runLogs: readonly ReviewReadinessRunLog[],
  gitChangedFiles: string[],
  spec: TaskSpec
): { changedPaths: ReviewChangedPath[]; source: ChangedPathSource } {
  const runLogFiles = new Set(runLogChangedFiles(runLogs));
  const gitFiles = unique(gitChangedFiles);
  const allFiles = unique([...runLogFiles, ...gitFiles]);
  const source: ChangedPathSource = runLogFiles.size > 0
    ? "run-log"
    : gitFiles.length > 0
      ? "git-status"
      : "unavailable";
  const allowed = spec.allowed_paths ?? [];
  const forbidden = spec.forbidden_paths ?? [];

  const changedPaths: ReviewChangedPath[] = allFiles.map((path) => {
    const pathSource = runLogFiles.has(path) ? "run-log" : "git-status";
    const forbiddenPattern = forbidden.find((pattern) => pathMatchesPattern(path, pattern));
    return {
      path,
      source: pathSource,
      inAllowedPaths: allowed.length === 0 || allowed.some((pattern) => pathMatchesPattern(path, pattern)),
      inForbiddenPaths: forbiddenPattern !== undefined,
      ...(forbiddenPattern ? { forbiddenPattern } : {}),
    };
  });

  return { changedPaths, source };
}

function scopeDriftFor(
  spec: TaskSpec,
  runLogs: readonly ReviewReadinessRunLog[],
  gitChangedFiles: string[],
  source: ChangedPathSource
): ReviewScopeDrift {
  const runLogFiles = new Set(runLogChangedFiles(runLogs));
  const gitFiles = unique(gitChangedFiles);
  const allFiles = unique([...runLogFiles, ...gitFiles]);
  const allowed = spec.allowed_paths ?? [];
  const forbidden = spec.forbidden_paths ?? [];

  const forbiddenPaths = allFiles.flatMap((path) => {
    const pattern = forbidden.find((entry) => pathMatchesPattern(path, entry));
    return pattern ? [{ path, pattern }] : [];
  });
  const forbiddenSet = new Set(forbiddenPaths.map((entry) => entry.path));
  const outOfScopePaths = allowed.length === 0
    ? []
    : allFiles.filter(
        (path) => !forbiddenSet.has(path) && !allowed.some((pattern) => pathMatchesPattern(path, pattern))
      );

  return {
    source,
    changedPaths: allFiles,
    outOfScopePaths,
    forbiddenPaths,
    declaredAllowedPatterns: allowed,
    declaredForbiddenPatterns: forbidden,
    hasDrift: outOfScopePaths.length > 0 || forbiddenPaths.length > 0,
  };
}

function acceptanceCriteriaFor(
  spec: TaskSpec,
  runLogs: readonly ReviewReadinessRunLog[],
  uncoveredCriteria: string[]
): ReviewAcceptanceCriterion[] {
  const entries = runLogs.flatMap((log) => log.acceptanceCriteriaEvidence ?? []);
  const evidenceByCriterion = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.criterion) continue;
    const key = entry.criterion.trim();
    const existing = evidenceByCriterion.get(key);
    if (existing === undefined || entry.evidence) {
      evidenceByCriterion.set(key, entry.evidence ?? existing ?? "");
    }
  }

  if (entries.length > 1 && entries.length === spec.acceptance_criteria.length) {
    entries.forEach((entry, index) => {
      const criterion = spec.acceptance_criteria[index];
      if (!evidenceByCriterion.has(criterion)) {
        evidenceByCriterion.set(criterion, entry.evidence ?? entry.criterion);
      }
    });
  }

  return spec.acceptance_criteria.map((criterion) => ({
    criterion,
    evidence: evidenceByCriterion.get(criterion) || undefined,
    covered: !uncoveredCriteria.includes(criterion),
  }));
}

/**
 * Mirror the recorded-command matching used by readiness so a required command
 * is only considered recorded when the receipt entry is exact or carries an
 * explicit result suffix (": passed", "-> exit code 0", "(ok)", ...).
 */
function requiredCommandOutcomes(
  requiredCommands: string[],
  runLogs: readonly ReviewReadinessRunLog[]
): ReviewCommandOutcome[] {
  const results = runLogs.flatMap((log) => log.commandResults ?? []);
  const recordedCommands = runLogs.flatMap((log) => [
    ...(log.commandsRun ?? []),
    ...(log.testsRun ?? []),
    ...(log.verificationCommands ?? []),
  ]);
  const receiptFailed = runLogs.some((log) =>
    (log.verificationResults ?? []).some((result) => /\b(?:fail|error|non[- ]?zero)\b/i.test(result))
  );

  return requiredCommands.map((command) => {
    const result = results.find((entry) => verificationCommandsMatch(command, entry.command));
    if (result) {
      const status = result.status === "passed" || result.status === "failed"
        ? result.status
        : "skipped";
      return {
        command,
        status,
        ...(result.result ? { detail: result.result } : {}),
      };
    }
    if (recordedCommands.some((entry) => verificationCommandsMatch(command, entry))) {
      return { command, status: "skipped" as const, detail: "recorded without a structured result" };
    }
    if (receiptFailed) {
      return { command, status: "failed" as const, detail: "verification receipt reports failure" };
    }
    return { command, status: "missing" as const };
  });
}

function dependencyStatusesFor(spec: TaskSpec, allTasks: LoadedTaskWithTier[]): ReviewDependencyStatus[] {
  return (spec.depends_on ?? []).map((depId) => {
    const dep = allTasks.find((task) => task.spec.id === depId);
    return {
      taskId: depId,
      status: dep?.spec.status ?? "missing",
      complete: dep?.spec.status === "complete",
    };
  });
}

function gitDiffLineStats(cwd: string, baseSha?: string): { insertions?: number; deletions?: number } {
  const result = spawnSync("git", ["diff", baseSha ?? "HEAD", "--numstat"], {
    cwd,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return {};

  let insertions = 0;
  let deletions = 0;
  let found = false;
  for (const line of result.stdout.split("\n")) {
    const [added, removed] = line.split("\t");
    if (/^\d+$/.test(added ?? "") && /^\d+$/.test(removed ?? "")) {
      insertions += Number(added);
      deletions += Number(removed);
      found = true;
    }
  }

  return found ? { insertions, deletions } : {};
}

function mancipleRootFromSpecsTasks(specsTasksDir: string): string {
  const last = basename(specsTasksDir);
  const parent = dirname(specsTasksDir);
  if (last === "tasks" && basename(parent) === "specs") return dirname(parent);
  if (["active", "completed", "archived"].includes(last)) return dirname(parent);
  return dirname(specsTasksDir);
}

function managedWorktreeFor(taskId: string, context: ReviewPacketContext): ManagedWorktreeRecord | undefined {
  if (!isGitRepository(context.cwd)) return undefined;
  return getManagedWorktree(taskId, {
    controlRepo: context.cwd,
    worktreesDir: join(mancipleRootFromSpecsTasks(context.specsTasksDir), "worktrees"),
    specsTasksDir: context.specsTasksDir,
  });
}

function gitHead(cwd: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function availableDecisionsFor(task: LoadedTaskWithTier): ReviewDecision[] {
  if (task.tier === "active" && task.spec.status === "needs_review") {
    return [
      { id: "approve", label: "Approve and move the task to completed", enabled: true },
      { id: "request_changes", label: "Request changes and return the task to in_progress", enabled: true },
      { id: "reject", label: "Reject the task and move it to failed", enabled: true },
      { id: "block", label: "Block review and set the task to blocked", enabled: true },
    ];
  }
  if (task.tier === "completed" || task.tier === "archived") {
    return [
      { id: "reopen", label: "Reopen the task to in_progress", enabled: true },
    ];
  }
  return [];
}

function findTaskOrThrow(taskId: string, context: ReviewPacketContext): LoadedTaskWithTier {
  const { tasks } = loadTasks(context.specsTasksDir, "all");
  const found = tasks.find((task) => task.spec.id === taskId);
  if (!found) {
    throw new ReviewPacketError(`Task not found: ${taskId}`);
  }
  return found;
}

export function getTaskReviewPacket(taskId: string, context: ReviewPacketContext): ReviewPacket {
  const { tasks } = loadTasks(context.specsTasksDir, "all");
  const found = tasks.find((task) => task.spec.id === taskId);
  if (!found) {
    throw new ReviewPacketError(`Task not found: ${taskId}`);
  }

  const runLogContent = readLatestRunLogContent(context.cwd, taskId);
  const runLogs = parseRunLogEvidence(runLogContent);
  const worktree = managedWorktreeFor(taskId, context);
  const evidenceCwd = worktree?.workspacePath ?? context.cwd;
  const gitChangedFiles = readGitChangedFiles(evidenceCwd, worktree?.baseSha);
  const readiness = evaluateReviewReadiness(found, { runLogs, gitChangedFiles });

  const gate = evaluateDeterministicReviewGate({
    specsTasksDir: context.specsTasksDir,
    cwd: context.cwd,
    taskId,
    generatedDir: context.generatedDir,
    activeDir: context.activeDir,
    completedDir: context.completedDir,
    archivedDir: context.archivedDir,
  });
  const blockers = [
    ...gate.loadBlockers.filter((blocker) => blocker.taskId === taskId),
    ...gate.taskReports.flatMap((report) => report.blockers),
  ];

  const { changedPaths, source } = changedPathsFor(runLogs, gitChangedFiles, found.spec);
  const latest = runLogs[0];
  const commandOutcomes = requiredCommandOutcomes(found.spec.verification.commands, runLogs);

  return {
    taskId: found.spec.id,
    title: found.spec.title,
    status: found.spec.status,
    tier: found.tier,
    domain: found.spec.domain,
    priority: found.spec.priority,
    goal: found.spec.goal,
    worktree: {
      managed: Boolean(worktree),
      workspacePath: worktree ? relative(context.cwd, worktree.workspacePath).replace(/\\/g, "/") : ".",
      ...(worktree ? {
        branch: worktree.branch,
        baseSha: worktree.baseSha,
        headSha: gitHead(worktree.workspacePath),
        claimState: worktree.claimState,
      } : {}),
      dirty: readGitChangedFiles(evidenceCwd).length > 0,
    },
    claimedScope: {
      allowedPaths: found.spec.allowed_paths ?? [],
      forbiddenPaths: found.spec.forbidden_paths ?? [],
    },
    changedFilesSource: source,
    changedPaths,
    scopeDrift: scopeDriftFor(found.spec, runLogs, gitChangedFiles, source),
    acceptanceCriteria: acceptanceCriteriaFor(
      found.spec,
      runLogs,
      readiness.uncoveredAcceptanceCriteria
    ),
    verification: {
      requiredCommands: found.spec.verification.commands,
      commandOutcomes,
      failedOrMissingChecks: commandOutcomes.filter(
        (outcome) => outcome.status === "failed" || outcome.status === "missing"
      ),
      hasVerification: readiness.hasVerification,
    },
    receipt: {
      result: latest?.result ?? undefined,
      hasVerificationReceipt: Boolean(latest?.verificationReceipt),
      verificationReceipt: latest?.verificationReceipt ?? undefined,
      receiptParseError: latest?.verificationReceiptParseError ?? undefined,
    },
    workerNotes: {
      decisionsMade: present(latest?.decisionsMade),
      followUps: present(latest?.followUps),
      risks: latest?.risks ?? undefined,
      notes: latest?.notes ?? undefined,
    },
    risks: readiness.documentedRisks,
    warnings: unique([
      ...readiness.humanReviewReasons,
      ...gate.taskReports.flatMap((report) => report.advisories.map((advisory) => advisory.reason)),
    ]),
    blockers,
    dependencies: dependencyStatusesFor(found.spec, tasks),
    diffSummary: {
      changedFileCount: changedPaths.length,
      source,
      ...gitDiffLineStats(evidenceCwd, worktree?.baseSha),
    },
    availableDecisions: availableDecisionsFor(found),
    readiness,
  };
}

export function getScopeDrift(taskId: string, context: ReviewPacketContext): ReviewScopeDriftReport {
  const found = findTaskOrThrow(taskId, context);
  const runLogs = parseRunLogEvidence(readLatestRunLogContent(context.cwd, taskId));
  const worktree = managedWorktreeFor(taskId, context);
  const gitChangedFiles = readGitChangedFiles(
    worktree?.workspacePath ?? context.cwd,
    worktree?.baseSha,
  );
  const { source } = changedPathsFor(runLogs, gitChangedFiles, found.spec);

  return {
    taskId,
    ...scopeDriftFor(found.spec, runLogs, gitChangedFiles, source),
  };
}

export function getReviewQueue(context: ReviewPacketContext): ReviewQueueSummary {
  const { tasks } = loadTasks(context.specsTasksDir, "all");
  const rows: ReviewQueueRow[] = tasks
    .map((task) => ({
      taskId: task.spec.id,
      title: task.spec.title,
      status: task.spec.status,
      tier: task.tier,
      domain: task.spec.domain,
      priority: task.spec.priority,
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));

  const bucket = (predicate: (row: ReviewQueueRow) => boolean): ReviewQueueBucket => {
    const filtered = rows.filter(predicate);
    return { rows: filtered, count: filtered.length };
  };

  return {
    needsReview: bucket((row) => row.status === "needs_review"),
    blocked: bucket((row) => row.status === "blocked"),
    completed: bucket((row) => row.status === "complete"),
    total: rows.length,
  };
}
