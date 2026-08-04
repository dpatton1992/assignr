import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("manciple-token-audit script", () => {
  it("delegates to the deterministic token-estimate command and prints bucket output", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/manciple-token-audit.mjs",
        "add-assignr-token-estimate-command",
        "--budget",
        "999999",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf-8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("# Token Estimate: add-assignr-token-estimate-command");
    expect(result.stdout).toContain(
      "Deterministic local heuristic: estimated tokens = ceil(characters / 4). No external APIs are called.",
    );
    expect(result.stdout).toContain(
      "Scope: estimates Manciple artifact/context bloat only, not total provider, harness, tool, retry, reasoning, or generated-output usage.",
    );
    expect(result.stdout).toContain("## Token Buckets");
    expect(result.stdout).toContain("Risk: within budget");
  });

  it("preserves token-estimate failures and exit codes", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/manciple-token-audit.mjs", "missing-token-audit-task"],
      {
        cwd: process.cwd(),
        encoding: "utf-8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("missing-token-audit-task");
  });

  it("keeps release agent assets and token audit tooling included", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")) as {
      files?: string[];
    };

    expect(packageJson.files).toContain(".claude/skills/");
    expect(packageJson.files).toContain(".codex/skills/");
    expect(packageJson.files).toContain(".opencode/agents/");
    expect(packageJson.files).toContain("scripts/manciple-token-audit.mjs");
    expect(packageJson.files).not.toContain(".opencode/node_modules/");
    expect(packageJson.files).not.toContain(".opencode/package.json");
    expect(packageJson.files).not.toContain(".opencode/package-lock.json");
    expect(packageJson.files).not.toContain(".opencode/bun.lock");
  });
});
