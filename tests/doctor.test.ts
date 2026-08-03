import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { doctorCommand } from "../src/commands/doctor.js";
import { initCommand } from "../src/commands/init.js";
import { newCommand } from "../src/commands/new.js";
import { getPaths } from "../src/utils/paths.js";

let cwd: string;
let p: ReturnType<typeof getPaths>;

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-doctor-"));
  p = getPaths(cwd, ".manciple");
  await initCommand({ force: false, cwd, root: ".manciple" });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("manciple doctor", () => {
  it("prints a healthy project report and exits zero", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")) as {
      version: string;
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      newCommand("Doctor count check", {
        type: "implementation",
        domain: "core",
        priority: "high",
        cwd,
        activeDir: p.tasksActive,
      });

      expect(() => doctorCommand(cwd, ".manciple")).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();

      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain(`Project root: ${cwd}`);
      expect(output).toContain(`Root: ${p.root}`);
      expect(output).toContain(`Package version: ${packageJson.version}`);
      expect(output).toContain("Active tasks: 1");
      expect(output).toContain("✓ config.yaml readable");
      expect(output).toContain("✓ tasks/active/ exists");
      expect(output).toContain("✓ tasks/completed/ exists");
      expect(output).toContain("✓ tasks/archived/ exists");
      expect(output).toContain("All checks passed.");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("fails clearly when config or task directories are missing", () => {
    rmSync(p.config, { force: true });
    rmSync(p.tasksCompleted, { recursive: true, force: true });

    expect(existsSync(p.config)).toBe(false);
    expect(existsSync(p.tasksCompleted)).toBe(false);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      expect(() => doctorCommand(cwd, ".manciple")).toThrow("process.exit(1)");
      expect(exitSpy).toHaveBeenCalledWith(1);

      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("✕ config.yaml readable");
      expect(output).toContain("✕ tasks/completed/ exists");
      expect(output).toContain('Some checks failed. Run "manciple init"');
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
