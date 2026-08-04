import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeLegacyWorktreeArgs, worktreeCommand } from "../src/commands/worktree.js";
import { getPaths } from "../src/utils/paths.js";
import {
  getManagedWorktree,
  listManagedWorktrees,
  removeManagedWorktree,
} from "../src/worktrees/manager.js";

let cwd: string;
let p: ReturnType<typeof getPaths>;
const projectRoot = process.cwd();

function git(args: string[], repo: string = cwd): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();
}

function taskYaml(id: string): string {
  return `id: ${id}
title: Extract auth middleware
status: pending
type: implementation
domain: core
priority: medium
depends_on: []
blocks: []
conflicts_with: []
can_run_independently: true
allowed_paths:
  - src/**
forbidden_paths: []
path_ownership:
  touched_paths: []
  locked_paths: []
  unsafe_parallel_areas: []
goal: Extract auth middleware.
acceptance_criteria:
  - Middleware is extracted.
verification:
  commands:
    - test -d src
outputs_required:
  - files_changed
  - tests_run
  - risks
notes: []
`;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-worktree-"));
  p = getPaths(cwd, ".manciple");
  git(["init", "-b", "main"]);
  git(["config", "user.email", "tests@example.com"]);
  git(["config", "user.name", "Manciple Tests"]);
  mkdirSync(p.tasksActive, { recursive: true });
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "index.ts"), "export {};\n", "utf-8");
  writeFileSync(
    join(p.tasksActive, "extract-auth-middleware.yaml"),
    taskYaml("extract-auth-middleware"),
    "utf-8",
  );
  writeFileSync(p.config, "root: .manciple\nworktrees:\n  enabled: true\n", "utf-8");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function commandOptions() {
  return { cwd, worktreesDir: p.worktrees, specsTasksDir: p.specsTasks };
}

function runCli(args: string[]) {
  return spawnSync(
    join(projectRoot, "node_modules", ".bin", "tsx"),
    [join(projectRoot, "src", "cli.ts"), ...args],
    {
      cwd,
      encoding: "utf-8",
    },
  );
}

describe("manciple worktree", () => {
  it("creates a registered task branch and worktree from primary HEAD", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const record = worktreeCommand("extract-auth-middleware", commandOptions());
      expect(record.branch).toBe("manciple/extract-auth-middleware");
      expect(record.workspacePath).toBe(
        join(realpathSync(cwd), ".manciple", "worktrees", "extract-auth-middleware"),
      );
      expect(record.claimState).toBe("assigned");
      expect(git(["branch", "--show-current"], record.workspacePath)).toBe(record.branch);
      expect(
        listManagedWorktrees({
          controlRepo: cwd,
          worktreesDir: p.worktrees,
          specsTasksDir: p.specsTasks,
        }),
      ).toHaveLength(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("reuses and reclaims an existing matching managed worktree", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const first = worktreeCommand("extract-auth-middleware", commandOptions());
      const second = worktreeCommand("extract-auth-middleware", commandOptions());
      expect(second.workspacePath).toBe(first.workspacePath);
      expect(git(["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(2);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("fails closed when primary code is dirty", () => {
    writeFileSync(join(cwd, "src", "index.ts"), "export const dirty = true;\n", "utf-8");
    expect(() => worktreeCommand("extract-auth-middleware", commandOptions())).toThrow(
      "primary code is dirty: src/index.ts",
    );
    expect(existsSync(join(p.worktrees, "extract-auth-middleware"))).toBe(false);
    expect(readFileSync(join(p.tasksActive, "extract-auth-middleware.yaml"), "utf-8")).toContain(
      "status: pending",
    );
  });

  it("never adopts an unregistered pre-existing task branch", () => {
    git(["branch", "manciple/extract-auth-middleware"]);
    expect(() => worktreeCommand("extract-auth-middleware", commandOptions())).toThrow(
      "Refusing to adopt unregistered task branch",
    );
    expect(existsSync(join(p.worktrees, "extract-auth-middleware"))).toBe(false);
  });

  it("uses the configured default for task start", () => {
    const result = runCli(["task", "start", "extract-auth-middleware"]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(p.worktrees, "extract-auth-middleware"))).toBe(true);
    expect(readFileSync(join(p.tasksActive, "extract-auth-middleware.yaml"), "utf-8")).toContain(
      "status: in_progress",
    );
  });

  it("allows --no-worktrees to override enabled automation", () => {
    const result = runCli(["task", "start", "extract-auth-middleware", "--no-worktrees"]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(p.worktrees, "extract-auth-middleware"))).toBe(false);
    expect(readFileSync(join(p.tasksActive, "extract-auth-middleware.yaml"), "utf-8")).toContain(
      "status: in_progress",
    );
  });

  it("allows --worktrees to override disabled automation", () => {
    writeFileSync(p.config, "root: .manciple\nworktrees:\n  enabled: false\n", "utf-8");
    const result = runCli(["task", "start", "extract-auth-middleware", "--worktrees"]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(p.worktrees, "extract-auth-middleware"))).toBe(true);
  });

  it("never overwrites an unrelated non-empty path", () => {
    const path = join(p.worktrees, "extract-auth-middleware");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "notes.txt"), "keep me\n", "utf-8");
    expect(() => worktreeCommand("extract-auth-middleware", commandOptions())).toThrow(
      "Refusing to overwrite unrelated worktree path",
    );
    expect(existsSync(join(path, "notes.txt"))).toBe(true);
  });

  it("rejects a managed root outside the primary checkout", () => {
    expect(() =>
      worktreeCommand("extract-auth-middleware", {
        cwd,
        worktreesDir: join(cwd, "..", "outside-worktrees"),
        specsTasksDir: p.specsTasks,
      }),
    ).toThrow("must be inside the primary checkout");
  });

  it("removes only a registered managed worktree and its merged branch", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      worktreeCommand("extract-auth-middleware", commandOptions());
      const removed = removeManagedWorktree("extract-auth-middleware", {
        controlRepo: cwd,
        worktreesDir: p.worktrees,
        specsTasksDir: p.specsTasks,
      });
      expect(existsSync(removed.workspacePath)).toBe(false);
      expect(git(["branch", "--list", removed.branch])).toBe("");
      expect(
        getManagedWorktree("extract-auth-middleware", {
          controlRepo: cwd,
          worktreesDir: p.worktrees,
        }),
      ).toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("fails clearly outside a git repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "manciple-worktree-nongit-"));
    const outsidePaths = getPaths(outside, ".manciple");
    mkdirSync(outsidePaths.tasksActive, { recursive: true });
    writeFileSync(
      join(outsidePaths.tasksActive, "extract-auth-middleware.yaml"),
      taskYaml("extract-auth-middleware"),
      "utf-8",
    );
    try {
      expect(() =>
        worktreeCommand("extract-auth-middleware", {
          cwd: outside,
          worktreesDir: outsidePaths.worktrees,
          specsTasksDir: outsidePaths.specsTasks,
        }),
      ).toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("normalizes the legacy create shortcut without rewriting grouped commands", () => {
    expect(normalizeLegacyWorktreeArgs(["node", "manciple", "worktree", "task-id"])).toEqual([
      "node",
      "manciple",
      "worktree",
      "create",
      "task-id",
    ]);
    expect(normalizeLegacyWorktreeArgs(["node", "manciple", "worktree", "list", "--json"])).toEqual(
      ["node", "manciple", "worktree", "list", "--json"],
    );
    expect(normalizeLegacyWorktreeArgs(["node", "manciple", "worktree", "--help"])).toEqual([
      "node",
      "manciple",
      "worktree",
      "--help",
    ]);
  });
});
