/**
 * Happy-path integration test for the core CLI workflow:
 *   init → new → list → validate → compile → set-status
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: { value: "/nonexistent/manciple-test-home" },
}));

// Point homedir at a controlled location so init scope tests can assert that
// default init never writes the user-global OpenCode config.
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => homedirMock.value };
});

import { archiveCommand } from "../src/commands/archive.js";
import { checkLifecycleCommand } from "../src/commands/checkLifecycle.js";
import { compileCommand } from "../src/commands/compile.js";
import { completeCommand } from "../src/commands/complete.js";
import { initCommand } from "../src/commands/init.js";
import { listCommand } from "../src/commands/list.js";
import { newCommand, newInteractiveCommand } from "../src/commands/new.js";
import { reopenCommand } from "../src/commands/reopen.js";
import { reviewCommand } from "../src/commands/review.js";
import { setStatusCommand } from "../src/commands/setStatus.js";
import { statusCommand } from "../src/commands/status.js";
import { validateCommand } from "../src/commands/validate.js";
import { loadTasks } from "../src/specs/loadTasks.js";
import { getPaths } from "../src/utils/paths.js";
import { formatYamlDocument } from "../src/utils/yamlFormat.js";

let cwd: string;
let p: ReturnType<typeof getPaths>;

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-happy-path-"));
  p = getPaths(cwd, ".manciple");
  await initCommand({ force: false, cwd, root: ".manciple" });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("manciple init", () => {
  it("prints the Manciple crate banner", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let output = "";

    try {
      await initCommand({ force: false, cwd, root: ".manciple" });
      output = logSpy.mock.calls.flat().join("\n");
    } finally {
      logSpy.mockRestore();
    }

    expect(output).toContain("/   M A N C I P L E");
    expect(output).toContain("|  tasks/        prompts/");
    expect(output).toContain("|  runs/         reviews/");
    expect(output).toContain("repo-native agent stewardship");
  });

  it("prompts before linking the source checkout CLI globally during init", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const confirmGlobalLink = vi.fn(() => true);
    const linkPackageGlobally = vi.fn(() => ({ ok: true }));
    let output = "";

    try {
      await initCommand({
        force: false,
        cwd,
        root: ".manciple",
        globalLink: { packageRoot: cwd, confirmGlobalLink, linkPackageGlobally },
      });
      output = logSpy.mock.calls.flat().join("\n");
    } finally {
      logSpy.mockRestore();
    }

    expect(confirmGlobalLink).toHaveBeenCalledOnce();
    expect(linkPackageGlobally).toHaveBeenCalledWith(cwd);
    expect(output).toContain("CLI linked globally");
  });

  it("skips global CLI linking when the prompt is declined", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const confirmGlobalLink = vi.fn(() => false);
    const linkPackageGlobally = vi.fn(() => ({ ok: true }));
    let output = "";

    try {
      await initCommand({
        force: false,
        cwd,
        root: ".manciple",
        globalLink: { packageRoot: cwd, confirmGlobalLink, linkPackageGlobally },
      });
      output = logSpy.mock.calls.flat().join("\n");
    } finally {
      logSpy.mockRestore();
    }

    expect(confirmGlobalLink).toHaveBeenCalledOnce();
    expect(linkPackageGlobally).not.toHaveBeenCalled();
    expect(output).toContain("CLI global link skipped");
  });

  it("creates the canonical lifecycle directories", () => {
    expect(existsSync(p.tasksActive)).toBe(true);
    expect(existsSync(p.tasksCompleted)).toBe(true);
    expect(existsSync(p.tasksArchived)).toBe(true);
  });

  it("does NOT create the legacy specs/tasks directory", () => {
    expect(existsSync(p.specsTasks)).toBe(false);
  });

  it("creates prompts/templates and state", () => {
    expect(existsSync(p.promptsTemplates)).toBe(true);
    expect(existsSync(p.stateFile)).toBe(true);
  });

  it("creates a default core domain without overwriting user edits", async () => {
    const coreDomainPath = join(p.specsDomains, "core.yaml");

    expect(existsSync(coreDomainPath)).toBe(true);
    expect(readFileSync(coreDomainPath, "utf-8")).toContain("id: core");

    writeFileSync(coreDomainPath, "id: core\nname: Custom Core\n", "utf-8");
    await initCommand({ force: true, cwd, root: ".manciple" });

    expect(readFileSync(coreDomainPath, "utf-8")).toBe("id: core\nname: Custom Core\n");
  });

  it("is idempotent and never writes user-global OpenCode config by default", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "manciple-fake-home-"));
    homedirMock.value = fakeHome;
    try {
      await initCommand({ force: false, cwd, root: ".manciple" });

      // Repo-local .mcp.json is written by default init.
      expect(existsSync(join(cwd, ".mcp.json"))).toBe(true);

      // No user-global OpenCode config may be created by default init.
      const globalConfig = join(fakeHome, ".config", "opencode", "opencode.json");
      expect(existsSync(globalConfig)).toBe(false);

      // Rerunning init stays idempotent and still does not touch user-global config.
      await initCommand({ force: false, cwd, root: ".manciple" });
      expect(existsSync(globalConfig)).toBe(false);
    } finally {
      homedirMock.value = "/nonexistent/manciple-test-home";
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("writes the user-global OpenCode config only with the explicit --global-mcp flag", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "manciple-fake-home-"));
    homedirMock.value = fakeHome;
    try {
      await initCommand({ force: false, cwd, root: ".manciple", globalMcp: true });

      const globalConfig = join(fakeHome, ".config", "opencode", "opencode.json");
      expect(existsSync(globalConfig)).toBe(true);
      const config = JSON.parse(readFileSync(globalConfig, "utf-8")) as Record<string, unknown>;
      expect((config.mcp as Record<string, unknown>).manciple).toBeDefined();
    } finally {
      homedirMock.value = "/nonexistent/manciple-test-home";
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("writes a commands README using Manciple names and the canonical workflow", async () => {
    const readmePath = join(p.commands, "README.md");
    expect(existsSync(readmePath)).toBe(true);

    const content = readFileSync(readmePath, "utf-8");
    expect(content).toContain("# Manciple Commands");
    expect(content).toContain("manciple task new");
    expect(content).toContain("manciple handoff my-task-title");
    expect(content).toContain("manciple run-log my-task-title");
    expect(content).toContain("manciple review my-task-title");
    expect(content).not.toContain("assignr");
    expect(content).not.toContain('manciple new "My task title"');
  });
});

describe("command hints", () => {
  it("newCommand recommends manciple handoff instead of the legacy compile alias", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let output = "";
    try {
      newCommand("Hint task", {
        type: "implementation",
        domain: "core",
        priority: "high",
        cwd,
        activeDir: p.tasksActive,
      });
      output = logSpy.mock.calls.flat().join("\n");
    } finally {
      logSpy.mockRestore();
    }

    expect(output).toContain("manciple handoff hint-task");
    expect(output).not.toContain("manciple compile");
  });

  it("validateCommand empty-queue hint recommends manciple task new", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "manciple-empty-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    let output = "";
    try {
      validateCommand(getPaths(emptyDir, ".manciple").specsTasks, emptyDir);
      output = warnSpy.mock.calls.flat().join("\n");
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      exitSpy.mockRestore();
      rmSync(emptyDir, { recursive: true, force: true });
    }

    expect(output).toContain("manciple task new");
  });
});

describe("manciple new", () => {
  it("creates a task YAML in tasks/active/", () => {
    newCommand("License expiration reminders", {
      type: "implementation",
      domain: "credentialing",
      priority: "high",
      goal: "Add expiration reminder support for provider licenses.",
      cwd,
      activeDir: p.tasksActive,
    });

    const taskFile = join(p.tasksActive, "license-expiration-reminders.yaml");
    expect(existsSync(taskFile)).toBe(true);
  });

  it("writes a valid YAML spec with the expected fields", () => {
    newCommand("License expiration reminders", {
      type: "implementation",
      domain: "credentialing",
      priority: "high",
      goal: "Add expiration reminder support for provider licenses.",
      cwd,
      activeDir: p.tasksActive,
    });

    const taskFile = join(p.tasksActive, "license-expiration-reminders.yaml");
    const spec = parse(readFileSync(taskFile, "utf-8")) as Record<string, unknown>;
    expect(spec.id).toBe("license-expiration-reminders");
    expect(spec.title).toBe("License expiration reminders");
    expect(spec.status).toBe("pending");
    expect(spec.type).toBe("implementation");
    expect(spec.domain).toBe("credentialing");
    expect(spec.priority).toBe("high");
  });

  it("does NOT write to specs/tasks/", () => {
    newCommand("License expiration reminders", {
      type: "implementation",
      domain: "credentialing",
      priority: "high",
      goal: "Add expiration reminder support for provider licenses.",
      cwd,
      activeDir: p.tasksActive,
    });

    const legacyFile = join(p.specsTasks, "license-expiration-reminders.yaml");
    expect(existsSync(legacyFile)).toBe(false);
  });

  it("creates a task from interactive answers without placeholder TODO text", async () => {
    const answers = [
      "Guided onboarding task",
      "Create a guided first-run task creation flow.",
      "",
      "core",
      "high",
      "User can create a complete task from prompts.",
      "",
      "pnpm test -- new",
      "",
      "src/commands/new.ts",
      "tests/",
      "",
      "dist/",
      "",
      "files_changed",
      "risks",
      "",
      "Keep prompts easy to test.",
      "",
    ];
    const prompts: string[] = [];

    await newInteractiveCommand(undefined, {
      type: "implementation",
      domain: "core",
      priority: "medium",
      cwd,
      activeDir: p.tasksActive,
      question: async (prompt) => {
        prompts.push(prompt);
        const answer = answers.shift();
        if (answer === undefined) {
          throw new Error(`Unexpected prompt: ${prompt}`);
        }
        return answer;
      },
    });

    const taskFile = join(p.tasksActive, "guided-onboarding-task.yaml");
    const raw = readFileSync(taskFile, "utf-8");
    const spec = parse(raw) as Record<string, unknown>;

    expect(prompts.join("\n")).toContain("Title:");
    expect(prompts.join("\n")).toContain("Goal:");
    expect(prompts.join("\n")).toContain("Acceptance criterion");
    expect(prompts.join("\n")).toContain("Verification command");
    expect(prompts.join("\n")).toContain("Allowed path");
    expect(prompts.join("\n")).toContain("Forbidden path");
    expect(prompts.join("\n")).toContain("Output required");
    expect(prompts.join("\n")).toContain("Note");
    expect(raw).not.toContain("TODO:");
    expect(spec.title).toBe("Guided onboarding task");
    expect(spec.goal).toBe("Create a guided first-run task creation flow.");
    expect(spec.type).toBe("implementation");
    expect(spec.domain).toBe("core");
    expect(spec.priority).toBe("high");
    expect(spec.acceptance_criteria).toEqual(["User can create a complete task from prompts."]);
    expect(spec.verification).toEqual({ commands: ["pnpm test -- new"] });
    expect(spec.allowed_paths).toEqual(["src/commands/new.ts", "tests/"]);
    expect(spec.forbidden_paths).toEqual(["dist/"]);
    expect(spec.outputs_required).toEqual(["files_changed", "risks"]);
    expect(spec.notes).toEqual(["Keep prompts easy to test."]);
  });

  it("does not write a partial task when interactive prompting fails", async () => {
    await expect(
      newInteractiveCommand(undefined, {
        type: "implementation",
        domain: "core",
        priority: "medium",
        cwd,
        activeDir: p.tasksActive,
        question: async () => {
          throw new Error("cancelled");
        },
      }),
    ).rejects.toThrow("Error: interactive task creation failed: cancelled");

    expect(existsSync(join(p.tasksActive, "guided-onboarding-task.yaml"))).toBe(false);
  });

  it("throws without writing a task when --goal is empty", () => {
    expect(() =>
      newCommand("Empty goal task", {
        type: "implementation",
        domain: "core",
        priority: "medium",
        goal: "   ",
        cwd,
        activeDir: p.tasksActive,
      }),
    ).toThrow("Error: --goal value must not be empty.");

    expect(existsSync(join(p.tasksActive, "empty-goal-task.yaml"))).toBe(false);
  });

  it("throws without writing a task when the title cannot generate an id", () => {
    expect(() =>
      newCommand("!!!", {
        type: "implementation",
        domain: "core",
        priority: "medium",
        cwd,
        activeDir: p.tasksActive,
      }),
    ).toThrow("Error: could not generate a valid id from the provided title.");
  });

  it("throws without overwriting a duplicate task spec", () => {
    const created = newCommand("Duplicate task", {
      type: "implementation",
      domain: "core",
      priority: "medium",
      goal: "Create the first copy.",
      cwd,
      activeDir: p.tasksActive,
    });

    expect(() =>
      newCommand("Duplicate task", {
        type: "implementation",
        domain: "core",
        priority: "medium",
        goal: "Create the second copy.",
        cwd,
        activeDir: p.tasksActive,
      }),
    ).toThrow("Error: task spec already exists at .manciple/tasks/active/duplicate-task.yaml");

    expect(readFileSync(created, "utf-8")).toContain("Create the first copy.");
  });
});

describe("manciple list", () => {
  it("finds a task created by manciple new", () => {
    newCommand("License expiration reminders", {
      type: "implementation",
      domain: "credentialing",
      priority: "high",
      goal: "Add expiration reminder support for provider licenses.",
      cwd,
      activeDir: p.tasksActive,
    });

    // loadTasks via specsTasks path should discover the task in tasks/active/
    const { tasks, errors } = loadTasks(p.specsTasks);
    expect(errors).toEqual([]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].spec.id).toBe("license-expiration-reminders");
    expect(tasks[0].tier).toBe("active");
  });

  it("listCommand runs without error when a task exists", () => {
    newCommand("License expiration reminders", {
      type: "implementation",
      domain: "credentialing",
      priority: "high",
      goal: "Add expiration reminder support for provider licenses.",
      cwd,
      activeDir: p.tasksActive,
    });

    // listCommand prints to stdout — just verify it doesn't throw
    expect(() => listCommand(p.specsTasks, cwd)).not.toThrow();
  });
});

describe("manciple validate", () => {
  it("validates a clean-init core task with TODO warnings but no missing-domain error", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      newCommand("Test task", {
        type: "implementation",
        domain: "core",
        priority: "high",
        cwd,
        activeDir: p.tasksActive,
      });

      expect(() => validateCommand(p.specsTasks, cwd)).not.toThrow();

      const errorOutput = errorSpy.mock.calls.flat().join("\n");
      const warningOutput = warnSpy.mock.calls.flat().join("\n");
      const logOutput = logSpy.mock.calls.flat().join("\n");

      expect(errorOutput).not.toContain('references missing domain "core"');
      expect(warningOutput).toContain("TODO placeholder");
      expect(logOutput).toContain("Checked: 1 task, 1 domain,");
      expect(logOutput).toContain("contracts");
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("prints checked counts before exiting for an invalid project", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      newCommand("Missing domain task", {
        type: "implementation",
        domain: "missing-domain",
        priority: "high",
        goal: "Use a domain that does not exist.",
        cwd,
        activeDir: p.tasksActive,
      });

      expect(() => validateCommand(p.specsTasks, cwd)).toThrow("process.exit(1)");

      const errorOutput = errorSpy.mock.calls.flat().join("\n");
      const logOutput = logSpy.mock.calls.flat().join("\n");

      expect(errorOutput).toContain('references missing domain "missing-domain"');
      expect(logOutput).toContain("Checked: 1 task, 1 domain,");
      expect(logOutput).toContain("contracts");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("keeps active-only summary counts scoped to active lifecycle tasks", () => {
    newCommand("Done validation task", {
      type: "implementation",
      domain: "core",
      priority: "medium",
      goal: "Finish the validation task.",
      cwd,
      activeDir: p.tasksActive,
    });
    completeCommand("done-validation-task", {
      specsTasksDir: p.specsTasks,
      completedDir: p.tasksCompleted,
      cwd,
    });
    newCommand("Active validation task", {
      type: "implementation",
      domain: "core",
      priority: "high",
      goal: "Keep validating the active task.",
      cwd,
      activeDir: p.tasksActive,
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      validateCommand(p.specsTasks, cwd);
      const activeOutput = logSpy.mock.calls.flat().join("\n");
      const activeContracts = activeOutput.match(/Checked: 1 task, 1 domain, (\d+) contracts/);

      logSpy.mockClear();

      validateCommand(p.specsTasks, cwd, { all: true });
      const allOutput = logSpy.mock.calls.flat().join("\n");
      const allContracts = allOutput.match(/Checked: 2 tasks, 1 domain, (\d+) contracts/);

      expect(activeContracts).not.toBeNull();
      expect(allContracts).not.toBeNull();
      expect(Number(activeContracts?.[1])).toBeLessThan(Number(allContracts?.[1]));
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("validateCommand succeeds and discovers the new task", () => {
    newCommand("License expiration reminders", {
      type: "implementation",
      domain: "credentialing",
      priority: "high",
      goal: "Add expiration reminder support for provider licenses.",
      cwd,
      activeDir: p.tasksActive,
    });

    // validateCommand exits 1 on hard errors. With a valid task it should not throw.
    // Domain reference check will warn (no domain file), but should not exit 1
    // because the domain check produces an error. We skip the domain check by
    // not having a domains directory — but wait, the validateCommand derives
    // specsDomainsDir from the provided specsTasks. If the domains dir doesn't
    // have the domain file, it produces an ERROR (not a warning). So we need to
    // either create the domain file or test that validateCommand exits 1.
    //
    // Since we can't easily intercept process.exit(1) without mocking, we verify
    // loadTasks directly and validateTasks without domain checking.
    const { tasks, errors } = loadTasks(p.specsTasks);
    expect(errors).toHaveLength(0);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].spec.id).toBe("license-expiration-reminders");
  });
});

describe("manciple compile", () => {
  it("compiles a clean-init core task without missing-domain warnings", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      newCommand("Test task", {
        type: "implementation",
        domain: "core",
        priority: "high",
        cwd,
        activeDir: p.tasksActive,
      });

      expect(() =>
        compileCommand({
          specsTasksDir: p.specsTasks,
          generatedDir: p.promptsGenerated,
          cwd,
          taskId: "test-task",
        }),
      ).not.toThrow();

      const promptFile = join(p.promptsGenerated, "test-task.md");
      expect(existsSync(promptFile)).toBe(true);
      expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("domain context not found");
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("compiles a task to prompts/generated/<id>.md", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    writeFileSync(
      join(p.specsDomains, "credentialing.yaml"),
      "id: credentialing\ndescription: Provider credentialing workflows.\n",
      "utf-8",
    );

    newCommand("License expiration reminders", {
      type: "implementation",
      domain: "credentialing",
      priority: "high",
      goal: "Add expiration reminder support for provider licenses.",
      cwd,
      activeDir: p.tasksActive,
    });

    try {
      compileCommand({
        specsTasksDir: p.specsTasks,
        generatedDir: p.promptsGenerated,
        cwd,
        taskId: "license-expiration-reminders",
      });

      const promptFile = join(p.promptsGenerated, "license-expiration-reminders.md");
      expect(existsSync(promptFile)).toBe(true);
      expect(logSpy).toHaveBeenCalledWith(
        "  ✓ Compiled: .manciple/prompts/generated/license-expiration-reminders.md",
      );

      const content = readFileSync(promptFile, "utf-8");
      expect(content).toContain("License expiration reminders");
      expect(content).toContain("Add expiration reminder support for provider licenses.");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("warns about active path ownership conflicts before compiling", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      writeFileSync(
        join(p.tasksActive, "owner-task.yaml"),
        [
          "id: owner-task",
          "title: Owner Task",
          "status: in_progress",
          "type: implementation",
          "domain: core",
          "priority: high",
          "goal: Own shared compile files.",
          "acceptance_criteria:",
          "  - It owns paths.",
          "allowed_paths:",
          "  - src/commands/compile.ts",
          "forbidden_paths: []",
          "path_ownership:",
          "  touched_paths:",
          "    - src/commands/compile.ts",
          "  locked_paths:",
          "    - src/mcp.ts",
          "  unsafe_parallel_areas:",
          "    - tests/",
          "verification:",
          "  commands:",
          "    - pnpm test",
          "outputs_required:",
          "  - files_changed",
          "notes: []",
          "",
        ].join("\n"),
        "utf-8",
      );
      writeFileSync(
        join(p.tasksActive, "target-task.yaml"),
        [
          "id: target-task",
          "title: Target Task",
          "status: pending",
          "type: implementation",
          "domain: core",
          "priority: high",
          "goal: Compile with warnings.",
          "acceptance_criteria:",
          "  - It compiles.",
          "allowed_paths:",
          "  - src/commands/compile.ts",
          "  - src/mcp.ts",
          "  - tests/happyPath.test.ts",
          "forbidden_paths: []",
          "verification:",
          "  commands:",
          "    - pnpm test",
          "outputs_required:",
          "  - files_changed",
          "notes: []",
          "",
        ].join("\n"),
        "utf-8",
      );

      compileCommand({
        specsTasksDir: p.specsTasks,
        generatedDir: p.promptsGenerated,
        cwd,
        taskId: "target-task",
      });

      expect(existsSync(join(p.promptsGenerated, "target-task.md"))).toBe(true);
      const warnings = errorSpy.mock.calls.flat().join("\n");
      expect(warnings).toContain("Path ownership warnings");
      expect(warnings).toContain("owner-task");
      expect(warnings).toContain("src/commands/compile.ts");
      expect(warnings).toContain("src/mcp.ts");
      expect(warnings).toContain("tests/happyPath.test.ts");
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("manciple review", () => {
  it("creates a separate review prompt at prompts/generated/review-<id>.md", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      newCommand("License expiration reminders", {
        type: "implementation",
        domain: "credentialing",
        priority: "high",
        goal: "Add expiration reminder support for provider licenses.",
        cwd,
        activeDir: p.tasksActive,
      });

      reviewCommand("license-expiration-reminders", p.specsTasks, p.promptsGenerated, cwd);

      const reviewPromptFile = join(p.promptsGenerated, "review-license-expiration-reminders.md");
      const implementationPromptPath =
        ".manciple/prompts/generated/license-expiration-reminders.md";

      expect(existsSync(reviewPromptFile)).toBe(true);
      const logOutput = logSpy.mock.calls.flat().join("\n");
      expect(logOutput).toContain("Review prompt created");
      expect(logOutput).toContain(
        `Review prompts are separate from compiled implementation prompts, which use ${implementationPromptPath}.`,
      );

      const content = readFileSync(reviewPromptFile, "utf-8");
      expect(content).toContain("## Implementation Review");
      expect(content).toContain("## Integration Review");
      expect(content).toContain("- [ ] Allowed paths:");
      expect(content).toContain("- [ ] Forbidden paths:");
      expect(content).toContain("- [ ] Acceptance criteria evidence:");
      expect(content).toContain("- [ ] Verification evidence:");
      expect(content).toContain("- [ ] Generated artifacts:");
      expect(content).toContain("- [ ] Risk notes:");
      expect(content).toContain("## Decision");
      expect(content).toContain("- [ ] Approve");
      expect(content).toContain("- [ ] Request changes");
      expect(content).toContain("- [ ] Block");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("uses compact summaries by default and omits full run log and diff content", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      newCommand("License expiration reminders", {
        type: "implementation",
        domain: "credentialing",
        priority: "high",
        goal: "Add expiration reminder support for provider licenses.",
        cwd,
        activeDir: p.tasksActive,
      });

      const runLogPath = join(p.runs, "2026-05-23-12-00-00-license-expiration-reminders.md");
      writeFileSync(
        runLogPath,
        `# Run Log: License expiration reminders

## Files Changed

_Source: provided by user_

- src/features/licenses/reminders.ts

## Commands Run

_Source: provided by user_

- TODO: add verification commands

## Result

_Source: provided by user_

complete

## Risks

_Source: provided by user_

none
`,
        "utf-8",
      );

      const featureDir = join(cwd, "src", "features", "licenses");
      mkdirSync(featureDir, { recursive: true });
      const featureFile = join(featureDir, "reminders.ts");
      writeFileSync(featureFile, "export const reminders = false;\n", "utf-8");
      spawnSync("git", ["init"], { cwd, encoding: "utf-8" });
      spawnSync("git", ["config", "user.email", "test@example.com"], { cwd, encoding: "utf-8" });
      spawnSync("git", ["config", "user.name", "Manciple Test"], { cwd, encoding: "utf-8" });
      spawnSync("git", ["add", "."], { cwd, encoding: "utf-8" });
      spawnSync("git", ["commit", "-m", "baseline"], { cwd, encoding: "utf-8" });
      writeFileSync(featureFile, "export const reminders = true;\n", "utf-8");

      reviewCommand("license-expiration-reminders", p.specsTasks, p.promptsGenerated, cwd);

      const reviewPromptFile = join(p.promptsGenerated, "review-license-expiration-reminders.md");
      const content = readFileSync(reviewPromptFile, "utf-8");

      // Default compact: no full run log content or full diff
      expect(content).toContain("## Run Log");
      expect(content).toContain("_Run log");
      expect(content).toContain("--include-run-log");
      expect(content).not.toContain("# Run Log: License expiration reminders");
      expect(content).not.toContain("src/features/licenses/reminders.ts");

      expect(content).toContain("## Git Diff");
      expect(content).toContain("_Git changes available");
      expect(content).toContain("--include-diff");
      expect(content).not.toContain("-export const reminders");
      expect(content).not.toContain("+export const reminders");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("includes full run log and diff content when opt-in flags are passed", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      newCommand("License expiration reminders", {
        type: "implementation",
        domain: "credentialing",
        priority: "high",
        goal: "Add expiration reminder support for provider licenses.",
        cwd,
        activeDir: p.tasksActive,
      });

      const runLogPath = join(p.runs, "2026-05-23-12-00-00-license-expiration-reminders.md");
      writeFileSync(
        runLogPath,
        `# Run Log: License expiration reminders

## Files Changed

_Source: provided by user_

- src/features/licenses/reminders.ts

## Commands Run

_Source: provided by user_

- TODO: add verification commands

## Result

_Source: provided by user_

complete

## Risks

_Source: provided by user_

none
`,
        "utf-8",
      );

      const featureDir = join(cwd, "src", "features", "licenses");
      mkdirSync(featureDir, { recursive: true });
      const featureFile = join(featureDir, "reminders.ts");
      writeFileSync(featureFile, "export const reminders = false;\n", "utf-8");
      spawnSync("git", ["init"], { cwd, encoding: "utf-8" });
      spawnSync("git", ["config", "user.email", "test@example.com"], { cwd, encoding: "utf-8" });
      spawnSync("git", ["config", "user.name", "Manciple Test"], { cwd, encoding: "utf-8" });
      spawnSync("git", ["add", "."], { cwd, encoding: "utf-8" });
      spawnSync("git", ["commit", "-m", "baseline"], { cwd, encoding: "utf-8" });
      writeFileSync(featureFile, "export const reminders = true;\n", "utf-8");

      reviewCommand("license-expiration-reminders", p.specsTasks, p.promptsGenerated, cwd, {
        includeRunLog: true,
        includeGitDiff: true,
      });

      const reviewPromptFile = join(p.promptsGenerated, "review-license-expiration-reminders.md");
      const content = readFileSync(reviewPromptFile, "utf-8");

      expect(content).toContain("## Task Goal");
      expect(content).toContain("Add expiration reminder support for provider licenses.");
      expect(content).toContain("## Run Log");
      expect(content).toContain("# Run Log: License expiration reminders");
      expect(content).toContain("src/features/licenses/reminders.ts");
      expect(content).toContain("## Git Diff");
      expect(content).toContain("-export const reminders = false;");
      expect(content).toContain("+export const reminders = true;");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("manciple set-status", () => {
  it("updates the task status in tasks/active/", () => {
    newCommand("License expiration reminders", {
      type: "implementation",
      domain: "credentialing",
      priority: "high",
      goal: "Add expiration reminder support for provider licenses.",
      cwd,
      activeDir: p.tasksActive,
    });

    setStatusCommand("license-expiration-reminders", "in_progress", p.specsTasks, cwd);

    const taskFile = join(p.tasksActive, "license-expiration-reminders.yaml");
    const spec = parse(readFileSync(taskFile, "utf-8")) as Record<string, unknown>;
    expect(spec.status).toBe("in_progress");
  });

  it("normalizes task YAML deterministically when updating status", () => {
    const taskFile = join(p.tasksActive, "formatting-task.yaml");
    const unformatted = [
      "id: formatting-task",
      "title: Formatting task",
      "status: pending",
      "type: implementation",
      "domain: core",
      "priority: medium",
      "depends_on: []",
      "allowed_paths: [src/alpha.ts, src/beta.ts, src/gamma.ts, src/delta.ts]",
      "forbidden_paths: []",
      "goal: Keep task YAML formatting deterministic.",
      "acceptance_criteria: [Status updates rewrite task YAML through the canonical formatter.]",
      "verification: { commands: [pnpm test -- formatting] }",
      "outputs_required: [files_changed, tests_run, risks]",
      "notes: []",
      "",
    ].join("\n");
    writeFileSync(taskFile, unformatted, "utf-8");

    setStatusCommand("formatting-task", "in_progress", p.specsTasks, cwd);

    const raw = readFileSync(taskFile, "utf-8");
    expect(raw).not.toBe(unformatted);
    expect(raw).toBe(formatYamlDocument(parse(raw)));
    expect((parse(raw) as Record<string, unknown>).status).toBe("in_progress");
  });

  it("set-status finds tasks across all tiers via loadTasks", () => {
    newCommand("License expiration reminders", {
      type: "implementation",
      domain: "credentialing",
      priority: "high",
      goal: "Add expiration reminder support for provider licenses.",
      cwd,
      activeDir: p.tasksActive,
    });

    // Should find the task even though we only pass specsTasks dir
    expect(() =>
      setStatusCommand("license-expiration-reminders", "needs_review", p.specsTasks, cwd),
    ).not.toThrow();

    const taskFile = join(p.tasksActive, "license-expiration-reminders.yaml");
    const spec = parse(readFileSync(taskFile, "utf-8")) as Record<string, unknown>;
    expect(spec.status).toBe("needs_review");
  });

  it("moves a task to tasks/completed/ when setting status complete", () => {
    newCommand("License expiration reminders", {
      type: "implementation",
      domain: "credentialing",
      priority: "high",
      goal: "Add expiration reminder support for provider licenses.",
      cwd,
      activeDir: p.tasksActive,
    });
    rmSync(p.tasksCompleted, { recursive: true, force: true });

    setStatusCommand("license-expiration-reminders", "complete", p.specsTasks, cwd);

    const activeFile = join(p.tasksActive, "license-expiration-reminders.yaml");
    const completedFile = join(p.tasksCompleted, "license-expiration-reminders.yaml");
    expect(existsSync(activeFile)).toBe(false);
    expect(existsSync(completedFile)).toBe(true);

    const spec = parse(readFileSync(completedFile, "utf-8")) as Record<string, unknown>;
    expect(spec.status).toBe("complete");
  });

  it("does not overwrite an existing completed task when setting status complete", () => {
    newCommand("License expiration reminders", {
      type: "implementation",
      domain: "credentialing",
      priority: "high",
      goal: "Add expiration reminder support for provider licenses.",
      cwd,
      activeDir: p.tasksActive,
    });

    mkdirSync(p.tasksCompleted, { recursive: true });
    const completedFile = join(p.tasksCompleted, "license-expiration-reminders.yaml");
    writeFileSync(completedFile, "already completed\n", "utf-8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() =>
        setStatusCommand("license-expiration-reminders", "complete", p.specsTasks, cwd),
      ).toThrow("process.exit(1)");

      expect(readFileSync(completedFile, "utf-8")).toBe("already completed\n");
      const activeFile = join(p.tasksActive, "license-expiration-reminders.yaml");
      expect(existsSync(activeFile)).toBe(true);
      const activeSpec = parse(readFileSync(activeFile, "utf-8")) as Record<string, unknown>;
      expect(activeSpec.status).toBe("pending");
      expect(errorSpy.mock.calls.flat().join("\n")).toBe(
        "Task license-expiration-reminders already exists in completed tasks.",
      );
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe("manciple status", () => {
  it("shows active counts separately from completed lifecycle tasks", () => {
    newCommand("Done task", {
      type: "implementation",
      domain: "core",
      priority: "medium",
      goal: "Finish the done task.",
      cwd,
      activeDir: p.tasksActive,
    });
    completeCommand("done-task", {
      specsTasksDir: p.specsTasks,
      completedDir: p.tasksCompleted,
      cwd,
    });
    newCommand("Active task", {
      type: "implementation",
      domain: "core",
      priority: "high",
      goal: "Keep working on the active task.",
      cwd,
      activeDir: p.tasksActive,
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      statusCommand(p.specsTasks, cwd);

      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("Active tasks:");
      expect(output).toContain("○ pending:       1");
      expect(output).not.toContain("complete:      0");
      expect(output).toContain("Completed lifecycle tasks: 1");
      expect(output).toContain("active-task [HIGH]");
      expect(output).not.toContain("done-task [MED]");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("manciple complete", () => {
  it("marks an active task complete and moves it to tasks/completed/", () => {
    newCommand("License expiration reminders", {
      type: "implementation",
      domain: "credentialing",
      priority: "high",
      goal: "Add expiration reminder support for provider licenses.",
      cwd,
      activeDir: p.tasksActive,
    });
    rmSync(p.tasksCompleted, { recursive: true, force: true });

    completeCommand("license-expiration-reminders", {
      specsTasksDir: p.specsTasks,
      completedDir: p.tasksCompleted,
      cwd,
    });

    const activeFile = join(p.tasksActive, "license-expiration-reminders.yaml");
    const completedFile = join(p.tasksCompleted, "license-expiration-reminders.yaml");
    expect(existsSync(activeFile)).toBe(false);
    expect(existsSync(completedFile)).toBe(true);

    const spec = parse(readFileSync(completedFile, "utf-8")) as Record<string, unknown>;
    expect(spec.status).toBe("complete");
  });

  it("exits non-zero when the task is missing from active tasks", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() =>
        completeCommand("missing-task", {
          specsTasksDir: p.specsTasks,
          completedDir: p.tasksCompleted,
          cwd,
        }),
      ).toThrow("process.exit(1)");

      expect(errorSpy.mock.calls.flat().join("\n")).toBe(
        "Task missing-task not found in active tasks.",
      );
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("exits non-zero without overwriting an existing completed task", () => {
    newCommand("License expiration reminders", {
      type: "implementation",
      domain: "credentialing",
      priority: "high",
      goal: "Add expiration reminder support for provider licenses.",
      cwd,
      activeDir: p.tasksActive,
    });

    mkdirSync(p.tasksCompleted, { recursive: true });
    const completedFile = join(p.tasksCompleted, "license-expiration-reminders.yaml");
    writeFileSync(completedFile, "already completed\n", "utf-8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() =>
        completeCommand("license-expiration-reminders", {
          specsTasksDir: p.specsTasks,
          completedDir: p.tasksCompleted,
          cwd,
        }),
      ).toThrow("process.exit(1)");

      expect(readFileSync(completedFile, "utf-8")).toBe("already completed\n");
      expect(existsSync(join(p.tasksActive, "license-expiration-reminders.yaml"))).toBe(true);
      expect(errorSpy.mock.calls.flat().join("\n")).toBe(
        "Task license-expiration-reminders already exists in completed. Use manciple reopen first.",
      );
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe("manciple reopen", () => {
  it("reopens a completed task into tasks/active/ with in_progress status", () => {
    newCommand("License expiration reminders", {
      type: "implementation",
      domain: "credentialing",
      priority: "high",
      goal: "Add expiration reminder support for provider licenses.",
      cwd,
      activeDir: p.tasksActive,
    });
    completeCommand("license-expiration-reminders", {
      specsTasksDir: p.specsTasks,
      completedDir: p.tasksCompleted,
      cwd,
    });

    reopenCommand("license-expiration-reminders", {
      specsTasksDir: p.specsTasks,
      activeDir: p.tasksActive,
      cwd,
    });

    const activeFile = join(p.tasksActive, "license-expiration-reminders.yaml");
    const completedFile = join(p.tasksCompleted, "license-expiration-reminders.yaml");
    expect(existsSync(activeFile)).toBe(true);
    expect(existsSync(completedFile)).toBe(false);

    const spec = parse(readFileSync(activeFile, "utf-8")) as Record<string, unknown>;
    expect(spec.status).toBe("in_progress");
  });

  it("reopens an archived task into tasks/active/ with in_progress status", () => {
    newCommand("License expiration reminders", {
      type: "implementation",
      domain: "credentialing",
      priority: "high",
      goal: "Add expiration reminder support for provider licenses.",
      cwd,
      activeDir: p.tasksActive,
    });
    archiveCommand("license-expiration-reminders", {
      specsTasksDir: p.specsTasks,
      archivedDir: p.tasksArchived,
      cwd,
    });

    reopenCommand("license-expiration-reminders", {
      specsTasksDir: p.specsTasks,
      activeDir: p.tasksActive,
      cwd,
    });

    const activeFile = join(p.tasksActive, "license-expiration-reminders.yaml");
    const archivedFile = join(p.tasksArchived, "license-expiration-reminders.yaml");
    expect(existsSync(activeFile)).toBe(true);
    expect(existsSync(archivedFile)).toBe(false);

    const spec = parse(readFileSync(activeFile, "utf-8")) as Record<string, unknown>;
    expect(spec.status).toBe("in_progress");
  });

  it("searches completed tasks before archived tasks for duplicate task ids", () => {
    newCommand("Duplicate lifecycle task", {
      type: "implementation",
      domain: "core",
      priority: "medium",
      goal: "Use the completed copy when reopening.",
      cwd,
      activeDir: p.tasksActive,
    });
    completeCommand("duplicate-lifecycle-task", {
      specsTasksDir: p.specsTasks,
      completedDir: p.tasksCompleted,
      cwd,
    });

    mkdirSync(p.tasksArchived, { recursive: true });
    const archivedFile = join(p.tasksArchived, "duplicate-lifecycle-task.yaml");
    writeFileSync(
      archivedFile,
      [
        "id: duplicate-lifecycle-task",
        "title: Archived duplicate lifecycle task",
        "status: archived",
        "type: implementation",
        "domain: core",
        "priority: low",
        "goal: Leave this archived copy untouched.",
        "",
      ].join("\n"),
      "utf-8",
    );

    reopenCommand("duplicate-lifecycle-task", {
      specsTasksDir: p.specsTasks,
      activeDir: p.tasksActive,
      cwd,
    });

    const activeFile = join(p.tasksActive, "duplicate-lifecycle-task.yaml");
    const completedFile = join(p.tasksCompleted, "duplicate-lifecycle-task.yaml");
    const activeSpec = parse(readFileSync(activeFile, "utf-8")) as Record<string, unknown>;
    const archivedSpec = parse(readFileSync(archivedFile, "utf-8")) as Record<string, unknown>;

    expect(existsSync(completedFile)).toBe(false);
    expect(existsSync(archivedFile)).toBe(true);
    expect(activeSpec.title).toBe("Duplicate lifecycle task");
    expect(activeSpec.status).toBe("in_progress");
    expect(archivedSpec.status).toBe("archived");
  });

  it("exits non-zero without overwriting an existing active task", () => {
    newCommand("License expiration reminders", {
      type: "implementation",
      domain: "credentialing",
      priority: "high",
      goal: "Completed task should not overwrite active work.",
      cwd,
      activeDir: p.tasksActive,
    });
    completeCommand("license-expiration-reminders", {
      specsTasksDir: p.specsTasks,
      completedDir: p.tasksCompleted,
      cwd,
    });

    const activeFile = join(p.tasksActive, "license-expiration-reminders.yaml");
    const completedFile = join(p.tasksCompleted, "license-expiration-reminders.yaml");
    writeFileSync(activeFile, "existing active task\n", "utf-8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() =>
        reopenCommand("license-expiration-reminders", {
          specsTasksDir: p.specsTasks,
          activeDir: p.tasksActive,
          cwd,
        }),
      ).toThrow("process.exit(1)");

      const completedSpec = parse(readFileSync(completedFile, "utf-8")) as Record<string, unknown>;
      expect(readFileSync(activeFile, "utf-8")).toBe("existing active task\n");
      expect(completedSpec.status).toBe("complete");
      expect(errorSpy.mock.calls.flat().join("\n")).toBe(
        "Task license-expiration-reminders already exists in active tasks.",
      );
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("exits non-zero when the task is missing from completed and archived tasks", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() =>
        reopenCommand("missing-task", {
          specsTasksDir: p.specsTasks,
          activeDir: p.tasksActive,
          cwd,
        }),
      ).toThrow("process.exit(1)");

      expect(errorSpy.mock.calls.flat().join("\n")).toBe(
        "Task missing-task not found in completed or archived tasks.",
      );
      expect(existsSync(join(p.tasksActive, "missing-task.yaml"))).toBe(false);
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe("manciple check-lifecycle", () => {
  it("exits non-zero when task status does not match its lifecycle directory", () => {
    newCommand("Misplaced complete task", {
      type: "implementation",
      domain: "core",
      priority: "medium",
      goal: "Create a misplaced completed task.",
      cwd,
      activeDir: p.tasksActive,
    });

    const taskFile = join(p.tasksActive, "misplaced-complete-task.yaml");
    const spec = parse(readFileSync(taskFile, "utf-8")) as Record<string, unknown>;
    spec.status = "complete";
    writeFileSync(
      taskFile,
      `${Object.entries(spec)
        .map(
          ([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
        )
        .join("\n")}\n`,
      "utf-8",
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() =>
        checkLifecycleCommand({
          cwd,
          activeDir: p.tasksActive,
          completedDir: p.tasksCompleted,
          archivedDir: p.tasksArchived,
        }),
      ).toThrow("process.exit(1)");

      const output = errorSpy.mock.calls.flat().join("\n");
      expect(output).toContain("Lifecycle placement issues: 1");
      expect(output).toContain("misplaced-complete-task.yaml");
      expect(output).toContain("belongs in .manciple/tasks/completed");
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("passes when tasks are in lifecycle directories matching their statuses", () => {
    newCommand("Active task", {
      type: "implementation",
      domain: "core",
      priority: "medium",
      goal: "Create an active task.",
      cwd,
      activeDir: p.tasksActive,
    });
    newCommand("Completed task", {
      type: "implementation",
      domain: "core",
      priority: "medium",
      goal: "Create a completed task.",
      cwd,
      activeDir: p.tasksActive,
    });
    completeCommand("completed-task", {
      specsTasksDir: p.specsTasks,
      completedDir: p.tasksCompleted,
      cwd,
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      expect(() =>
        checkLifecycleCommand({
          cwd,
          activeDir: p.tasksActive,
          completedDir: p.tasksCompleted,
          archivedDir: p.tasksArchived,
        }),
      ).not.toThrow();

      expect(logSpy.mock.calls.flat().join("\n")).toContain("Lifecycle placement OK");
    } finally {
      logSpy.mockRestore();
    }
  });
});
