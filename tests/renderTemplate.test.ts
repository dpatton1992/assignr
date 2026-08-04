import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTaskPacket } from "../src/commands/taskPacket.js";
import type { TaskSpec } from "../src/specs/schema.js";
import {
  IMPLEMENTATION_TEMPLATE,
  REVIEW_TEMPLATE,
  renderTemplate,
} from "../src/templates/renderTemplate.js";

const spec: TaskSpec = {
  id: "license-expiration-reminders",
  title: "License expiration reminders",
  status: "pending",
  type: "implementation",
  domain: "credentialing",
  priority: "high",
  depends_on: ["license-data-model"],
  blocks: [],
  conflicts_with: [],
  can_run_independently: true,
  path_ownership: {
    touched_paths: [],
    locked_paths: [],
    unsafe_parallel_areas: [],
  },
  allowed_paths: ["src/features/licenses/**"],
  forbidden_paths: ["src/auth/**"],
  goal: "Add expiration reminder support for provider licenses.",
  acceptance_criteria: [
    "Users can set an expiration date.",
    "Expiring licenses appear in dashboard.",
  ],
  implementation_notes: ["Preserve existing dashboard ordering."],
  verification: {
    commands: ["pnpm typecheck", "pnpm test -- licenses"],
  },
  outputs_required: ["files_changed", "tests_run"],
  notes: ["Keep implementation narrow."],
};

describe("renderTemplate", () => {
  it("replaces title placeholder", () => {
    const out = renderTemplate(IMPLEMENTATION_TEMPLATE, spec);
    expect(out).toContain("License expiration reminders");
  });

  it("replaces id placeholder", () => {
    const out = renderTemplate(IMPLEMENTATION_TEMPLATE, spec);
    expect(out).toContain("license-expiration-reminders");
  });

  it("replaces goal placeholder", () => {
    const out = renderTemplate(IMPLEMENTATION_TEMPLATE, spec);
    expect(out).toContain("Add expiration reminder support for provider licenses.");
  });

  it("replaces acceptance_criteria placeholder", () => {
    const out = renderTemplate(IMPLEMENTATION_TEMPLATE, spec);
    expect(out).toContain("Users can set an expiration date.");
    expect(out).toContain("Expiring licenses appear in dashboard.");
  });

  it("renders verification commands as code blocks", () => {
    const out = renderTemplate(IMPLEMENTATION_TEMPLATE, spec);
    expect(out).toContain("```bash");
    expect(out).toContain("pnpm typecheck");
  });

  it("renders implementation notes separately from free-form notes", () => {
    const out = renderTemplate(IMPLEMENTATION_TEMPLATE, spec);
    expect(out).toContain("## Implementation Notes\n\n- Preserve existing dashboard ordering.");
    expect(out).toContain("## Notes\n\n- Keep implementation narrow.");
  });

  it("renders review guidance for runner-made design decisions", () => {
    const out = renderTemplate(REVIEW_TEMPLATE, spec);
    expect(out).toContain("Product/design decisions");
    expect(out).toContain("implementation notes");
  });

  it("renders allowed and forbidden paths", () => {
    const out = renderTemplate(IMPLEMENTATION_TEMPLATE, spec);
    expect(out).toContain("src/features/licenses/**");
    expect(out).toContain("src/auth/**");
  });

  it("renders depends_on", () => {
    const out = renderTemplate(IMPLEMENTATION_TEMPLATE, spec);
    expect(out).toContain("license-data-model");
  });

  it("is deterministic across multiple calls", () => {
    const a = renderTemplate(IMPLEMENTATION_TEMPLATE, spec);
    const b = renderTemplate(IMPLEMENTATION_TEMPLATE, spec);
    expect(a).toBe(b);
  });

  it("renders review template with correct heading", () => {
    const out = renderTemplate(REVIEW_TEMPLATE, spec);
    expect(out).toContain("# Review Task:");
    expect(out).toContain("License expiration reminders");
  });

  it("renders 'None specified.' for empty optional arrays", () => {
    const minSpec: TaskSpec = {
      ...spec,
      depends_on: [],
      notes: [],
      outputs_required: [],
    };
    const out = renderTemplate(IMPLEMENTATION_TEMPLATE, minSpec);
    expect(out).toContain("_None specified._");
  });

  it("builds a compact task packet without rendered prompt prose", async () => {
    const root = await mkdtemp(join(tmpdir(), "manciple-task-packet-"));
    try {
      const tasksDir = join(root, ".manciple", "tasks", "active");
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(
        join(tasksDir, "packet-task.yaml"),
        [
          "id: packet-task",
          "title: Packet task",
          "status: pending",
          "type: implementation",
          "domain: core",
          "priority: high",
          "depends_on:",
          "  - setup-task",
          "goal: Keep packet compact.",
          "acceptance_criteria:",
          "  - It returns compact fields.",
          "implementation_notes:",
          "  - Preserve MCP packet shape.",
          "allowed_paths:",
          "  - src/mcp.ts",
          "forbidden_paths:",
          "  - README.md",
          "path_ownership:",
          "  touched_paths:",
          "    - src/mcp.ts",
          "verification:",
          "  commands:",
          "    - pnpm typecheck",
          "outputs_required:",
          "  - files_changed",
          "notes:",
          "  - Skip full prompt prose.",
          "",
        ].join("\n"),
        "utf-8",
      );

      const packet = buildTaskPacket({
        taskId: "packet-task",
        specsTasksDir: join(root, ".manciple", "tasks"),
        cwd: root,
      });

      expect(packet).toEqual({
        task_id: "packet-task",
        title: "Packet task",
        status: "pending",
        type: "implementation",
        domain: "core",
        priority: "high",
        depends_on: ["setup-task"],
        allowed_paths: ["src/mcp.ts"],
        forbidden_paths: ["README.md"],
        path_ownership: {
          touched_paths: ["src/mcp.ts"],
          locked_paths: [],
          unsafe_parallel_areas: [],
        },
        acceptance_criteria: ["It returns compact fields."],
        implementation_notes: ["Preserve MCP packet shape."],
        verification_commands: ["pnpm typecheck"],
        outputs_required: ["files_changed"],
        notes: ["Skip full prompt prose."],
        path_ownership_warnings: [],
      });
      expect(JSON.stringify(packet)).not.toContain("Domain Context");
      expect(JSON.stringify(packet)).not.toContain("# Agent Task");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
