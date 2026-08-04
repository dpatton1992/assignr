import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadTasks } from "../specs/loadTasks.js";

export type WorktreeClaimState =
  | "available"
  | "assigned"
  | "review_ready"
  | "integrating"
  | "integrated_pending_completion";

export interface ManagedWorktreeRecord {
  taskId: string;
  controlRepo: string;
  workspacePath: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  claimState: WorktreeClaimState;
  integratedSha?: string;
}

interface WorktreeRegistry {
  version: 1;
  worktrees: Record<string, ManagedWorktreeRecord>;
}

export type GitRunner = (args: string[], cwd: string) => string;

export interface WorktreeServiceOptions {
  controlRepo: string;
  worktreesDir: string;
  specsTasksDir?: string;
  runner?: GitRunner;
}

export interface PrepareWorktreeOptions extends WorktreeServiceOptions {
  claim?: boolean;
}

export interface RemoveWorktreeOptions extends WorktreeServiceOptions {
  force?: boolean;
  deleteBranch?: boolean;
}

export interface WorktreePruneResult {
  removedRecords: string[];
  prunedGitMetadata: boolean;
}

const REGISTRY_VERSION = 1 as const;
const LOCK_STALE_MS = 5 * 60 * 1000;

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(runner: GitRunner, args: string[], cwd: string): string | undefined {
  try {
    return runner(args, cwd);
  } catch {
    return undefined;
  }
}

export function isGitRepository(controlRepo: string, runner: GitRunner = runGit): boolean {
  return tryGit(runner, ["rev-parse", "--git-dir"], canonical(controlRepo)) !== undefined;
}

function canonical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(canonical(parent), basename(absolute));
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(canonical(parent), canonical(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function safeTaskId(taskId: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(taskId);
}

function gitCommonDir(controlRepo: string, runner: GitRunner): string {
  const raw = runner(["rev-parse", "--git-common-dir"], controlRepo);
  return canonical(isAbsolute(raw) ? raw : resolve(controlRepo, raw));
}

function registryPaths(
  controlRepo: string,
  runner: GitRunner,
): {
  dir: string;
  file: string;
  lock: string;
} {
  const dir = join(gitCommonDir(controlRepo, runner), "manciple");
  return { dir, file: join(dir, "worktrees-v1.json"), lock: join(dir, "worktrees.lock") };
}

function emptyRegistry(): WorktreeRegistry {
  return { version: REGISTRY_VERSION, worktrees: {} };
}

function readRegistry(file: string): WorktreeRegistry {
  if (!existsSync(file)) return emptyRegistry();
  const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<WorktreeRegistry>;
  if (
    parsed.version !== REGISTRY_VERSION ||
    !parsed.worktrees ||
    typeof parsed.worktrees !== "object"
  ) {
    throw new Error(`Unsupported or malformed Manciple worktree registry: ${file}`);
  }
  return parsed as WorktreeRegistry;
}

function writeRegistry(file: string, registry: WorktreeRegistry): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
  renameSync(tmp, file);
}

function withRegistry<T>(
  controlRepo: string,
  runner: GitRunner,
  operation: (registry: WorktreeRegistry, file: string) => T,
): T {
  const paths = registryPaths(controlRepo, runner);
  mkdirSync(paths.dir, { recursive: true });

  if (existsSync(paths.lock)) {
    const age = Date.now() - statSync(paths.lock).mtimeMs;
    if (age > LOCK_STALE_MS) unlinkSync(paths.lock);
  }

  let fd: number;
  try {
    fd = openSync(paths.lock, "wx");
  } catch {
    throw new Error("Another Manciple worktree operation is in progress. Retry when it finishes.");
  }

  try {
    const registry = readRegistry(paths.file);
    return operation(registry, paths.file);
  } finally {
    closeSync(fd);
    if (existsSync(paths.lock)) unlinkSync(paths.lock);
  }
}

function ensurePrimaryCheckout(
  controlRepo: string,
  runner: GitRunner,
): {
  primary: string;
  branch: string;
  head: string;
} {
  const top = canonical(runner(["rev-parse", "--show-toplevel"], controlRepo));
  const porcelain = runner(["worktree", "list", "--porcelain"], controlRepo);
  const firstLine = porcelain.split(/\r?\n/).find((line) => line.startsWith("worktree "));
  const primary = firstLine ? canonical(firstLine.slice("worktree ".length)) : top;
  if (top !== primary) {
    throw new Error(`Manciple control operations must use the primary checkout: ${primary}`);
  }
  const branch = runner(["symbolic-ref", "--quiet", "--short", "HEAD"], controlRepo);
  if (!branch) throw new Error("The primary checkout must be on a branch, not detached HEAD.");
  return { primary, branch, head: runner(["rev-parse", "HEAD"], controlRepo) };
}

export function primaryCodeChanges(options: WorktreeServiceOptions): string[] {
  const runner = options.runner ?? runGit;
  const controlRepo = canonical(options.controlRepo);
  const rootRelative = relative(controlRepo, canonical(dirname(options.worktreesDir))).replace(
    /\\/g,
    "/",
  );
  const allowedPrefixes = [
    `${rootRelative}/tasks/`,
    `${rootRelative}/specs/tasks/`,
    `${rootRelative}/runs/`,
    `${rootRelative}/state/`,
    `${rootRelative}/prompts/generated/`,
    `${rootRelative}/worktrees/`,
  ];
  const allowedFiles = new Set([`${rootRelative}/config.yaml`, `${rootRelative}/domains.yaml`]);
  const tracked = runner(["diff", "--name-only", "HEAD"], controlRepo);
  const untracked = runner(["ls-files", "--others", "--exclude-standard"], controlRepo);
  return [
    ...new Set(
      `${tracked}\n${untracked}`
        .split(/\r?\n/)
        .map((path) => path.trim().replace(/\\/g, "/"))
        .filter(Boolean),
    ),
  ]
    .filter((path) => !allowedFiles.has(path))
    .filter(
      (path) =>
        !allowedPrefixes.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix)),
    );
}

function ensureLocalExclude(controlRepo: string, worktreesDir: string, runner: GitRunner): void {
  const common = gitCommonDir(controlRepo, runner);
  const infoDir = join(common, "info");
  const excludePath = join(infoDir, "exclude");
  const pattern = `${relative(controlRepo, worktreesDir).replace(/\\/g, "/")}/`;
  mkdirSync(infoDir, { recursive: true });
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
  if (!existing.split(/\r?\n/).includes(pattern)) {
    appendFileSync(
      excludePath,
      `${existing && !existing.endsWith("\n") ? "\n" : ""}${pattern}\n`,
      "utf-8",
    );
  }
}

function validateTask(taskId: string, specsTasksDir?: string): void {
  if (!safeTaskId(taskId)) {
    throw new Error(`Invalid task id for a worktree: ${taskId}`);
  }
  if (!specsTasksDir) return;
  const { tasks, errors } = loadTasks(specsTasksDir, "all");
  if (errors.length > 0) {
    throw new Error(`Cannot prepare worktree while task specs are invalid: ${errors[0].error}`);
  }
  const task = tasks.find((entry) => entry.spec.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.tier !== "active") throw new Error(`Task ${taskId} is not active.`);
  if (!["pending", "in_progress", "needs_review"].includes(task.spec.status)) {
    throw new Error(`Task ${taskId} cannot use a worktree while status is ${task.spec.status}.`);
  }
}

function worktreeExistsAt(path: string, branch: string, runner: GitRunner): boolean {
  const actual = tryGit(runner, ["-C", path, "branch", "--show-current"], path);
  return actual === branch;
}

export function getManagedWorktree(
  taskId: string,
  options: WorktreeServiceOptions,
): ManagedWorktreeRecord | undefined {
  const runner = options.runner ?? runGit;
  return withRegistry(
    canonical(options.controlRepo),
    runner,
    (registry) => registry.worktrees[taskId],
  );
}

export function listManagedWorktrees(options: WorktreeServiceOptions): ManagedWorktreeRecord[] {
  const runner = options.runner ?? runGit;
  return withRegistry(canonical(options.controlRepo), runner, (registry) =>
    Object.values(registry.worktrees).sort((a, b) => a.taskId.localeCompare(b.taskId)),
  );
}

export function findManagedWorktreeByWorkspace(
  workspace: string,
  options: WorktreeServiceOptions,
): ManagedWorktreeRecord | undefined {
  const expected = canonical(workspace);
  return listManagedWorktrees(options).find(
    (record) => canonical(record.workspacePath) === expected,
  );
}

/**
 * Managed tasks may only become complete through the review integration
 * transaction. Direct lifecycle commands would otherwise mark central state
 * complete while leaving the task branch unmerged.
 */
export function assertDirectCompletionAllowed(
  taskId: string,
  options: WorktreeServiceOptions,
): void {
  const runner = options.runner ?? runGit;
  const controlRepo = canonical(options.controlRepo);
  if (!isGitRepository(controlRepo, runner)) return;

  const record = getManagedWorktree(taskId, { ...options, controlRepo, runner });
  if (record) {
    throw new Error(
      `Task ${taskId} uses a managed worktree and must be approved before it can be completed. ` +
        "Run the review approval workflow so Manciple can verify and integrate the task branch transactionally.",
    );
  }
}

export function assertInPlaceExecutionAllowed(
  taskId: string,
  options: WorktreeServiceOptions,
): void {
  if (!isGitRepository(options.controlRepo, options.runner ?? runGit)) return;
  const record = getManagedWorktree(taskId, options);
  if (record) {
    throw new Error(
      `Task ${taskId} already has a managed worktree at ${record.workspacePath}. ` +
        "Remove that managed worktree before switching the task to in-place execution.",
    );
  }
}

export function prepareManagedWorktree(
  taskId: string,
  options: PrepareWorktreeOptions,
): ManagedWorktreeRecord {
  const runner = options.runner ?? runGit;
  const controlRepo = canonical(options.controlRepo);
  validateTask(taskId, options.specsTasksDir);
  const primary = ensurePrimaryCheckout(controlRepo, runner);
  const worktreesDir = canonical(options.worktreesDir);
  if (worktreesDir === controlRepo || !isWithin(controlRepo, worktreesDir)) {
    throw new Error(
      `Managed worktrees directory must be inside the primary checkout: ${worktreesDir}`,
    );
  }
  ensureLocalExclude(controlRepo, worktreesDir, runner);
  const dirty = primaryCodeChanges({ ...options, controlRepo, runner });
  if (dirty.length > 0) {
    throw new Error(
      `Refusing to prepare a task worktree while primary code is dirty: ${dirty.join(", ")}`,
    );
  }

  const workspacePath = resolve(worktreesDir, taskId);
  if (!isWithin(worktreesDir, workspacePath) || workspacePath === worktreesDir) {
    throw new Error(`Resolved worktree path escapes the managed directory: ${workspacePath}`);
  }
  const branch = `manciple/${taskId}`;

  return withRegistry(controlRepo, runner, (registry, file) => {
    const existing = registry.worktrees[taskId];
    if (existing) {
      if (!isWithin(worktreesDir, existing.workspacePath) || existing.branch !== branch) {
        throw new Error(`Managed worktree record for ${taskId} has an unsafe path or branch.`);
      }
      if (!worktreeExistsAt(existing.workspacePath, branch, runner)) {
        throw new Error(
          `Managed worktree for ${taskId} is missing or no longer checks out ${branch}. Run worktree prune or remove.`,
        );
      }
      if (
        ["review_ready", "integrating", "integrated_pending_completion"].includes(
          existing.claimState,
        )
      ) {
        throw new Error(
          `Managed worktree for ${taskId} is ${existing.claimState} and cannot be claimed for implementation. ` +
            "Complete the review action or request changes first.",
        );
      }
      existing.claimState = options.claim === false ? "available" : "assigned";
      existing.updatedAt = new Date().toISOString();
      writeRegistry(file, registry);
      return { ...existing };
    }

    if (existsSync(workspacePath)) {
      if (!statSync(workspacePath).isDirectory() || readdirSync(workspacePath).length > 0) {
        throw new Error(`Refusing to overwrite unrelated worktree path: ${workspacePath}`);
      }
      rmSync(workspacePath, { recursive: false });
    }
    mkdirSync(dirname(workspacePath), { recursive: true });

    const branchExists =
      tryGit(runner, ["show-ref", "--verify", `refs/heads/${branch}`], controlRepo) !== undefined;
    if (branchExists) {
      throw new Error(`Refusing to adopt unregistered task branch: ${branch}`);
    }
    runner(["worktree", "add", "-b", branch, workspacePath, primary.head], controlRepo);

    const now = new Date().toISOString();
    const record: ManagedWorktreeRecord = {
      taskId,
      controlRepo,
      workspacePath: canonical(workspacePath),
      branch,
      baseBranch: primary.branch,
      baseSha: primary.head,
      createdAt: now,
      updatedAt: now,
      claimState: options.claim === false ? "available" : "assigned",
    };
    registry.worktrees[taskId] = record;
    writeRegistry(file, registry);
    return { ...record };
  });
}

export function setManagedWorktreeState(
  taskId: string,
  state: WorktreeClaimState,
  options: WorktreeServiceOptions,
  integratedSha?: string,
): ManagedWorktreeRecord | undefined {
  const runner = options.runner ?? runGit;
  const controlRepo = canonical(options.controlRepo);
  const worktreesDir = canonical(options.worktreesDir);
  if (worktreesDir === controlRepo || !isWithin(controlRepo, worktreesDir)) {
    throw new Error(
      `Managed worktrees directory must be inside the primary checkout: ${worktreesDir}`,
    );
  }
  return withRegistry(controlRepo, runner, (registry, file) => {
    const record = registry.worktrees[taskId];
    if (!record) return undefined;
    record.claimState = state;
    record.updatedAt = new Date().toISOString();
    if (integratedSha) record.integratedSha = integratedSha;
    writeRegistry(file, registry);
    return { ...record };
  });
}

export function releaseManagedWorktree(
  taskId: string,
  options: WorktreeServiceOptions,
): ManagedWorktreeRecord | undefined {
  const runner = options.runner ?? runGit;
  const controlRepo = canonical(options.controlRepo);
  return withRegistry(controlRepo, runner, (registry, file) => {
    const record = registry.worktrees[taskId];
    if (!record) return undefined;
    if (["integrating", "integrated_pending_completion"].includes(record.claimState)) {
      throw new Error(
        `Managed worktree ${taskId} cannot be released while it is ${record.claimState}.`,
      );
    }
    record.claimState = "available";
    record.updatedAt = new Date().toISOString();
    writeRegistry(file, registry);
    return { ...record };
  });
}

export function managedWorktreeChangedFiles(
  record: ManagedWorktreeRecord,
  runner: GitRunner = runGit,
): string[] {
  const commands = [
    ["diff", "--name-only", `${record.baseSha}...HEAD`],
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ];
  return [
    ...new Set(
      commands.flatMap((args) => {
        const output = tryGit(runner, args, record.workspacePath) ?? "";
        return output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
      }),
    ),
  ].sort();
}

export function removeManagedWorktree(
  taskId: string,
  options: RemoveWorktreeOptions,
): ManagedWorktreeRecord {
  const runner = options.runner ?? runGit;
  const controlRepo = canonical(options.controlRepo);
  const worktreesDir = canonical(options.worktreesDir);
  if (worktreesDir === controlRepo || !isWithin(controlRepo, worktreesDir)) {
    throw new Error(
      `Managed worktrees directory must be inside the primary checkout: ${worktreesDir}`,
    );
  }
  return withRegistry(controlRepo, runner, (registry, file) => {
    const record = registry.worktrees[taskId];
    if (!record) throw new Error(`Managed worktree not found: ${taskId}`);
    if (record.claimState === "integrating") {
      throw new Error(
        `Managed worktree ${taskId} cannot be removed while integration is in progress.`,
      );
    }
    if (!isWithin(worktreesDir, record.workspacePath)) {
      throw new Error(
        `Refusing to remove worktree outside the managed directory: ${record.workspacePath}`,
      );
    }

    if (existsSync(record.workspacePath)) {
      const changed = runner(
        ["status", "--porcelain=v1", "--untracked-files=all"],
        record.workspacePath,
      );
      if (changed && !options.force) {
        throw new Error(
          `Worktree ${taskId} has uncommitted changes. Use --force to remove this managed worktree.`,
        );
      }
      runner(
        ["worktree", "remove", ...(options.force ? ["--force"] : []), record.workspacePath],
        controlRepo,
      );
    }

    if (options.deleteBranch !== false) {
      const deleteFlag = options.force ? "-D" : "-d";
      if (
        tryGit(runner, ["show-ref", "--verify", `refs/heads/${record.branch}`], controlRepo) !==
        undefined
      ) {
        runner(["branch", deleteFlag, record.branch], controlRepo);
      }
    }

    delete registry.worktrees[taskId];
    writeRegistry(file, registry);
    return { ...record };
  });
}

export function pruneManagedWorktrees(
  options: WorktreeServiceOptions & { dryRun?: boolean },
): WorktreePruneResult {
  const runner = options.runner ?? runGit;
  const controlRepo = canonical(options.controlRepo);
  return withRegistry(controlRepo, runner, (registry, file) => {
    const removedRecords = Object.values(registry.worktrees)
      .filter((record) => !worktreeExistsAt(record.workspacePath, record.branch, runner))
      .map((record) => record.taskId)
      .sort();
    if (!options.dryRun) {
      for (const taskId of removedRecords) delete registry.worktrees[taskId];
      writeRegistry(file, registry);
      runner(["worktree", "prune"], controlRepo);
    }
    return { removedRecords, prunedGitMetadata: !options.dryRun };
  });
}
