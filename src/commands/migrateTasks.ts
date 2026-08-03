import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { parse } from "yaml";

export interface MigrateTasksCommandOptions {
  specsTasksDir: string;
  activeDir: string;
  completedDir: string;
  archivedDir: string;
  cwd: string;
}

type DestinationTier = "active" | "completed" | "archived";

interface MigrationPlanItem {
  fileName: string;
  source: string;
  destination: string;
  tier: DestinationTier;
}

const ACTIVE_STATUSES = new Set([
  "pending",
  "in_progress",
  "needs_review",
  "partial",
  "blocked",
  "failed",
]);

function isTaskYamlFile(fileName: string): boolean {
  return fileName.endsWith(".yaml") || fileName.endsWith(".yml");
}

function relativePath(cwd: string, filePath: string): string {
  return filePath.startsWith(`${cwd}/`) ? filePath.slice(cwd.length + 1) : filePath;
}

function getStatus(filePath: string): string | undefined {
  const raw = readFileSync(filePath, "utf-8");

  try {
    const parsed = parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "status" in parsed) {
      const status = (parsed as { status?: unknown }).status;
      return typeof status === "string" ? status : undefined;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function getTierForStatus(status: string | undefined): DestinationTier {
  if (status === "complete") return "completed";
  if (status === "archived") return "archived";
  if (!status || ACTIVE_STATUSES.has(status)) return "active";
  return "active";
}

function getDestinationDir(tier: DestinationTier, options: MigrateTasksCommandOptions): string {
  if (tier === "completed") return options.completedDir;
  if (tier === "archived") return options.archivedDir;
  return options.activeDir;
}

function createPlan(options: MigrateTasksCommandOptions): MigrationPlanItem[] {
  const files = readdirSync(options.specsTasksDir)
    .filter(isTaskYamlFile)
    .sort((a, b) => a.localeCompare(b));

  return files.map((fileName) => {
    const source = join(options.specsTasksDir, fileName);
    const tier = getTierForStatus(getStatus(source));
    const destination = join(getDestinationDir(tier, options), basename(fileName));

    return { fileName, source, destination, tier };
  });
}

async function confirmMigration(): Promise<boolean> {
  const rl = createInterface({ input, output });

  try {
    const answer = await rl.question("Proceed? [y/N] ");
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

export async function migrateTasksCommand(options: MigrateTasksCommandOptions): Promise<void> {
  if (!existsSync(options.specsTasksDir)) {
    console.log("Nothing to migrate.");
    return;
  }

  const plan = createPlan(options);
  if (plan.length === 0) {
    console.log("Nothing to migrate.");
    return;
  }

  console.log("Dry-run preview:");
  for (const item of plan) {
    console.log(
      `  ${relativePath(options.cwd, item.source)} -> ${relativePath(options.cwd, item.destination)}`,
    );
  }

  const confirmed = await confirmMigration();
  if (!confirmed) {
    console.log("Migration cancelled.");
    return;
  }

  mkdirSync(options.activeDir, { recursive: true });
  mkdirSync(options.completedDir, { recursive: true });
  mkdirSync(options.archivedDir, { recursive: true });

  let migrated = 0;
  let skipped = 0;

  for (const item of plan) {
    try {
      copyFileSync(item.source, item.destination, constants.COPYFILE_EXCL);
      migrated += 1;
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
        skipped += 1;
        console.warn(
          `Warning: ${relativePath(options.cwd, item.destination)} already exists; skipping ${item.fileName}.`,
        );
        continue;
      }

      throw err;
    }
  }

  const remaining = readdirSync(options.specsTasksDir).filter(isTaskYamlFile).length;
  console.log(
    `Migrated ${migrated} tasks. Skipped ${skipped}. specs/tasks still contains ${remaining} files.`,
  );
}
