import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { parse } from "yaml";
import { loadTasks } from "../specs/loadTasks.js";
import { formatYamlDocument } from "../utils/yamlFormat.js";

export interface FormatTaskResult {
  checked: boolean;
  changed: boolean;
  file: string;
  errors: string[];
}

export interface FormatTaskOptions {
  specsTasksDir: string;
  cwd: string;
  checkOnly?: boolean;
}

export function formatTaskById(taskId: string, options: FormatTaskOptions): FormatTaskResult {
  const { specsTasksDir, cwd, checkOnly = false } = options;
  const { tasks, errors } = loadTasks(specsTasksDir, "all");
  const found = tasks.find((task) => task.spec.id === taskId);

  if (!found) {
    const taskLoadErrors = errors
      .filter((error) => error.filePath.split(/[\\/]/).pop() === `${taskId}.yaml`)
      .map((error) => `${relative(cwd, error.filePath)}: ${error.error}`);
    throw new Error(
      taskLoadErrors.length > 0
        ? `Task ${taskId} could not be loaded: ${taskLoadErrors.join("; ")}`
        : `Task not found: ${taskId}`,
    );
  }

  const raw = readFileSync(found.filePath, "utf-8");
  const formatted = formatYamlDocument(parse(raw));
  const changed = raw !== formatted;

  if (changed && !checkOnly) {
    writeFileSync(found.filePath, formatted, "utf-8");
  }

  return {
    checked: true,
    changed,
    file: relative(cwd, found.filePath),
    errors: [],
  };
}

export function formatTaskCommand(taskId: string, options: FormatTaskOptions): void {
  try {
    const result = formatTaskById(taskId, options);
    if (options.checkOnly) {
      if (result.changed) {
        console.error(`Needs formatting: ${result.file}`);
        process.exit(1);
      }
      console.log(`Checked: ${result.file}`);
      return;
    }

    console.log(result.changed ? `Formatted: ${result.file}` : `Already formatted: ${result.file}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
