import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import picocolors from "picocolors";
import { parse } from "yaml";
import type { Status } from "../constants.js";
import type { LoadTaskTier, PathOwnershipWarning } from "../specs/loadTasks.js";
import { loadTasks, pathOwnershipWarningsForTask } from "../specs/loadTasks.js";
import type { TaskSpec } from "../specs/schema.js";
import {
  IMPLEMENTATION_TEMPLATE,
  implementationPromptFilename,
  REVIEW_TEMPLATE,
  renderDomainContext,
  renderTemplate,
  TEST_TEMPLATE,
} from "../templates/renderTemplate.js";
import { getPaths } from "../utils/paths.js";

export function getTemplate(type: TaskSpec["type"]): string {
  switch (type) {
    case "review":
      return REVIEW_TEMPLATE;
    case "test":
      return TEST_TEMPLATE;
    default:
      return IMPLEMENTATION_TEMPLATE;
  }
}

export function loadDomainContext(
  specsTasksDir: string,
  domain: string,
  cwd: string,
): string | undefined {
  const mancipleRoot = relative(cwd, dirname(dirname(specsTasksDir)));
  const domainPath = join(getPaths(cwd, mancipleRoot).specsDomains, `${domain}.yaml`);

  if (!existsSync(domainPath)) {
    console.error(
      `Warning: optional domain context not found for "${domain}" at ${domainPath.replace(`${cwd}/`, "")}; compiling without domain context.`,
    );
    return undefined;
  }

  const raw = readFileSync(domainPath, "utf-8");
  const parsed = parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  return renderDomainContext(parsed as Record<string, unknown>);
}

function formatOwnershipKind(kind: PathOwnershipWarning["kind"]): string {
  switch (kind) {
    case "locked":
      return "locked";
    case "unsafe_parallel_area":
      return "unsafe parallel-work area";
    case "touched":
      return "already touched";
  }
}

function printOwnershipWarnings(warnings: PathOwnershipWarning[]): void {
  if (warnings.length === 0) return;

  console.error("  ⚠ Path ownership warnings:");
  for (const warning of warnings) {
    console.error(
      `    - ${warning.affected_path} is ${formatOwnershipKind(warning.kind)} by ${warning.owner_task_id} (${warning.owner_path}). Keep this compile to a small safe slice.`,
    );
  }
}

export interface CompileOptions {
  specsTasksDir: string;
  generatedDir: string;
  cwd: string;
  taskId?: string;
  status?: Status;
  all?: boolean;
}

export function compileCommand(options: CompileOptions): void {
  const { specsTasksDir, generatedDir, cwd, taskId, status, all } = options;
  const tier: LoadTaskTier = all || taskId ? "all" : "active";
  const { tasks, errors } = loadTasks(specsTasksDir, tier);

  if (errors.length > 0) {
    console.error(`Cannot compile: ${errors.length} task(s) failed to load.`);
    for (const e of errors) {
      console.error(`  ${picocolors.red("✕")} ${e.filePath.replace(`${cwd}/`, "")}: ${e.error}`);
    }
    process.exit(1);
  }

  let targets = tasks;

  if (taskId) {
    targets = tasks.filter((t) => t.spec.id === taskId);
    if (targets.length === 0) {
      console.error(`No task found with id: ${taskId}`);
      process.exit(1);
    }
  } else if (status) {
    targets = tasks.filter((t) => t.spec.status === status);
  } else if (!all) {
    // Default: compile pending and in_progress
    targets = tasks.filter((t) => t.spec.status === "pending" || t.spec.status === "in_progress");
  }

  if (targets.length === 0) {
    console.log("No tasks matched the compile criteria.");
    return;
  }

  if (!existsSync(generatedDir)) {
    mkdirSync(generatedDir, { recursive: true });
  }

  for (const target of targets) {
    const { spec } = target;
    const warnings = pathOwnershipWarningsForTask(target, tasks);
    printOwnershipWarnings(warnings);

    const template = getTemplate(spec.type);
    const domainContext = loadDomainContext(specsTasksDir, spec.domain, cwd);
    const rendered = renderTemplate(template, spec, domainContext);
    const outPath = join(generatedDir, implementationPromptFilename(spec.id));
    writeFileSync(outPath, rendered, "utf-8");
    console.log(
      `  ${picocolors.green("✓ Compiled:")} ${picocolors.bold(outPath.replace(`${cwd}/`, ""))}`,
    );
  }

  console.log(
    `\n${picocolors.green(picocolors.bold(`Compiled ${targets.length} task${targets.length === 1 ? "" : "s"}.`))}`,
  );
}
