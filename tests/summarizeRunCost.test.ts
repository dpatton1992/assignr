import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderRunCostSummary, summarizeRunCost } from "../src/commands/summarizeRunCost.js";

let cwd: string;
let runsDir: string;

function writeRunLog(file: string, content: string): void {
  writeFileSync(join(runsDir, file), content, "utf-8");
}

function runLog(taskId: string, extra: string): string {
  return `# Run Log: ${taskId}

## Metadata

- Task ID: ${taskId}
- Status: in_progress
- Started: 2026-05-25T12:00:00.000Z
${extra}

## Commands Run

- pnpm typecheck

## Tests Run

- pnpm test
`;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-run-cost-"));
  runsDir = join(cwd, ".manciple", "runs");
  mkdirSync(runsDir, { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("summarizeRunCost", () => {
  it("reports unknown token and cost coverage when no evidence exists", () => {
    writeRunLog(
      "2026-05-25-12-00-00-alpha.md",
      runLog(
        "alpha",
        `
- Agent/Harness (provided by user): Codex
- Model (provided by user): gpt-5-codex`,
      ),
    );

    const summary = summarizeRunCost(runsDir);
    const rendered = renderRunCostSummary(summary);

    expect(summary.taskCount).toBe(1);
    expect(summary.runCount).toBe(1);
    expect(rendered).toContain("- Codex: 1");
    expect(rendered).toContain("- gpt-5-codex: 1");
    expect(rendered).toContain("Coverage: Unknown: no token evidence recorded.");
    expect(rendered).toContain("Coverage: Unknown: no cost evidence recorded.");
    expect(rendered).toContain("- Total tokens: Unknown");
    expect(rendered).toContain("- Cost USD: Unknown");
  });

  it("summarizes mixed model, token, cost, command, and test evidence", () => {
    writeRunLog(
      "2026-05-25-12-00-00-alpha.md",
      runLog(
        "alpha",
        `
- Agent/Harness (provided by user): Codex
- Model (provided by user): gpt-5-codex

## Usage Evidence

- Input tokens: 100
- Output tokens: 50
- Total tokens: 150

## Cost Evidence

- Cost USD: 0.01`,
      ),
    );
    writeRunLog(
      "2026-05-25-12-05-00-beta.md",
      runLog(
        "beta",
        `
- Agent/Harness (provided by user): Claude Code
- Model (provided by user): claude-sonnet-4-5

## Usage Evidence

- Input tokens: 200
- Output tokens: 25`,
      ),
    );

    const summary = summarizeRunCost(runsDir);
    const rendered = renderRunCostSummary(summary);

    expect(summary.taskCount).toBe(2);
    expect(summary.runCount).toBe(2);
    expect(summary.commandsRecorded).toBe(2);
    expect(summary.testsRecorded).toBe(2);
    expect(summary.inputTokens).toBe(300);
    expect(summary.outputTokens).toBe(75);
    expect(summary.totalTokens).toBe(375);
    expect(summary.costUsd).toBe(0.01);
    expect(rendered).toContain("2/2 run(s) include token evidence.");
    expect(rendered).toContain("1/2 run(s) include cost evidence.");
    expect(rendered).toContain("- Cost USD: 0.010000");
  });

  it("filters to one task id", () => {
    writeRunLog(
      "2026-05-25-12-00-00-alpha.md",
      runLog(
        "alpha",
        `
- Model (provided by user): gpt-5-codex

## Usage Evidence

- Total tokens: 150`,
      ),
    );
    writeRunLog(
      "2026-05-25-12-05-00-beta.md",
      runLog(
        "beta",
        `
- Model (provided by user): claude-sonnet-4-5

## Usage Evidence

- Total tokens: 300`,
      ),
    );

    const summary = summarizeRunCost(runsDir, "beta");
    const rendered = renderRunCostSummary(summary, "beta");

    expect(summary.taskCount).toBe(1);
    expect(summary.runCount).toBe(1);
    expect(summary.totalTokens).toBe(300);
    expect(rendered).toContain("# Run Cost Summary: beta");
    expect(rendered).toContain("- claude-sonnet-4-5: 1");
    expect(rendered).not.toContain("gpt-5-codex");
  });

  it("keeps backward compatibility with existing run logs", () => {
    writeRunLog(
      "2026-05-25-12-00-00-legacy-task.md",
      `# Run Log: Legacy task

## Metadata

- Task ID: legacy-task
- Status: complete
- Agent/Harness (provided by user): Codex
- Model (provided by user): gpt-5-codex

## Commands Run

- pnpm test
`,
    );

    const summary = summarizeRunCost(runsDir);

    expect(summary.taskCount).toBe(1);
    expect(summary.runCount).toBe(1);
    expect(summary.tokenRuns).toBe(0);
    expect(summary.costRuns).toBe(0);
    expect(summary.commandsRecorded).toBe(1);
  });
});
