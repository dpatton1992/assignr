import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { initCommand } from "../src/commands/init.js";
import { renderReviewPrompt } from "../src/commands/review.js";
import { reviewCheckCommand } from "../src/commands/reviewCheck.js";
import { runLogCommand } from "../src/commands/runLog.js";
import type { TaskSpec } from "../src/specs/schema.js";
import { getPaths } from "../src/utils/paths.js";

let cwd: string;
let p: ReturnType<typeof getPaths>;

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-review-check-"));
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
    status: "needs_review",
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
    allowed_paths: ["src/commands/reviewCheck.ts", "tests/reviewCheck.test.ts"],
    forbidden_paths: ["dist/"],
    goal: "Check review evidence.",
    acceptance_criteria: ["Review evidence is checked."],
    verification: {
      commands: ["pnpm build", "pnpm test"],
    },
    outputs_required: ["files_changed", "tests_run", "decisions_made", "risks", "follow_ups"],
    notes: [],
    ...overrides,
  };

  mkdirSync(p.tasksActive, { recursive: true });
  writeFileSync(join(p.tasksActive, `${id}.yaml`), stringify(task, { lineWidth: 0 }), "utf-8");
}

function writeCompleteRunLog(taskId: string): void {
  runLogCommand(taskId, p.specsTasks, p.runs, p.promptsGenerated, cwd, {
    result: "complete",
    commandsRun: ["pnpm build", "pnpm test"],
    testsRun: ["pnpm build", "pnpm test"],
    filesChanged: ["src/commands/reviewCheck.ts", "tests/reviewCheck.test.ts"],
    decisionsMade: ["Review evidence is checked before approval."],
    risks: "none",
    followUps: ["none"],
    acceptanceCriteriaEvidence: [
      "Review evidence is checked.: Complete receipt covers review check.",
    ],
  });
}

function appendTokenEstimateSection(taskId: string, section: string): void {
  const runLogFile = join(
    p.runs,
    readdirSync(p.runs)
      .filter((file) => file.endsWith(`-${taskId}.md`))
      .sort()
      .at(-1) ?? "",
  );
  appendFileSync(runLogFile, `\n\n## Token Estimate\n\n${section}\n`, "utf-8");
}

function writeGeneratedPrompts(taskId: string): void {
  mkdirSync(p.promptsGenerated, { recursive: true });
  writeFileSync(join(p.promptsGenerated, `${taskId}.md`), "implementation prompt", "utf-8");
  writeFileSync(join(p.promptsGenerated, `review-${taskId}.md`), "review prompt", "utf-8");
}

describe("reviewCheckCommand", () => {
  it("includes budget warning confirmation in generated review prompt checklists", () => {
    const task: TaskSpec = {
      id: "review-prompt-budget-warning",
      title: "review-prompt-budget-warning",
      status: "needs_review",
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
      allowed_paths: ["src/commands/review.ts"],
      forbidden_paths: ["dist/"],
      goal: "Review budget warning evidence.",
      acceptance_criteria: ["Budget warnings are checked."],
      verification: {
        commands: ["pnpm test"],
      },
      outputs_required: ["files_changed"],
      notes: [],
    };

    expect(
      renderReviewPrompt(task, cwd, {
        includeRunLog: false,
        includeGitDiff: false,
      }),
    ).toContain("- [ ] Budget warning present but warning-only behavior confirmed.");
  });

  it("exits zero and prints ready rows when all needs_review tasks are ready", () => {
    writeTask("ready-one");
    writeTask("ready-two");
    writeCompleteRunLog("ready-one");
    writeCompleteRunLog("ready-two");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() => reviewCheckCommand(p.tasksActive, cwd)).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();

      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("ready-one");
      expect(output).toContain("ready-two");
      expect(output).toContain("ready");
      expect(output).toContain("100");
      expect(output).not.toContain("missing-evidence");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("exits non-zero and prints shared missing-evidence messages", () => {
    writeTask("missing-evidence");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() => reviewCheckCommand(p.tasksActive, cwd)).toThrow("process.exit(1)");
      expect(exitSpy).toHaveBeenCalledWith(1);

      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("missing-evidence");
      expect(output).toContain("No run log is available for task missing-evidence.");
      expect(output).toContain("No verification commands are recorded in the run log.");
      expect(output).toContain("No risks entry is recorded in the run log");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("reports over-budget estimates without warning-only confirmation as missing review evidence", () => {
    writeTask("budget-warning-needs-attention");
    writeCompleteRunLog("budget-warning-needs-attention");
    appendTokenEstimateSection(
      "budget-warning-needs-attention",
      [
        "Scope: estimates Manciple artifact/context bloat only.",
        "- estimated: true",
        "- method: ceil(characters / 4)",
        "Budget warning: over budget (15804/4000 estimated tokens).",
      ].join("\n"),
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() =>
        reviewCheckCommand(p.tasksActive, cwd, "budget-warning-needs-attention"),
      ).toThrow("process.exit(1)");
      expect(exitSpy).toHaveBeenCalledWith(1);

      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("budget-warning-needs-attention");
      expect(output).toContain(
        "Over-budget token estimate needs review evidence confirming budget overages are warning-only.",
      );
      expect(output).not.toContain("Verification command(s) appear to have failed");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("narrows checks to a single task id", () => {
    writeTask("selected-ready");
    writeTask("unselected-missing");
    writeCompleteRunLog("selected-ready");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() => reviewCheckCommand(p.tasksActive, cwd, "selected-ready")).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();

      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("selected-ready");
      expect(output).not.toContain("unselected-missing");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("passes deterministic checks for a clean task", () => {
    writeTask("deterministic-ready");
    writeCompleteRunLog("deterministic-ready");
    writeGeneratedPrompts("deterministic-ready");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() =>
        reviewCheckCommand(p.tasksActive, cwd, undefined, {
          deterministic: true,
          generatedDir: p.promptsGenerated,
          activeDir: p.tasksActive,
          completedDir: p.tasksCompleted,
          archivedDir: p.tasksArchived,
        }),
      ).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(logSpy.mock.calls.flat().join("\n")).toContain("deterministic-ready");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("reports deterministic missing evidence, unreported verification, and prompt absence", () => {
    writeTask("deterministic-missing");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() =>
        reviewCheckCommand(p.tasksActive, cwd, "deterministic-missing", {
          deterministic: true,
          generatedDir: p.promptsGenerated,
          activeDir: p.tasksActive,
          completedDir: p.tasksCompleted,
          archivedDir: p.tasksArchived,
        }),
      ).toThrow("process.exit(1)");
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("deterministic-missing");
      expect(output).toContain("No verification commands are recorded in the run log.");
      expect(output).toContain(
        "No generated implementation prompt found for deterministic-missing.",
      );
      expect(output).toContain(
        "No review prompt or review outcome log found for deterministic-missing.",
      );
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("reports deterministic lifecycle and status mismatches", () => {
    writeTask("wrong-tier", { status: "needs_review" });
    writeTask("wrong-status", { status: "in_progress" });
    mkdirSync(p.tasksCompleted, { recursive: true });
    writeFileSync(
      join(p.tasksCompleted, "wrong-tier.yaml"),
      stringify(
        {
          id: "wrong-tier",
          title: "wrong-tier",
          status: "needs_review",
          type: "implementation",
          domain: "core",
          priority: "medium",
          depends_on: [],
          allowed_paths: ["src/"],
          forbidden_paths: [],
          goal: "Wrong tier.",
          acceptance_criteria: ["It is detected."],
          verification: { commands: ["pnpm test"] },
          outputs_required: ["files_changed"],
          notes: [],
        },
        { lineWidth: 0 },
      ),
      "utf-8",
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() =>
        reviewCheckCommand(p.tasksActive, cwd, "wrong-status", {
          deterministic: true,
          generatedDir: p.promptsGenerated,
          activeDir: p.tasksActive,
          completedDir: p.tasksCompleted,
          archivedDir: p.tasksArchived,
        }),
      ).toThrow("process.exit(1)");
      let output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("status-mismatch");

      logSpy.mockClear();
      expect(() =>
        reviewCheckCommand(p.tasksActive, cwd, "wrong-tier", {
          deterministic: true,
          generatedDir: p.promptsGenerated,
          activeDir: p.tasksActive,
          completedDir: p.tasksCompleted,
          archivedDir: p.tasksArchived,
        }),
      ).toThrow("process.exit(1)");
      output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("lifecycle-placement");
      expect(output).toContain('Task with status "needs_review" belongs in');
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("reports deterministic allowed and forbidden path violations", () => {
    writeTask("path-violation", {
      allowed_paths: ["src/review/"],
      forbidden_paths: ["dist/"],
    });
    writeGeneratedPrompts("path-violation");
    runLogCommand("path-violation", p.specsTasks, p.runs, p.promptsGenerated, cwd, {
      result: "complete",
      commandsRun: ["pnpm build", "pnpm test"],
      testsRun: ["pnpm build", "pnpm test"],
      filesChanged: ["dist/index.js", "README.md"],
      decisionsMade: ["Review evidence is checked before approval."],
      risks: "none",
      followUps: ["none"],
      acceptanceCriteriaEvidence: [
        "Review evidence is checked.: Complete receipt covers review check.",
      ],
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() =>
        reviewCheckCommand(p.tasksActive, cwd, "path-violation", {
          deterministic: true,
          generatedDir: p.promptsGenerated,
          activeDir: p.tasksActive,
          completedDir: p.tasksCompleted,
          archivedDir: p.tasksArchived,
        }),
      ).toThrow("process.exit(1)");
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("Changed file README.md is outside allowed_paths.");
      expect(output).toContain("Changed file dist/index.js matches forbidden_paths entry dist/.");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("reports claimed-path overlap as an advisory without failing the gate", () => {
    writeTask("target-overlap", {
      allowed_paths: ["src/review/", "src/commands/reviewCheck.ts", "tests/reviewCheck.test.ts"],
    });
    writeTask("owner-overlap", {
      status: "in_progress",
      allowed_paths: ["src/review/readiness.ts"],
      path_ownership: {
        touched_paths: ["src/review/readiness.ts"],
        locked_paths: [],
        unsafe_parallel_areas: [],
      },
    });
    writeCompleteRunLog("target-overlap");
    writeGeneratedPrompts("target-overlap");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() =>
        reviewCheckCommand(p.tasksActive, cwd, "target-overlap", {
          deterministic: true,
          generatedDir: p.promptsGenerated,
          activeDir: p.tasksActive,
          completedDir: p.tasksCompleted,
          archivedDir: p.tasksArchived,
        }),
      ).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("pass");
      expect(output).toContain("Advisories");
      expect(output).toContain("overlaps touched claim");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
