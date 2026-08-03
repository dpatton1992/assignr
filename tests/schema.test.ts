import { describe, expect, it } from "vitest";
import { TaskSpecSchema } from "../src/specs/schema.js";

const baseSpec = {
  id: "test-task",
  title: "Test Task",
  status: "pending" as const,
  type: "implementation" as const,
  domain: "core",
  goal: "Do something useful.",
  acceptance_criteria: ["It works."],
  verification: {
    commands: ["pnpm test"],
  },
};

describe("TaskSpecSchema", () => {
  it("accepts a valid minimal spec", () => {
    const result = TaskSpecSchema.safeParse(baseSpec);
    expect(result.success).toBe(true);
  });

  it("rejects missing id", () => {
    const result = TaskSpecSchema.safeParse({ ...baseSpec, id: undefined });
    expect(result.success).toBe(false);
  });

  it("rejects id with spaces", () => {
    const result = TaskSpecSchema.safeParse({ ...baseSpec, id: "has spaces" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown status", () => {
    const result = TaskSpecSchema.safeParse({ ...baseSpec, status: "cancelled" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown type", () => {
    const result = TaskSpecSchema.safeParse({ ...baseSpec, type: "magic" });
    expect(result.success).toBe(false);
  });

  it("rejects empty acceptance_criteria", () => {
    const result = TaskSpecSchema.safeParse({ ...baseSpec, acceptance_criteria: [] });
    expect(result.success).toBe(false);
  });

  it("rejects empty verification.commands", () => {
    const result = TaskSpecSchema.safeParse({
      ...baseSpec,
      verification: { commands: [] },
    });
    expect(result.success).toBe(false);
  });

  it("defaults priority to medium when absent", () => {
    const result = TaskSpecSchema.safeParse(baseSpec);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.priority).toBe("medium");
    }
  });

  it("defaults implementation_notes to an empty array when absent", () => {
    const result = TaskSpecSchema.safeParse(baseSpec);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.implementation_notes).toEqual([]);
    }
  });

  it("accepts implementation_notes as task design constraints", () => {
    const result = TaskSpecSchema.safeParse({
      ...baseSpec,
      implementation_notes: ["Preserve CLI and MCP parity."],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.implementation_notes).toEqual(["Preserve CLI and MCP parity."]);
    }
  });

  it("accepts all valid statuses", () => {
    const statuses = [
      "pending",
      "in_progress",
      "needs_review",
      "complete",
      "blocked",
      "failed",
      "partial",
      "archived",
    ] as const;
    for (const status of statuses) {
      const result = TaskSpecSchema.safeParse({ ...baseSpec, status });
      expect(result.success, `status "${status}" should be valid`).toBe(true);
    }
  });

  it("accepts all valid task types", () => {
    const types = [
      "planning",
      "implementation",
      "review",
      "test",
      "refactor",
      "docs",
      "research",
      "hardening",
    ] as const;
    for (const type of types) {
      const result = TaskSpecSchema.safeParse({ ...baseSpec, type });
      expect(result.success, `type "${type}" should be valid`).toBe(true);
    }
  });
});
