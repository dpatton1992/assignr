import { dirname, relative } from "node:path";
import picocolors from "picocolors";
import type { LoadedTaskWithTier } from "../specs/loadTasks.js";
import { loadTasks } from "../specs/loadTasks.js";
import type { TaskSpec } from "../specs/schema.js";
import type { ValidationCounts } from "../specs/validateTasks.js";
import { validateTasks } from "../specs/validateTasks.js";
import { getPaths } from "../utils/paths.js";

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function withLoadErrorCounts(counts: ValidationCounts, loadErrorCount: number): ValidationCounts {
  return {
    tasksChecked: counts.tasksChecked + loadErrorCount,
    domainsChecked: counts.domainsChecked,
    contractsChecked: counts.contractsChecked + loadErrorCount,
  };
}

export interface ValidateCommandOptions {
  all?: boolean;
}

function dependencyContextTask(task: LoadedTaskWithTier): LoadedTaskWithTier {
  const spec: TaskSpec = {
    ...task.spec,
    depends_on: [],
    allowed_paths: ["dependency-context"],
    forbidden_paths: ["dependency-context"],
    goal: task.spec.goal || "Dependency context task.",
    acceptance_criteria:
      task.spec.acceptance_criteria.length > 0
        ? task.spec.acceptance_criteria
        : ["Dependency context task."],
    verification: {
      commands:
        task.spec.verification.commands.length > 0
          ? task.spec.verification.commands
          : ["Dependency context task."],
    },
    outputs_required: ["dependency-context"],
    notes: ["Loaded only so active task dependency references can be resolved."],
  };

  return { spec, filePath: task.filePath, tier: task.tier };
}

function activeOnlyValidationTasks(specsTasksDir: string): ReturnType<typeof loadTasks> {
  const activeResult = loadTasks(specsTasksDir, "active");
  const allResult = loadTasks(specsTasksDir, "all");
  const activeIds = new Set(activeResult.tasks.map((task) => task.spec.id));
  const contextTasks = allResult.tasks
    .filter((task) => !activeIds.has(task.spec.id))
    .map(dependencyContextTask);

  return {
    tasks: [...activeResult.tasks, ...contextTasks],
    errors: activeResult.errors,
  };
}

export function validateCommand(
  specsTasksDir: string,
  cwd: string,
  options: ValidateCommandOptions = {},
): void {
  const activeResult = options.all ? undefined : loadTasks(specsTasksDir, "active");
  const activeFilePaths = new Set(activeResult?.tasks.map((task) => task.filePath));
  const { tasks, errors: loadErrors } = options.all
    ? loadTasks(specsTasksDir, "all")
    : activeOnlyValidationTasks(specsTasksDir);
  const mancipleRoot = relative(cwd, dirname(dirname(specsTasksDir)));
  const specsDomainsDir = getPaths(cwd, mancipleRoot).specsDomains;

  let totalErrors = loadErrors.length;
  let totalWarnings = 0;

  // Report load errors first
  for (const { filePath, error } of loadErrors) {
    console.error(`  ${picocolors.red("✕")} ${relative(cwd, filePath)}`);
    console.error(`    ${error}`);
  }

  if (tasks.length === 0 && loadErrors.length === 0) {
    console.warn(
      `  ${picocolors.yellow("⚠")} No tasks found. Run "manciple task new" to create your first task.`,
    );
  }

  const result = validateTasks(tasks, {
    specsDomainsDir,
    ...(options.all ? {} : { countFilePaths: activeFilePaths }),
  });
  const valid = options.all
    ? result.valid
    : result.valid.filter((task) => activeFilePaths.has(task.filePath));
  const invalid = options.all
    ? result.invalid
    : result.invalid.filter((entry) => activeFilePaths.has(entry.filePath));
  const warnings = options.all
    ? result.warnings
    : result.warnings.filter((warning) => activeFilePaths.has(warning.filePath));
  const checkedCounts = withLoadErrorCounts(result.counts, loadErrors.length);

  for (const { filePath, errors } of invalid) {
    totalErrors++;
    console.error(`  ${picocolors.red("✕")} ${relative(cwd, filePath)}`);
    for (const issue of errors) {
      console.error(`    [${issue.field}] ${issue.message}`);
    }
  }

  for (const warning of warnings) {
    totalWarnings++;
    console.warn(
      `  ${picocolors.yellow("⚠")} ${relative(cwd, warning.filePath)} [${warning.field}] ${warning.message}`,
    );
  }

  const totalValid = valid.length;

  console.log(`\n${picocolors.bold("Manciple Validate")}`);
  console.log(`${picocolors.dim("─────────────────")}`);
  console.log(
    `  Checked: ${picocolors.bold(formatCount(checkedCounts.tasksChecked, "task"))}, ` +
      `${picocolors.bold(formatCount(checkedCounts.domainsChecked, "domain"))}, ` +
      `${picocolors.bold(formatCount(checkedCounts.contractsChecked, "contract"))}`,
  );
  if (totalValid > 0)
    console.log(
      `  ${picocolors.green("✓")} ${picocolors.bold(String(totalValid))} valid task${totalValid === 1 ? "" : "s"}`,
    );
  if (totalWarnings > 0)
    console.log(
      `  ${picocolors.yellow("⚠")} ${picocolors.bold(String(totalWarnings))} warning${totalWarnings === 1 ? "" : "s"}`,
    );
  if (totalErrors > 0)
    console.log(
      `  ${picocolors.red("✕")} ${picocolors.bold(String(totalErrors))} invalid task${totalErrors === 1 ? "" : "s"}`,
    );

  if (totalErrors > 0) {
    process.exit(1);
  }
}
