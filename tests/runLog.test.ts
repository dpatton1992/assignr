import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initCommand } from "../src/commands/init.js";
import { newCommand } from "../src/commands/new.js";
import { runLogCommand } from "../src/commands/runLog.js";
import { findLatestRunLogPath, readLatestRunLogContent } from "../src/review/evidence.js";
import { getPaths } from "../src/utils/paths.js";

let cwd: string;
let p: ReturnType<typeof getPaths>;

function latestRunLog(): string {
  const files = readdirSync(p.runs)
    .filter((file) => file.endsWith(".md"))
    .sort();
  return readFileSync(join(p.runs, files.at(-1) ?? ""), "utf-8");
}

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-run-log-"));
  p = getPaths(cwd, ".manciple");
  await initCommand({ force: false, cwd, root: ".manciple" });
  newCommand("Run log capture", {
    type: "implementation",
    domain: "core",
    priority: "high",
    cwd,
    activeDir: p.tasksActive,
  });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("runLogCommand", () => {
  it("auto-populates changed files from git status", () => {
    spawnSync("git", ["init"], { cwd, encoding: "utf-8" });
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "app.ts"), "export const ok = true;\n", "utf-8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      runLogCommand("run-log-capture", p.specsTasks, p.runs, p.promptsGenerated, cwd);

      expect(existsSync(p.runs)).toBe(true);
      const content = latestRunLog();
      expect(content).toContain("_Source: auto-detected from git status_");
      expect(content).toContain("- src/app.ts");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("records flag-provided metadata and repeated commands", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      runLogCommand("run-log-capture", p.specsTasks, p.runs, p.promptsGenerated, cwd, {
        result: "partial",
        taskStatus: "needs_review",
        model: "gpt-5-codex",
        agent: "Codex",
        commandsRun: ["pnpm typecheck", "pnpm test"],
        testsRun: ["pnpm test"],
        filesChanged: ["src/commands/runLog.ts"],
        decisionsMade: ["Kept the run-log format markdown-compatible."],
        risks: "No known runtime risks.",
        followUps: ["none"],
        acceptanceCriteriaEvidence: [
          "Run logs expose receipt fields.: Added first-class receipt sections.",
        ],
        verifyReceipt: '{"ok":true,"profile":"worker"}',
        notes: "Implemented run-log metadata capture.",
      });

      const content = latestRunLog();
      expect(content).toContain("- Agent/Harness (provided by user): Codex");
      expect(content).toContain("- Model (provided by user): gpt-5-codex");
      expect(content).toContain("- Status: needs_review");
      expect(content).toContain("- src/commands/runLog.ts");
      expect(content).toContain("- pnpm typecheck");
      expect(content).toContain("- pnpm test");
      expect(content).toContain("## Tests Run");
      expect(content).toContain("## Verification Receipt");
      expect(content).toContain('{"ok":true,"profile":"worker"}');
      expect(content).toContain("## Decisions Made");
      expect(content).toContain("Kept the run-log format markdown-compatible.");
      expect(content).toContain("partial");
      expect(content).toContain("No known runtime risks.");
      expect(content).toContain("## Follow-Up Tasks");
      expect(content).toContain("- none");
      expect(content).toContain("## Acceptance Criteria Evidence");
      expect(content).toContain("Added first-class receipt sections.");
      expect(content).toContain("Implemented run-log metadata capture.");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("records optional token and cost evidence when provided", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      runLogCommand("run-log-capture", p.specsTasks, p.runs, p.promptsGenerated, cwd, {
        inputTokens: 120,
        outputTokens: 80,
        totalTokens: 200,
        costUsd: 0.0123,
      });

      const content = latestRunLog();
      expect(content).toContain("## Usage Evidence");
      expect(content).toContain("- Input tokens: 120");
      expect(content).toContain("- Output tokens: 80");
      expect(content).toContain("- Total tokens: 200");
      expect(content).toContain("## Cost Evidence");
      expect(content).toContain("- Cost USD: 0.0123");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("keeps test evidence separate from non-test commands", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      runLogCommand("run-log-capture", p.specsTasks, p.runs, p.promptsGenerated, cwd, {
        commandsRun: ["pnpm build"],
      });

      const content = latestRunLog();
      expect(content).toContain("## Commands Run");
      expect(content).toContain("- pnpm build");
      expect(content).toContain("## Tests Run");
      expect(content).toContain(
        "Unknown: no tests were provided. Pass test commands in tests_run or provide a deterministic verify receipt.",
      );
      expect(content).toContain("Unknown: no deterministic verify receipt was provided.");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("guides completed implementation run logs to record decisions made", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      runLogCommand("run-log-capture", p.specsTasks, p.runs, p.promptsGenerated, cwd, {
        result: "complete",
      });

      const content = latestRunLog();
      expect(content).toContain("## Decisions Made");
      expect(content).toContain(
        "Completed implementation work that changed behavior must record Decisions Made; omit only when blocked before meaningful changes.",
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("records CLI-provided task status, tests, acceptance evidence, and verify receipt", () => {
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
        "run-log",
        "run-log-capture",
        "--task-status",
        "needs_review",
        "--command",
        "pnpm build",
        "--test",
        "pnpm test -- runLog",
        "--acceptance-evidence",
        "Acceptance evidence recorded.",
        "--verify-receipt",
        '{"ok":true,"profile":"worker"}',
      ],
      { cwd, encoding: "utf-8" },
    );

    expect(result.status).toBe(0);
    const content = latestRunLog();
    expect(content).toContain("- Status: needs_review");
    expect(content).toContain("- pnpm build");
    expect(content).toContain("- pnpm test -- runLog");
    expect(content).toContain("Acceptance evidence recorded.");
    expect(content).toContain('{"ok":true,"profile":"worker"}');
  });

  it("succeeds with clear fallback text outside a git repository", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      runLogCommand("run-log-capture", p.specsTasks, p.runs, p.promptsGenerated, cwd);

      const content = latestRunLog();
      expect(content).toContain("_Source: unknown_");
      expect(content).toContain(
        "Unknown: git is unavailable or this directory is not a git repository.",
      );
      expect(content).toContain("Unknown: no commands were provided.");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("marks the first run log as superseded when a second is created", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      // Create first run log
      runLogCommand("run-log-capture", p.specsTasks, p.runs, p.promptsGenerated, cwd, {
        commandsRun: ["pnpm build"],
      });

      let files = readdirSync(p.runs)
        .filter((file) => file.endsWith(".md"))
        .sort();
      expect(files.length).toBe(1);
      let firstContent = readFileSync(join(p.runs, files[0]), "utf-8");
      expect(firstContent).toContain("- Latest: true");
      expect(firstContent).not.toContain("- Supersedes:");

      // Create second run log for the same task
      runLogCommand("run-log-capture", p.specsTasks, p.runs, p.promptsGenerated, cwd, {
        commandsRun: ["pnpm test"],
      });

      files = readdirSync(p.runs)
        .filter((file) => file.endsWith(".md"))
        .sort();
      expect(files.length).toBe(2);

      // First file should now be marked superseded
      firstContent = readFileSync(join(p.runs, files[0]), "utf-8");
      expect(firstContent).toContain("- Superseded by:");
      expect(firstContent).toContain(files[1]); // references the new file

      // Second file should be latest and reference supersedes
      const secondContent = readFileSync(join(p.runs, files[1]), "utf-8");
      expect(secondContent).toContain("- Latest: true");
      expect(secondContent).toContain("- Supersedes:");
      expect(secondContent).toContain(files[0]); // references the old file

      // findLatestRunLogPath should return the second file
      const latestPath = findLatestRunLogPath(cwd, "run-log-capture");
      expect(latestPath).toBeDefined();
      expect(latestPath).toContain(files[1]);

      // readLatestRunLogContent should return the second file's content
      const latestContent = readLatestRunLogContent(cwd, "run-log-capture");
      expect(latestContent).toBeDefined();
      expect(latestContent).toContain("- pnpm test");
      expect(latestContent).not.toContain("- pnpm build");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("keeps backward compatibility for an existing single run log without latest marker", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      // Write a run log "manually" without the latest marker (simulating pre-feature file)
      const oldFilename = "2026-01-01T00-00-00-run-log-capture.md";
      const oldPath = join(p.runs, oldFilename);
      writeFileSync(
        oldPath,
        `# Run Log: Run log capture\n\n## Metadata\n\n- Task ID: run-log-capture\n- Status: needs_review\n`,
        "utf-8",
      );

      // Even without the latest marker, should be found
      const content = readLatestRunLogContent(cwd, "run-log-capture");
      expect(content).toBeDefined();
      expect(content).toContain("Task ID: run-log-capture");

      // Creating a new run log should supersede it
      runLogCommand("run-log-capture", p.specsTasks, p.runs, p.promptsGenerated, cwd, {
        commandsRun: ["pnpm test"],
      });

      const files = readdirSync(p.runs)
        .filter((file) => file.endsWith(".md"))
        .sort();
      expect(files.length).toBe(2);

      // Old file should be marked superseded
      const oldContent = readFileSync(join(p.runs, files[0]), "utf-8");
      expect(oldContent).toContain("- Superseded by:");

      // New file should have Latest: true and Supersedes
      const newContent = readFileSync(join(p.runs, files[1]), "utf-8");
      expect(newContent).toContain("- Latest: true");
      expect(newContent).toContain("- Supersedes:");

      // findLatestRunLogPath should return the new file
      const latestPath = findLatestRunLogPath(cwd, "run-log-capture");
      expect(latestPath).toBeDefined();
      expect(latestPath).toContain(files[1]);
    } finally {
      logSpy.mockRestore();
    }
  });
});
