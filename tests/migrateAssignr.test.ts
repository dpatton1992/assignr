import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrateAssignrCommand } from "../src/commands/migrateAssignr.js";

let cwd: string;

function writeFixture(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf-8");
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "manciple-migrate-assignr-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("migrateAssignrCommand", () => {
  it("reports no work when no Assignr artifacts exist", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let output = "";

    try {
      await migrateAssignrCommand({ cwd, yes: true });
      output = logSpy.mock.calls.flat().join("\n");
    } finally {
      logSpy.mockRestore();
    }

    expect(output).toContain("No Assignr artifacts found to migrate.");
  });

  it("previews without changing files in dry-run mode", async () => {
    writeFixture(join(cwd, ".assignr", "config.yaml"), "root: .assignr\n");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await migrateAssignrCommand({ cwd, dryRun: true });
    } finally {
      logSpy.mockRestore();
    }

    expect(existsSync(join(cwd, ".assignr"))).toBe(true);
    expect(existsSync(join(cwd, ".manciple"))).toBe(false);
  });

  it("renames Assignr artifacts and updates repo config when confirmed", async () => {
    writeFixture(join(cwd, ".assignr", "config.yaml"), "root: .assignr\n");
    writeFixture(join(cwd, ".assignr", "commands", "README.md"), "Run assignr --help\n");
    writeFixture(
      join(cwd, ".assignr", "tasks", "active", "demo.yaml"),
      "id: demo\nstatus: pending\n",
    );
    writeFixture(join(cwd, ".gitignore"), ".assignr/prompts/generated/\n.assignr/runs/\n");
    writeFixture(
      join(cwd, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            "assignr-promptops": {
              command: "node",
              args: [join(cwd, "bin", "assignr-mcp.js")],
            },
            assignr: {
              command: "npx",
              args: ["--yes", "--package", "@dpatt/assignr", "assignr-mcp"],
            },
          },
        },
        null,
        2,
      ),
    );
    writeFixture(
      join(cwd, ".claude", "skills", "assignr-review", "SKILL.md"),
      "Use Assignr with assignr_verify.\n",
    );
    writeFixture(join(cwd, ".opencode", "agents", "assignr-worker.md"), "assignr-worker\n");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await migrateAssignrCommand({ cwd, yes: true });
    } finally {
      logSpy.mockRestore();
    }

    expect(existsSync(join(cwd, ".assignr"))).toBe(false);
    expect(readFileSync(join(cwd, ".manciple", "config.yaml"), "utf-8")).toBe("root: .manciple\n");
    expect(readFileSync(join(cwd, ".manciple", "commands", "README.md"), "utf-8")).toContain(
      "manciple --help",
    );
    expect(existsSync(join(cwd, ".manciple", "tasks", "active", "demo.yaml"))).toBe(true);
    expect(readFileSync(join(cwd, ".gitignore"), "utf-8")).toContain(
      ".manciple/prompts/generated/",
    );

    const mcp = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf-8")) as {
      mcpServers: Record<string, { args?: string[] }>;
    };
    expect(mcp.mcpServers["manciple-promptops"]).toBeDefined();
    expect(mcp.mcpServers.manciple.args).toEqual([
      "--yes",
      "--package",
      "manciple",
      "manciple-mcp",
    ]);
    expect(mcp.mcpServers.assignr).toBeUndefined();

    expect(existsSync(join(cwd, ".claude", "skills", "manciple-review", "SKILL.md"))).toBe(true);
    expect(
      readFileSync(join(cwd, ".claude", "skills", "manciple-review", "SKILL.md"), "utf-8"),
    ).toContain("Manciple");
    expect(existsSync(join(cwd, ".opencode", "agents", "manciple-worker.md"))).toBe(true);
  });

  it("does not migrate when confirmation is declined", async () => {
    writeFixture(join(cwd, ".assignr", "config.yaml"), "root: .assignr\n");
    const confirm = vi.fn(() => false);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await migrateAssignrCommand({ cwd, confirm });
    } finally {
      logSpy.mockRestore();
    }

    expect(confirm).toHaveBeenCalledOnce();
    expect(existsSync(join(cwd, ".assignr"))).toBe(true);
    expect(existsSync(join(cwd, ".manciple"))).toBe(false);
  });
});
