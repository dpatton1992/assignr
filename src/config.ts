import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { DEFAULT_ROOT } from "./constants.js";

export interface MancipleConfig {
  root: string;
  worktrees: {
    enabled: boolean;
  };
}

export function loadConfig(cwd: string = process.cwd()): MancipleConfig {
  const configPath = join(cwd, DEFAULT_ROOT, "config.yaml");
  if (!existsSync(configPath)) {
    return { root: DEFAULT_ROOT, worktrees: { enabled: true } };
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as {
    root?: unknown;
    worktrees?: { enabled?: unknown };
  } | null;
  if (
    parsed?.worktrees !== undefined &&
    (parsed.worktrees === null ||
      typeof parsed.worktrees !== "object" ||
      Array.isArray(parsed.worktrees))
  ) {
    throw new Error("Invalid Manciple config: worktrees must be a mapping.");
  }
  const configuredEnabled = parsed?.worktrees?.enabled;
  if (configuredEnabled !== undefined && typeof configuredEnabled !== "boolean") {
    throw new Error("Invalid Manciple config: worktrees.enabled must be true or false.");
  }
  return {
    root: typeof parsed?.root === "string" ? parsed.root : DEFAULT_ROOT,
    worktrees: { enabled: configuredEnabled ?? true },
  };
}
