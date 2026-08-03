import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

export type LifecycleTier = "active" | "completed" | "archived";

export interface LifecyclePlacementIssue {
  file: string;
  tier: LifecycleTier;
  status: string;
  expected_dir: string;
  message: string;
}

export interface LifecyclePlacementResult {
  ok: boolean;
  checked_count: number;
  issue_count: number;
  issues: LifecyclePlacementIssue[];
}

export interface LifecyclePlacementOptions {
  cwd: string;
  activeDir: string;
  completedDir: string;
  archivedDir: string;
}

const ACTIVE_STATUSES = new Set([
  "pending",
  "in_progress",
  "needs_review",
  "blocked",
  "failed",
  "partial",
]);

function isYamlFile(file: string): boolean {
  return file.endsWith(".yaml") || file.endsWith(".yml");
}

function expectedDirectory(status: string, options: LifecyclePlacementOptions): string {
  if (status === "complete") return options.completedDir;
  if (status === "archived") return options.archivedDir;
  if (ACTIVE_STATUSES.has(status)) return options.activeDir;
  return "<unknown>";
}

function isCorrectPlacement(tier: LifecycleTier, status: string): boolean {
  if (tier === "active") return ACTIVE_STATUSES.has(status);
  if (tier === "completed") return status === "complete";
  return status === "archived";
}

function readStatus(file: string): string {
  const raw = readFileSync(file, "utf-8");
  const parsed = parse(raw) as { status?: unknown };
  return typeof parsed?.status === "string" ? parsed.status : "<missing>";
}

function displayPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

export function checkLifecyclePlacement(
  options: LifecyclePlacementOptions,
): LifecyclePlacementResult {
  const tiers: Array<{ tier: LifecycleTier; dir: string }> = [
    { tier: "active", dir: options.activeDir },
    { tier: "completed", dir: options.completedDir },
    { tier: "archived", dir: options.archivedDir },
  ];
  const issues: LifecyclePlacementIssue[] = [];
  let checkedCount = 0;

  for (const { tier, dir } of tiers) {
    if (!existsSync(dir)) {
      continue;
    }

    for (const fileName of readdirSync(dir).filter(isYamlFile).sort()) {
      const file = join(dir, fileName);
      checkedCount += 1;

      try {
        const status = readStatus(file);
        if (isCorrectPlacement(tier, status)) {
          continue;
        }

        const expected = expectedDirectory(status, options);
        const expectedDisplay =
          expected === "<unknown>" ? expected : displayPath(options.cwd, expected);
        issues.push({
          file: displayPath(options.cwd, file),
          tier,
          status,
          expected_dir: expectedDisplay,
          message:
            expected === "<unknown>"
              ? `Task has unknown status "${status}".`
              : `Task with status "${status}" belongs in ${expectedDisplay}.`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        issues.push({
          file: displayPath(options.cwd, file),
          tier,
          status: "<unreadable>",
          expected_dir: displayPath(options.cwd, dir),
          message: `Could not read task YAML: ${message}`,
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    checked_count: checkedCount,
    issue_count: issues.length,
    issues,
  };
}
