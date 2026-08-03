import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import { loadTasks } from "../specs/loadTasks.js";
import { formatYamlDocument } from "../utils/yamlFormat.js";
import { colorForStatus } from "../utils/styling.js";
import picocolors from "picocolors";
import { loadConfig } from "../config.js";
import { getPaths } from "../utils/paths.js";
import { assertDirectCompletionAllowed } from "../worktrees/manager.js";

export interface CompleteCommandOptions {
  specsTasksDir: string;
  completedDir: string;
  cwd: string;
}

function moveTaskFile(source: string, destination: string): void {
  try {
    renameSync(source, destination);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "EXDEV") {
      copyFileSync(source, destination);
      unlinkSync(source);
      return;
    }

    throw err;
  }
}

export function completeCommand(taskId: string, options: CompleteCommandOptions): void {
  const { specsTasksDir, completedDir, cwd } = options;
  try {
    const config = loadConfig(cwd);
    const paths = getPaths(cwd, config.root);
    assertDirectCompletionAllowed(taskId, {
      controlRepo: cwd,
      worktreesDir: paths.worktrees,
      specsTasksDir,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const { tasks } = loadTasks(specsTasksDir, "active");
  const found = tasks.find((t) => t.spec.id === taskId);

  if (!found) {
    console.error(`Task ${taskId} not found in active tasks.`);
    process.exit(1);
  }

  const destination = join(completedDir, `${taskId}.yaml`);
  if (existsSync(destination)) {
    console.error(`Task ${taskId} already exists in completed. Use manciple reopen first.`);
    process.exit(1);
  }

  const raw = readFileSync(found.filePath, "utf-8");
  const parsed = parse(raw) as Record<string, unknown>;
  parsed["status"] = "complete";

  mkdirSync(completedDir, { recursive: true });
  writeFileSync(found.filePath, formatYamlDocument(parsed), "utf-8");
  moveTaskFile(found.filePath, destination);

  console.log(`${picocolors.green("Completed:")} ${taskId} ${picocolors.yellow("→")} ${colorForStatus("complete")(destination.replace(cwd + "/", ""))}`);
}
