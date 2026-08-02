import { existsSync, readdirSync } from "fs";
import { basename, dirname, join, relative } from "path";
import { loadTasks, pathOwnershipWarningsForTask } from "../specs/loadTasks.js";
import type { LoadedTaskWithTier } from "../specs/loadTasks.js";
import { checkLifecyclePlacement } from "../lifecycle/placement.js";
import type { LifecyclePlacementIssue } from "../lifecycle/placement.js";
import {
  parseRunLogEvidence,
  readGitChangedFiles,
  readLatestRunLogContent,
} from "./evidence.js";
import { evaluateReviewReadiness } from "./readiness.js";
import type { ReviewReadinessReport } from "./readiness.js";
import { normalizePath, pathMatchesPattern } from "../utils/pathUtils.js";

export type DeterministicReviewBlockerKind =
  | "load-error"
  | "lifecycle-placement"
  | "status-mismatch"
  | "missing-evidence"
  | "missing-run-log"
  | "missing-generated-prompt"
  | "missing-review-log"
  | "blocked-dependency"
  | "completed-active"
  | "active-wrong-directory"
  | "path-policy"
  | "path-ownership";

export interface DeterministicReviewBlocker {
  taskId: string;
  kind: DeterministicReviewBlockerKind;
  reason: string;
}

export interface DeterministicReviewTaskReport {
  taskId: string;
  status: string;
  acceptanceCriteriaCount: number;
  ready: boolean;
  blockers: DeterministicReviewBlocker[];
  advisories: DeterministicReviewBlocker[];
  readiness?: ReviewReadinessReport;
}

export interface DeterministicReviewGateReport {
  ok: boolean;
  taskReports: DeterministicReviewTaskReport[];
  loadBlockers: DeterministicReviewBlocker[];
}

export interface DeterministicReviewGateOptions {
  specsTasksDir: string;
  cwd: string;
  taskId?: string;
  generatedDir?: string;
  activeDir?: string;
  completedDir?: string;
  archivedDir?: string;
}

const ACTIVE_STATUSES = new Set([
  "pending",
  "in_progress",
  "needs_review",
  "blocked",
  "failed",
  "partial",
]);

function mancipleRootFrom(tasksDir: string): string {
  const last = basename(tasksDir);
  const parent = dirname(tasksDir);

  if (last === "active" || last === "completed" || last === "archived") {
    return dirname(parent);
  }

  if (last === "tasks" && basename(parent) === "specs") {
    return dirname(parent);
  }

  return dirname(tasksDir);
}

function defaultDirs(specsTasksDir: string): Required<Pick<
  DeterministicReviewGateOptions,
  "generatedDir" | "activeDir" | "completedDir" | "archivedDir"
>> {
  const root = mancipleRootFrom(specsTasksDir);
  return {
    generatedDir: join(root, "prompts", "generated"),
    activeDir: join(root, "tasks", "active"),
    completedDir: join(root, "tasks", "completed"),
    archivedDir: join(root, "tasks", "archived"),
  };
}

function displayPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

function changedFilesFor(readiness: ReviewReadinessReport, gitChangedFiles: string[]): string[] {
  return readiness.changedFilesSource === "git-status" ? unique(gitChangedFiles) : [];
}

function filesFromRunLog(content: string | undefined): string[] {
  return parseRunLogEvidence(content).flatMap((log) => log.filesChanged ?? []);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalizePath).filter(Boolean))].sort();
}

function taskIdFromIssue(issue: LifecyclePlacementIssue): string {
  return basename(issue.file).replace(/\.ya?ml$/, "");
}

function hasGeneratedPrompt(generatedDir: string, taskId: string): boolean {
  return existsSync(join(generatedDir, `${taskId}.md`));
}

function hasReviewPrompt(generatedDir: string, taskId: string): boolean {
  return existsSync(join(generatedDir, `review-${taskId}.md`));
}

function hasReviewOutcomeLog(runsDir: string, taskId: string): boolean {
  if (!existsSync(runsDir)) return false;
  return readdirSync(runsDir).some((file) => file.endsWith(`-${taskId}-review-outcome.md`));
}

function dependencyIsBlocked(depId: string, tasks: LoadedTaskWithTier[]): boolean {
  const dep = tasks.find((task) => task.spec.id === depId);
  return !dep || dep.spec.status !== "complete";
}

function addPathPolicyBlockers(
  task: LoadedTaskWithTier,
  files: readonly string[],
  blockers: DeterministicReviewBlocker[]
): void {
  const changedFiles = unique([...files]);
  const allowed = task.spec.allowed_paths ?? [];
  const forbidden = task.spec.forbidden_paths ?? [];

  for (const file of changedFiles) {
    if (allowed.length > 0 && !allowed.some((pattern) => pathMatchesPattern(file, pattern))) {
      blockers.push({
        taskId: task.spec.id,
        kind: "path-policy",
        reason: `Changed file ${file} is outside allowed_paths.`,
      });
    }

    const forbiddenPattern = forbidden.find((pattern) => pathMatchesPattern(file, pattern));
    if (forbiddenPattern) {
      blockers.push({
        taskId: task.spec.id,
        kind: "path-policy",
        reason: `Changed file ${file} matches forbidden_paths entry ${forbiddenPattern}.`,
      });
    }
  }
}

export function evaluateDeterministicReviewGate(
  options: DeterministicReviewGateOptions
): DeterministicReviewGateReport {
  const defaults = defaultDirs(options.specsTasksDir);
  const dirs = {
    ...defaults,
    generatedDir: options.generatedDir ?? defaults.generatedDir,
    activeDir: options.activeDir ?? defaults.activeDir,
    completedDir: options.completedDir ?? defaults.completedDir,
    archivedDir: options.archivedDir ?? defaults.archivedDir,
  };
  const runsDir = join(mancipleRootFrom(options.specsTasksDir), "runs");
  const { tasks, errors } = loadTasks(options.specsTasksDir, "all");
  const loadBlockers: DeterministicReviewBlocker[] = errors.map((error) => ({
    taskId: basename(error.filePath).replace(/\.ya?ml$/, "<unknown>"),
    kind: "load-error",
    reason: `Task YAML failed to load: ${displayPath(options.cwd, error.filePath)}: ${error.error}`,
  }));

  const lifecycle = checkLifecyclePlacement({
    cwd: options.cwd,
    activeDir: dirs.activeDir,
    completedDir: dirs.completedDir,
    archivedDir: dirs.archivedDir,
  });
  const lifecycleBlockers = lifecycle.issues.map((issue) => ({
    taskId: taskIdFromIssue(issue),
    kind: "lifecycle-placement" as const,
    reason: `${issue.file}: ${issue.message}`,
  }));
  loadBlockers.push(...lifecycleBlockers);
  const gitChangedFiles = readGitChangedFiles(options.cwd);
  const targets = tasks.filter((task) => (
    options.taskId
      ? task.spec.id === options.taskId
      : task.tier === "active" && task.spec.status === "needs_review"
  ));

  const taskReports = targets.map((task) => {
    const runLogContent = readLatestRunLogContent(options.cwd, task.spec.id);
    const runLogs = parseRunLogEvidence(runLogContent);
    const readiness = evaluateReviewReadiness(task, { runLogs, gitChangedFiles });
    const blockers: DeterministicReviewBlocker[] = [
      ...readiness.missingEvidence.map((reason) => ({
        taskId: task.spec.id,
        kind: "missing-evidence" as const,
        reason,
      })),
    ];

    if (task.tier !== "active" && ACTIVE_STATUSES.has(task.spec.status)) {
      blockers.push({
        taskId: task.spec.id,
        kind: "active-wrong-directory",
        reason: `Active task status ${task.spec.status} is stored in ${task.tier}.`,
      });
    }
    if (task.tier === "active" && task.spec.status === "complete") {
      blockers.push({
        taskId: task.spec.id,
        kind: "completed-active",
        reason: "Completed task is still stored in active tasks.",
      });
    }
    if (!options.taskId && task.spec.status !== "needs_review") {
      blockers.push({
        taskId: task.spec.id,
        kind: "status-mismatch",
        reason: `Expected needs_review, found ${task.spec.status}.`,
      });
    }
    if (options.taskId && task.spec.status !== "needs_review") {
      blockers.push({
        taskId: task.spec.id,
        kind: "status-mismatch",
        reason: `Task is not ready for review: expected needs_review, found ${task.spec.status}.`,
      });
    }
    if (!runLogContent) {
      blockers.push({
        taskId: task.spec.id,
        kind: "missing-run-log",
        reason: `No run log is available for task ${task.spec.id}.`,
      });
    }
    if (!hasGeneratedPrompt(dirs.generatedDir, task.spec.id)) {
      blockers.push({
        taskId: task.spec.id,
        kind: "missing-generated-prompt",
        reason: `No generated implementation prompt found for ${task.spec.id}.`,
      });
    }
    if (!hasReviewPrompt(dirs.generatedDir, task.spec.id) && !hasReviewOutcomeLog(runsDir, task.spec.id)) {
      blockers.push({
        taskId: task.spec.id,
        kind: "missing-review-log",
        reason: `No review prompt or review outcome log found for ${task.spec.id}.`,
      });
    }
    for (const depId of task.spec.depends_on ?? []) {
      if (dependencyIsBlocked(depId, tasks)) {
        blockers.push({
          taskId: task.spec.id,
          kind: "blocked-dependency",
          reason: `Dependency ${depId} is not complete.`,
        });
      }
    }

    addPathPolicyBlockers(
      task,
      [
        ...filesFromRunLog(runLogContent),
        ...changedFilesFor(readiness, gitChangedFiles),
      ],
      blockers
    );

    const advisories = pathOwnershipWarningsForTask(task, tasks).map((warning) => ({
      taskId: task.spec.id,
      kind: "path-ownership" as const,
      reason: `Path ${warning.affected_path} overlaps ${warning.kind} claim ${warning.owner_path} by ${warning.owner_task_id}.`,
    }));

    return {
      taskId: task.spec.id,
      status: task.spec.status,
      acceptanceCriteriaCount: task.spec.acceptance_criteria.length,
      ready: blockers.length === 0,
      blockers,
      advisories,
      readiness,
    };
  });

  return {
    ok: loadBlockers.length === 0 && taskReports.every((report) => report.ready),
    taskReports,
    loadBlockers,
  };
}
