import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { ReviewPacket } from "../review/reviewPacket.js";

/**
 * Safe external-process helpers for the review TUI.
 *
 * The TUI's displayed evidence comes exclusively from the ReviewPacket, but
 * the `d` key is an explicit user action that opens a task-scoped external git
 * diff, and detailed diffs / long receipts are shown through the user's PAGER.
 * All processes are spawned with argument arrays — never shell interpolation
 * of task ids, paths, reasons, or environment values.
 */

export interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[], cwd: string) => ProcessResult;

export function defaultCommandRunner(command: string, args: string[], cwd: string): ProcessResult {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export interface DiffContext {
  packet: ReviewPacket;
  cwd: string;
  /** Injectable runner for tests; defaults to spawnSync with argument arrays. */
  run?: CommandRunner;
}

/**
 * Build the pager content for the `d` key. The git diff is scoped to the
 * packet's changed paths (passed as individual argv entries) and untracked
 * paths are surfaced in a separate section because git diff cannot show them.
 */
export function buildDiffContent(context: DiffContext): string {
  const { packet, cwd, run = defaultCommandRunner } = context;
  const evidenceCwd = packet.worktree?.managed ? resolve(cwd, packet.worktree.workspacePath) : cwd;
  const diffBase = packet.worktree?.managed ? (packet.worktree.baseSha ?? "HEAD") : "HEAD";
  const paths = packet.changedPaths
    .map((changed) => changed.path)
    .filter((path) => path.length > 0 && !path.includes("\0"));

  const sections: string[] = [];
  sections.push(`Task: ${packet.taskId} — ${packet.title}`);

  if (paths.length === 0) {
    sections.push("No changed paths recorded for this task.");
    return sections.join("\n\n");
  }

  const statusResult = run(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", ...paths],
    evidenceCwd,
  );
  const untracked = statusResult.stdout
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  if (untracked.length > 0) {
    sections.push(
      `Untracked paths (not shown in git diff):\n${untracked.map((path) => `  ${path}`).join("\n")}`,
    );
  }

  const diffResult = run("git", ["diff", diffBase, "--", ...paths], evidenceCwd);
  const diff = diffResult.stdout.trim();
  sections.push(
    diff
      ? `Diff for ${paths.length} changed path(s):\n\n${diff}`
      : "No tracked diff for the packet's changed paths.",
  );

  return sections.join("\n\n");
}

/**
 * Resolve the pager command from the environment. `$PAGER` may carry
 * arguments (e.g. `less -R`); they are split on whitespace and passed as an
 * argument array. When no pager is configured the documented fallback chain
 * starts with `less` and falls back to inline output if spawning fails.
 */
export function resolvePagerCommand(
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } | null {
  const configured = env.PAGER?.trim();
  if (configured) {
    const parts = configured.split(/\s+/).filter(Boolean);
    if (parts.length > 0) {
      return { command: parts[0], args: parts.slice(1) };
    }
  }
  return { command: "less", args: ["-R"] };
}

export type PagerSpawner = (
  command: string,
  args: string[],
  input: string,
) => Promise<number | null>;

/**
 * Spawn the pager with the content piped to its stdin. The Ink app must be
 * paused (unmounted) before calling this so the terminal is fully restored
 * while the pager owns the screen. Resolves null when the pager could not be
 * started (e.g. ENOENT) so callers can use the documented fallback.
 */
export function defaultPagerSpawn(
  command: string,
  args: string[],
  input: string,
): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, { stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        resolve(code ?? null);
      }
    });
    child.stdin.on("error", () => {
      // EPIPE when the pager exits before consuming all input.
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

export interface OpenInPagerOptions {
  env?: NodeJS.ProcessEnv;
  spawnPager?: PagerSpawner;
  stdout?: { write(chunk: string): void };
}

/**
 * Show long content through the user's PAGER.
 *
 * Fallback (documented): when no pager is configured, the pager cannot be
 * spawned, or the pager exits nonzero, the content is printed inline to the
 * (already restored) terminal so the user is never stranded without the
 * content.
 */
export async function openInPager(
  content: string,
  options: OpenInPagerOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const resolved = resolvePagerCommand(env);
  const writeFallback = (): void => {
    const stdout = options.stdout ?? process.stdout;
    stdout.write(`\n${content}\n`);
  };

  if (!resolved) {
    writeFallback();
    return;
  }

  const spawnPager = options.spawnPager ?? defaultPagerSpawn;
  const status = await spawnPager(resolved.command, resolved.args, content);
  if (status === null || status !== 0) {
    writeFallback();
  }
}
