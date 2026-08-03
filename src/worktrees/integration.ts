import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { TaskSpec } from "../specs/schema.js";
import { pathMatchesPattern } from "../utils/pathUtils.js";
import type { ManagedWorktreeRecord, WorktreeServiceOptions } from "./manager.js";
import {
  getManagedWorktree,
  managedWorktreeChangedFiles,
  primaryCodeChanges,
  setManagedWorktreeState,
} from "./manager.js";

export interface WorktreeIntegrationResult {
  managed: true;
  taskId: string;
  branch: string;
  taskHeadSha: string;
  primaryHeadBefore: string;
  integratedSha: string;
  committedByManciple: boolean;
  verification: Array<{ command: string; exitCode: number; ok: boolean }>;
  recovered: boolean;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(args: string[], cwd: string): string | undefined {
  try {
    return git(args, cwd);
  } catch {
    return undefined;
  }
}

function commonDir(controlRepo: string): string {
  const raw = git(["rev-parse", "--git-common-dir"], controlRepo);
  return resolve(controlRepo, isAbsolute(raw) ? raw : raw);
}

function withIntegrationLock<T>(controlRepo: string, operation: () => T): T {
  const dir = join(commonDir(controlRepo), "manciple");
  const lock = join(dir, "integration.lock");
  mkdirSync(dir, { recursive: true });
  let fd: number;
  try {
    fd = openSync(lock, "wx");
  } catch {
    throw new Error("Another Manciple integration is in progress. Retry when it finishes.");
  }
  try {
    return operation();
  } finally {
    closeSync(fd);
    if (existsSync(lock)) unlinkSync(lock);
  }
}

function validateChangedPaths(task: TaskSpec, changedFiles: string[]): void {
  const allowed = task.allowed_paths ?? [];
  const forbidden = task.forbidden_paths ?? [];
  const outside =
    allowed.length === 0
      ? []
      : changedFiles.filter(
          (file) => !allowed.some((pattern) => pathMatchesPattern(file, pattern)),
        );
  const forbiddenMatches = changedFiles.filter((file) =>
    forbidden.some((pattern) => pathMatchesPattern(file, pattern)),
  );
  if (outside.length > 0 || forbiddenMatches.length > 0) {
    const reasons = [
      ...(outside.length > 0 ? [`outside allowed_paths: ${outside.join(", ")}`] : []),
      ...(forbiddenMatches.length > 0
        ? [`matches forbidden_paths: ${forbiddenMatches.join(", ")}`]
        : []),
    ];
    throw new Error(`Worktree integration scope check failed (${reasons.join("; ")}).`);
  }
}

function commitRemainingChanges(record: ManagedWorktreeRecord, task: TaskSpec): boolean {
  const dirty = git(["status", "--porcelain=v1", "--untracked-files=all"], record.workspacePath);
  if (!dirty) return false;
  git(["add", "-A", "--", "."], record.workspacePath);
  git(["commit", "-m", `manciple(${task.id}): ${task.title}`], record.workspacePath);
  return true;
}

function runVerification(
  commands: string[],
  cwd: string,
): Array<{ command: string; exitCode: number; ok: boolean }> {
  const receipts = commands.map((command) => {
    const result = spawnSync(command, {
      cwd,
      shell: true,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exitCode = result.status ?? 1;
    if (exitCode !== 0) {
      const detail = (result.stderr || result.stdout || "verification command failed")
        .trim()
        .slice(0, 2_000);
      throw new Error(
        `Integration verification failed: ${command} (exit ${exitCode})${detail ? `\n${detail}` : ""}`,
      );
    }
    return { command, exitCode, ok: true };
  });
  return receipts;
}

function alreadyIntegrated(record: ManagedWorktreeRecord, controlRepo: string): string | undefined {
  if (!record.integratedSha) return undefined;
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", record.integratedSha, "HEAD"], {
    cwd: controlRepo,
    stdio: "ignore",
  });
  return ancestor.status === 0 ? record.integratedSha : undefined;
}

export function integrateManagedWorktree(
  task: TaskSpec,
  options: WorktreeServiceOptions,
): WorktreeIntegrationResult | undefined {
  const record: ManagedWorktreeRecord | undefined = getManagedWorktree(task.id, options);
  if (!record) return undefined;
  const controlRepo = resolve(options.controlRepo);

  return withIntegrationLock(controlRepo, () => {
    const primaryBranch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], controlRepo);
    if (primaryBranch !== record.baseBranch) {
      throw new Error(
        `Refusing to integrate ${task.id} into ${primaryBranch}; its managed base branch is ${record.baseBranch}.`,
      );
    }
    if (
      !["review_ready", "integrating", "integrated_pending_completion"].includes(record.claimState)
    ) {
      throw new Error(
        `Managed worktree ${task.id} is ${record.claimState}, not ready for review integration.`,
      );
    }
    const recoveredSha = alreadyIntegrated(record, controlRepo);
    if (record.claimState === "integrated_pending_completion" && recoveredSha) {
      return {
        managed: true,
        taskId: task.id,
        branch: record.branch,
        taskHeadSha: git(["rev-parse", record.branch], controlRepo),
        primaryHeadBefore: recoveredSha,
        integratedSha: recoveredSha,
        committedByManciple: false,
        verification: [],
        recovered: true,
      };
    }

    const primaryDirty = primaryCodeChanges(options);
    if (primaryDirty.length > 0) {
      throw new Error(
        `Refusing to integrate while primary code is dirty: ${primaryDirty.join(", ")}`,
      );
    }

    const changedFiles = managedWorktreeChangedFiles(record);
    validateChangedPaths(task, changedFiles);
    const committedByManciple = commitRemainingChanges(record, task);
    const taskHeadSha = git(["rev-parse", "HEAD"], record.workspacePath);
    const primaryHeadBefore = git(["rev-parse", "HEAD"], controlRepo);
    setManagedWorktreeState(task.id, "integrating", options);

    const tempPath = join(options.worktreesDir, ".integration", `${task.id}-${process.pid}`);
    mkdirSync(dirname(tempPath), { recursive: true });
    if (existsSync(tempPath)) rmSync(tempPath, { recursive: true, force: true });
    let added = false;
    let verification: Array<{ command: string; exitCode: number; ok: boolean }> = [];
    try {
      try {
        git(["worktree", "add", "--detach", tempPath, primaryHeadBefore], controlRepo);
        added = true;
        git(["merge", "--no-ff", "-m", `manciple: integrate ${task.id}`, record.branch], tempPath);
        verification = runVerification(task.verification.commands, tempPath);
      } finally {
        if (added) tryGit(["worktree", "remove", "--force", tempPath], controlRepo);
        else if (existsSync(tempPath)) rmSync(tempPath, { recursive: true, force: true });
      }
    } catch (error) {
      setManagedWorktreeState(task.id, "review_ready", options);
      throw error;
    }

    const currentPrimaryHead = git(["rev-parse", "HEAD"], controlRepo);
    if (currentPrimaryHead !== primaryHeadBefore) {
      setManagedWorktreeState(task.id, "review_ready", options);
      throw new Error(
        "Primary HEAD changed during integration verification. Review approval can be retried safely.",
      );
    }

    try {
      git(["merge", "--no-ff", "-m", `manciple: integrate ${task.id}`, record.branch], controlRepo);
    } catch (error) {
      tryGit(["merge", "--abort"], controlRepo);
      setManagedWorktreeState(task.id, "review_ready", options);
      throw error;
    }
    const integratedSha = git(["rev-parse", "HEAD"], controlRepo);
    setManagedWorktreeState(task.id, "integrated_pending_completion", options, integratedSha);

    return {
      managed: true,
      taskId: task.id,
      branch: record.branch,
      taskHeadSha,
      primaryHeadBefore,
      integratedSha,
      committedByManciple,
      verification,
      recovered: false,
    };
  });
}
