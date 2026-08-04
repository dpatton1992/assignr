import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { initCommand } from "../src/commands/init.js";
import { reviewQueueCommand } from "../src/commands/reviewQueue.js";
import { runLogCommand } from "../src/commands/runLog.js";
import type { TaskSpec } from "../src/specs/schema.js";
import { getPaths } from "../src/utils/paths.js";

let cwd: string;
let p: ReturnType<typeof getPaths>;

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-review-queue-"));
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
    allowed_paths: ["src/commands/reviewQueue.ts", "tests/reviewQueue.test.ts"],
    forbidden_paths: ["dist/"],
    goal: "Triage review queue evidence.",
    acceptance_criteria: ["Review queue triage classifies task evidence."],
    verification: {
      commands: ["pnpm build", "pnpm test"],
    },
    outputs_required: ["files_changed", "tests_run", "decisions_made", "risks"],
    notes: [],
    ...overrides,
  };

  mkdirSync(p.tasksActive, { recursive: true });
  writeFileSync(join(p.tasksActive, `${id}.yaml`), stringify(task, { lineWidth: 0 }), "utf-8");
}

function writeCompleteRunLog(
  taskId: string,
  overrides: Parameters<typeof runLogCommand>[5] = {},
): void {
  runLogCommand(taskId, p.specsTasks, p.runs, p.promptsGenerated, cwd, {
    result: "complete",
    commandsRun: ["pnpm build", "pnpm test"],
    testsRun: ["pnpm build", "pnpm test"],
    filesChanged: ["src/commands/reviewQueue.ts", "tests/reviewQueue.test.ts"],
    decisionsMade: ["Review queue triage classifies task evidence."],
    risks: "none",
    followUps: ["none"],
    acceptanceCriteriaEvidence: [
      "Review queue triage classifies task evidence.: Complete receipt covers triage.",
    ],
    ...overrides,
  });
}

function writeGeneratedPrompts(taskId: string): void {
  mkdirSync(p.promptsGenerated, { recursive: true });
  writeFileSync(join(p.promptsGenerated, `${taskId}.md`), "implementation prompt", "utf-8");
  writeFileSync(join(p.promptsGenerated, `review-${taskId}.md`), "review prompt", "utf-8");
}

function runTriage(): void {
  reviewQueueCommand(p.tasksActive, cwd, {
    mode: "triage",
    generatedDir: p.promptsGenerated,
    activeDir: p.tasksActive,
    completedDir: p.tasksCompleted,
    archivedDir: p.tasksArchived,
  });
}

function runDeep(
  options: { all?: boolean; budget?: string | number; deepOnly?: "risky" } = {},
): void {
  reviewQueueCommand(p.tasksActive, cwd, {
    mode: "deep",
    all: options.all,
    budget: options.budget,
    deepOnly: options.deepOnly,
    generatedDir: p.promptsGenerated,
    activeDir: p.tasksActive,
    completedDir: p.tasksCompleted,
    archivedDir: p.tasksArchived,
  });
}

describe("reviewQueueCommand", () => {
  it("prints pass rows for needs_review tasks with complete deterministic evidence", () => {
    writeTask("ready-review");
    writeCompleteRunLog("ready-review");
    writeGeneratedPrompts("ready-review");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() => runTriage()).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("ready-review");
      expect(output).toContain("deterministic=pass");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("escalates tasks with missing run log evidence", () => {
    writeTask("missing-log");
    writeGeneratedPrompts("missing-log");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() => runTriage()).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("missing-log");
      expect(output).toContain("missing-run-log");
      expect(output).toContain("missing-evidence");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("escalates tasks with failed or missing verification evidence", () => {
    writeTask("failed-tests");
    writeCompleteRunLog("failed-tests", {
      result: "failed",
      commandsRun: ["pnpm build"],
      testsRun: ["pnpm build"],
    });
    writeGeneratedPrompts("failed-tests");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() => runTriage()).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("failed-tests");
      expect(output).toContain("missing-evidence");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("escalates tasks with obvious allowed and forbidden path violations", () => {
    writeTask("path-violation", {
      allowed_paths: ["src/review/"],
      forbidden_paths: ["dist/"],
    });
    writeCompleteRunLog("path-violation", {
      filesChanged: ["dist/index.js", "README.md"],
    });
    writeGeneratedPrompts("path-violation");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() => runTriage()).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("path-violation");
      expect(output).toContain("path-policy");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("blocks load errors that prevent deterministic triage", () => {
    mkdirSync(p.tasksActive, { recursive: true });
    writeFileSync(join(p.tasksActive, "invalid.yaml"), "id: invalid\nstatus: nope\n", "utf-8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() =>
        reviewQueueCommand(p.tasksActive, cwd, {
          mode: "triage",
          generatedDir: p.promptsGenerated,
          activeDir: p.tasksActive,
          completedDir: p.tasksCompleted,
          archivedDir: p.tasksArchived,
        }),
      ).toThrow("process.exit(1)");
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("invalid<unknown>");
      expect(output).toContain("load-error");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("deep mode emits review prompt targets for tasks missing evidence", () => {
    writeTask("missing-evidence");
    writeGeneratedPrompts("missing-evidence");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() => runDeep()).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("── Task: missing-evidence");
      expect(output).toContain("review-missing-evidence.md");
      expect(output).toContain("missing-run-log");
      expect(output).toContain("score:");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("deep mode escalates residual risk with the evidence that triggered it", () => {
    writeTask("risky-review");
    writeCompleteRunLog("risky-review", {
      risks: "Manual migration may need production coordination.",
    });
    writeGeneratedPrompts("risky-review");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() => runDeep()).not.toThrow();
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("── Task: risky-review");
      expect(output).toContain("documented-risk");
      expect(output).toContain("risks:");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("deep mode escalates failed verification evidence", () => {
    writeTask("deep-failed-tests");
    writeCompleteRunLog("deep-failed-tests", {
      result: "failed",
      commandsRun: ["pnpm build"],
      testsRun: ["pnpm build"],
    });
    writeGeneratedPrompts("deep-failed-tests");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() => runDeep()).not.toThrow();
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("── Task: deep-failed-tests");
      expect(output).toContain("failedVerification:");
      expect(output).toContain("missingVerification:");
      expect(output).toContain("missing-evidence");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("deep mode escalates forbidden path changes", () => {
    writeTask("deep-path-violation", {
      allowed_paths: ["src/review/"],
      forbidden_paths: ["dist/"],
    });
    writeCompleteRunLog("deep-path-violation", {
      filesChanged: ["dist/index.js"],
    });
    writeGeneratedPrompts("deep-path-violation");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() => runDeep()).not.toThrow();
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("── Task: deep-path-violation");
      expect(output).toContain("path-policy");
      expect(output).toContain("changedFiles:");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("deep mode does not escalate passing tasks unless all review tasks are requested", () => {
    writeTask("ready-deep-review");
    writeCompleteRunLog("ready-deep-review");
    writeGeneratedPrompts("ready-deep-review");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() => runDeep()).not.toThrow();
      const firstOutput = logSpy.mock.calls.flat().join("\n");
      expect(firstOutput).toContain("No tasks escalated for deep review.");

      logSpy.mockClear();
      expect(() => runDeep({ all: true })).not.toThrow();
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("── Task: ready-deep-review");
      expect(output).toContain("deterministic=pass");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("deep mode includes compact packets for escalated tasks", () => {
    writeTask("packet-review", {
      acceptance_criteria: [
        "Review queue triage classifies task evidence.",
        "Review queue packet stays compact.",
      ],
    });
    writeCompleteRunLog("packet-review", {
      risks: "Reviewer should confirm rollout order.",
      acceptanceCriteriaEvidence: [
        "Review queue triage classifies task evidence.: Complete receipt covers triage.",
      ],
    });
    writeGeneratedPrompts("packet-review");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() => runDeep()).not.toThrow();
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("── Task: packet-review");
      expect(output).toContain("Packet:");
      expect(output).toContain("Changes: 2");
      expect(output).toContain("Path: path-policy:0");
      expect(output).toContain("Criteria: 2");
      expect(output).toContain("uncoveredAcceptanceCriteria: 1 items");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("deep-only risky skips passing tasks even when all review tasks are requested", () => {
    writeTask("ready-deep-review", {
      allowed_paths: ["src/ready.ts"],
    });
    writeCompleteRunLog("ready-deep-review", {
      filesChanged: ["src/ready.ts"],
    });
    writeGeneratedPrompts("ready-deep-review");
    writeTask("missing-risky", {
      allowed_paths: ["src/missing-risky.ts"],
    });
    writeGeneratedPrompts("missing-risky");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() => runDeep({ all: true, deepOnly: "risky" })).not.toThrow();
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).not.toContain("ready-deep-review");
      expect(output).toContain("── Task: missing-risky");
      expect(output).toContain("incomplete-acceptance-evidence, missing-evidence, missing-receipt");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("deep mode enforces a packet budget and reports how many fit", () => {
    writeTask("budgeted-review");
    writeGeneratedPrompts("budgeted-review");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() => runDeep({ budget: 1 })).not.toThrow();
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).not.toContain("budgeted-review"); // task not emitted due to budget
      expect(output).toContain("Budget: limit=1, fit=0/1, estimated=0");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
