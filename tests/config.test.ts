import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const dirs: string[] = [];

function repoWithConfig(content?: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "manciple-config-"));
  dirs.push(cwd);
  if (content !== undefined) {
    mkdirSync(join(cwd, ".manciple"), { recursive: true });
    writeFileSync(join(cwd, ".manciple", "config.yaml"), content, "utf-8");
  }
  return cwd;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("worktree configuration", () => {
  it("enables worktrees when config is absent or omits the block", () => {
    expect(loadConfig(repoWithConfig()).worktrees.enabled).toBe(true);
    expect(loadConfig(repoWithConfig("root: .manciple\n")).worktrees.enabled).toBe(true);
  });

  it("supports an explicit repository opt-out", () => {
    expect(loadConfig(repoWithConfig("root: .manciple\nworktrees:\n  enabled: false\n"))).toEqual({
      root: ".manciple",
      worktrees: { enabled: false },
    });
  });

  it("rejects a non-boolean worktree policy", () => {
    expect(() => loadConfig(repoWithConfig("worktrees:\n  enabled: sometimes\n"))).toThrow(
      "worktrees.enabled must be true or false",
    );
    expect(() => loadConfig(repoWithConfig("worktrees: enabled\n"))).toThrow(
      "worktrees must be a mapping",
    );
  });
});
