import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { Command } from "commander";

import { initCommand } from "../src/commands/init.js";
import { newCommand } from "../src/commands/new.js";
import { setStatusCommand } from "../src/commands/setStatus.js";
import { dispatchBareReview, registerReviewCommands } from "../src/commands/review.js";
import type { BareReviewDispatch } from "../src/commands/review.js";
import { getPaths } from "../src/utils/paths.js";
import { reviewPromptFilename } from "../src/templates/renderTemplate.js";

let cwd: string;
let p: ReturnType<typeof getPaths>;

function runCli(args: string[], options: { timeout?: number } = {}) {
  const tsxBin = join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx"
  );
  return spawnSync(tsxBin, [join(process.cwd(), "src", "cli.ts"), ...args], {
    cwd,
    encoding: "utf-8",
    timeout: options.timeout ?? 30_000,
  });
}

function slugTitleFromId(id: string): string {
  return id.replaceAll("-", " ");
}

function createTaskInReview(id: string): void {
  newCommand(slugTitleFromId(id), {
    type: "implementation",
    domain: "core",
    priority: "medium",
    cwd,
    activeDir: p.tasksActive,
  });
  setStatusCommand(id, "needs_review", p.specsTasks, cwd);
}

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-review-tui-cli-"));
  p = getPaths(cwd, ".manciple");
  await initCommand({ force: false, cwd, root: ".manciple" });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("dispatchBareReview", () => {
  it("prints help and never launches the TUI when stdout is not a TTY", () => {
    const launchTui = vi.fn();
    const showHelp = vi.fn();
    const dispatch: BareReviewDispatch = { isTty: false, launchTui, showHelp };

    const result = dispatchBareReview(dispatch, p, cwd);

    expect(result).toBeUndefined();
    expect(showHelp).toHaveBeenCalledTimes(1);
    expect(launchTui).not.toHaveBeenCalled();
  });

  it("launches the TUI with the scoped paths and cwd when stdout is a TTY", () => {
    const launchTui = vi.fn((paths: unknown, dir: string) => `tui:${dir}`);
    const showHelp = vi.fn();
    const dispatch: BareReviewDispatch = { isTty: true, launchTui, showHelp };

    const result = dispatchBareReview(dispatch, p, cwd);

    expect(launchTui).toHaveBeenCalledTimes(1);
    expect(launchTui).toHaveBeenCalledWith(p, cwd);
    expect(showHelp).not.toHaveBeenCalled();
    expect(result).toBe(`tui:${cwd}`);
  });

  it("propagates an async TUI launch result so callers can await it", async () => {
    const launchTui = vi.fn(async () => "exited cleanly");
    const result = dispatchBareReview({ isTty: true, launchTui, showHelp: () => {} }, p, cwd);
    await expect(result).resolves.toBe("exited cleanly");
  });
});

describe("registerReviewCommands bare review dispatch", () => {
  it("wires isTty and launchTui options through to the bare review action", () => {
    const program = new Command();
    const launchTui = vi.fn();

    registerReviewCommands(program, p, cwd, {
      isTty: () => true,
      launchTui,
    });

    program.parse(["review"], { from: "user" });

    expect(launchTui).toHaveBeenCalledTimes(1);
    expect(launchTui).toHaveBeenCalledWith(p, cwd);
  });

  it("does not launch the TUI when the wired isTty check reports false", () => {
    const program = new Command();
    const launchTui = vi.fn();
    const showHelp = vi.fn();

    registerReviewCommands(program, p, cwd, {
      isTty: () => false,
      launchTui,
      showHelp: () => showHelp(),
    });

    program.parse(["review"], { from: "user" });

    expect(launchTui).not.toHaveBeenCalled();
    expect(showHelp).toHaveBeenCalledTimes(1);
  });

  it("still routes `review <task-id>` to reviewCommand, not the bare dispatch", () => {
    const program = new Command();
    const launchTui = vi.fn();
    const taskId = "route-task";

    createTaskInReview(taskId);

    registerReviewCommands(program, p, cwd, { isTty: () => true, launchTui });
    program.parse(["review", taskId], { from: "user" });

    expect(launchTui).not.toHaveBeenCalled();
    expect(existsSync(join(p.promptsGenerated, reviewPromptFilename(taskId)))).toBe(true);
  });
});

describe("bare `manciple review` in a non-TTY process", () => {
  it("prints help and exits 0 without hanging when stdout is piped", () => {
    // spawnSync pipes stdout/stderr, so process.stdout.isTTY is falsy in the
    // child: the bare review command must print help and exit, never hang.
    const result = runCli(["review"], { timeout: 15_000 });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: manciple review");
    expect(result.stdout).toContain("queue");
    expect(result.stdout).toContain("packet");
    expect(result.stderr).toBe("");
  });

  it("prints help even when the review queue is empty (no TUI, no hang)", () => {
    const result = runCli(["review"], { timeout: 15_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: manciple review");
    expect(result.stdout).not.toContain("Review Dashboard");
  });
});

describe("existing review subcommands keep their behavior", () => {
  it("review <task-id> still creates a review prompt file", () => {
    const taskId = "prompt-task";
    createTaskInReview(taskId);

    const result = runCli(["review", taskId]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Review prompt created");
    expect(existsSync(join(p.promptsGenerated, reviewPromptFilename(taskId)))).toBe(true);
  });

  it("review queue --json and review packet <task-id> --json still work", () => {
    const taskId = "json-task";
    createTaskInReview(taskId);

    const queue = runCli(["review", "queue", "--json"]);
    expect(queue.status).toBe(0);
    const queueJson = JSON.parse(queue.stdout);
    expect(queueJson.needsReview.rows.map((row: { taskId: string }) => row.taskId)).toContain(taskId);

    const packet = runCli(["review", "packet", taskId, "--json"]);
    expect(packet.status).toBe(0);
    expect(JSON.parse(packet.stdout).taskId).toBe(taskId);
  });
});
