import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { initCommand } from "../src/commands/init.js";
import { runLogCommand } from "../src/commands/runLog.js";
import {
  buildTokenEstimate,
  DEFAULT_TOKEN_BUDGET,
  estimateTokens,
  renderTokenEstimate,
  renderTokenEstimateRunLogSection,
  tokenEstimateCommand,
} from "../src/commands/tokenEstimate.js";
import type { TaskSpec } from "../src/specs/schema.js";
import { getPaths } from "../src/utils/paths.js";

let cwd: string;
let p: ReturnType<typeof getPaths>;

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-token-estimate-"));
  p = getPaths(cwd, ".manciple");
  await initCommand({ force: false, cwd, root: ".manciple" });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writeTask(id: string, overrides: Partial<TaskSpec> = {}): void {
  const task: TaskSpec = {
    id,
    title: id,
    status: "pending",
    type: "implementation",
    domain: "core",
    priority: "medium",
    depends_on: [],
    blocks: [],
    conflicts_with: [],
    can_run_independently: true,
    path_ownership: {
      touched_paths: [],
      locked_paths: [],
      unsafe_parallel_areas: [],
    },
    allowed_paths: ["src/commands/tokenEstimate.ts", "tests/tokenEstimate.test.ts"],
    forbidden_paths: ["dist/"],
    goal: "Estimate prompt size before worker handoff.",
    acceptance_criteria: ["The token estimate command reports source buckets."],
    verification: {
      commands: ["pnpm typecheck", "pnpm test -- tokenEstimate"],
    },
    outputs_required: ["files_changed", "tests_run", "risks"],
    notes: ["Use local deterministic estimates only."],
    ...overrides,
  };

  mkdirSync(p.tasksActive, { recursive: true });
  writeFileSync(join(p.tasksActive, `${id}.yaml`), stringify(task, { lineWidth: 0 }), "utf-8");
}

describe("tokenEstimateCommand", () => {
  it("uses the documented deterministic heuristic", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
  });

  it("renders normal output with compiled total and source buckets", () => {
    writeTask("estimate-normal");

    const result = buildTokenEstimate({
      specsTasksDir: p.specsTasks,
      cwd,
      taskId: "estimate-normal",
    });
    const output = renderTokenEstimate(result);

    expect(result.budget).toBe(DEFAULT_TOKEN_BUDGET);
    expect(output).toContain("# Token Estimate: estimate-normal");
    expect(output).toContain(
      "Deterministic local heuristic: estimated tokens = ceil(characters / 4). No external APIs are called.",
    );
    expect(output).toContain(
      "Scope: estimates Manciple artifact/context bloat only, not total provider, harness, tool, retry, reasoning, or generated-output usage.",
    );
    expect(output).toContain("- estimated: true");
    expect(output).toContain("- method: ceil(characters / 4)");
    expect(output).toContain("- base Manciple handoff:");
    expect(output).toContain("- task spec:");
    expect(output).toContain("- domain context:");
    expect(output).toContain("- template/instructions:");
    expect(output).toContain("- verification/review contract:");
    expect(output).toContain("Risk: within budget");
  });

  it("reports missing task handling with a non-zero exit", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() =>
        tokenEstimateCommand({
          specsTasksDir: p.specsTasks,
          cwd,
          taskId: "missing-task",
        }),
      ).toThrow("process.exit(1)");
      expect(errorSpy.mock.calls.flat().join("\n")).toContain(
        "No task found with id: missing-task",
      );
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("includes optional review, run-log, diff, and git context sources when requested", () => {
    writeTask("estimate-optional");
    runLogCommand("estimate-optional", p.specsTasks, p.runs, p.promptsGenerated, cwd, {
      result: "complete",
      commandsRun: ["pnpm typecheck"],
      testsRun: ["pnpm test -- tokenEstimate"],
      filesChanged: ["src/commands/tokenEstimate.ts"],
      risks: "none",
      acceptanceCriteriaEvidence: [
        "The token estimate command reports source buckets.: Output labels were asserted.",
      ],
    });
    spawnSync("git", ["init"], { cwd, encoding: "utf-8" });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd, encoding: "utf-8" });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd, encoding: "utf-8" });
    writeFileSync(join(cwd, "tracked.txt"), "before\n", "utf-8");
    spawnSync("git", ["add", "tracked.txt"], { cwd, encoding: "utf-8" });
    spawnSync("git", ["commit", "-m", "initial"], { cwd, encoding: "utf-8" });
    writeFileSync(join(cwd, "tracked.txt"), "after\n", "utf-8");
    writeFileSync(join(cwd, "untracked.txt"), "context\n", "utf-8");

    const output = renderTokenEstimate(
      buildTokenEstimate({
        specsTasksDir: p.specsTasks,
        cwd,
        taskId: "estimate-optional",
        includeReview: true,
        includeRunLog: true,
        includeDiff: true,
        includeGitContext: true,
      }),
    );

    expect(output).toContain("- review prompt:");
    expect(output).toContain("- latest run log:");
    expect(output).toContain("- git diff:");
    expect(output).toContain("- git context:");
  });

  it("reports over-budget risk against a configurable budget", () => {
    writeTask("estimate-over-budget", {
      goal: "x".repeat(100),
    });

    const output = renderTokenEstimate(
      buildTokenEstimate({
        specsTasksDir: p.specsTasks,
        cwd,
        taskId: "estimate-over-budget",
        budget: 1,
      }),
    );

    expect(output).toContain("Budget: 1 estimated tokens");
    expect(output).toContain("Risk: over budget");
  });

  it("keeps over-budget estimates warning-only in the CLI", () => {
    writeTask("estimate-warning-only", {
      goal: "x".repeat(100),
    });

    const tsxBin = join(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx",
    );

    const result = spawnSync(
      tsxBin,
      [
        join(process.cwd(), "src", "cli.ts"),
        "token-estimate",
        "estimate-warning-only",
        "--budget",
        "1",
      ],
      { cwd, encoding: "utf-8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Risk: over budget");
    expect(result.stderr).toContain("token-estimate -> manciple check tokens");
  });

  it("renders persisted run-log estimate markers and warning-only budget text", () => {
    writeTask("estimate-section");

    const section = renderTokenEstimateRunLogSection(
      buildTokenEstimate({
        specsTasksDir: p.specsTasks,
        cwd,
        taskId: "estimate-section",
        budget: 1,
      }),
    );

    expect(section).toContain("## Token Estimate");
    expect(section).toContain("_Source: manciple token-estimate --append-run-log_");
    expect(section).toContain("- estimated: true");
    expect(section).toContain("- method: ceil(characters / 4)");
    expect(section).toContain("- base Manciple handoff:");
    expect(section).toContain("### Base Manciple Handoff Detail");
    expect(section).toContain("Budget warning: over budget");
    expect(section).toContain("Warning only; no workflow failed.");
  });

  it("appends token estimates to the latest existing run log", () => {
    writeTask("estimate-append");
    runLogCommand("estimate-append", p.specsTasks, p.runs, p.promptsGenerated, cwd, {
      result: "complete",
      commandsRun: ["pnpm build"],
      testsRun: ["pnpm test -- tokenEstimate"],
      filesChanged: ["src/commands/tokenEstimate.ts"],
      decisionsMade: ["Stored estimates in the durable run log."],
      risks: "none",
      acceptanceCriteriaEvidence: [
        "The token estimate command reports source buckets.: Output labels were asserted.",
      ],
    });

    const tsxBin = join(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx",
    );

    const result = spawnSync(
      tsxBin,
      [
        join(process.cwd(), "src", "cli.ts"),
        "token-estimate",
        "estimate-append",
        "--include-review",
        "--include-run-log",
        "--include-diff",
        "--include-git-context",
        "--append-run-log",
      ],
      { cwd, encoding: "utf-8" },
    );

    const files = readdirSync(p.runs)
      .filter((file) => file.endsWith("-estimate-append.md"))
      .sort();
    const content = readFileSync(join(p.runs, files.at(-1) ?? ""), "utf-8");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Appended token estimate to run log:");
    expect(content).toContain("## Token Estimate");
    expect(content).toContain("- estimated: true");
    expect(content).toContain("- method: ceil(characters / 4)");
    expect(content).toContain("- base Manciple handoff:");
    expect(content).toContain("- review prompt:");
    expect(content).toContain("- latest run log:");
    expect(content).toContain("- git diff:");
    expect(content).toContain("- git context:");
  });
});
