import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LoadedTask } from "./schema.js";

export interface ValidationIssue {
  filePath: string;
  field: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  valid: LoadedTask[];
  invalid: Array<{ filePath: string; errors: ValidationIssue[] }>;
  warnings: ValidationIssue[];
  counts: ValidationCounts;
}

export interface ValidationCounts {
  tasksChecked: number;
  domainsChecked: number;
  contractsChecked: number;
}

export interface ValidateTasksOptions {
  specsDomainsDir?: string;
  countFilePaths?: ReadonlySet<string>;
}

// Graph fields are intentionally excluded — empty graph declarations are valid.
const OPTIONAL_FIELDS = [
  "allowed_paths",
  "forbidden_paths",
  "outputs_required",
  "implementation_notes",
  "notes",
] as const;

export function validateTasks(
  tasks: LoadedTask[],
  options: ValidateTasksOptions = {},
): ValidationResult {
  const warnings: ValidationIssue[] = [];
  const errorsByFile = new Map<string, ValidationIssue[]>();
  const shouldCount = (filePath: string): boolean =>
    options.countFilePaths ? options.countFilePaths.has(filePath) : true;
  const countedTaskCount = tasks.filter((task) => shouldCount(task.filePath)).length;
  const counts: ValidationCounts = {
    tasksChecked: countedTaskCount,
    domainsChecked: 0,
    contractsChecked: 0,
  };
  let hasMissingDependencyError = false;

  // Check for duplicate IDs
  const idMap = new Map<string, string[]>();
  for (const { spec, filePath } of tasks) {
    const existing = idMap.get(spec.id) ?? [];
    idMap.set(spec.id, [...existing, filePath]);
  }

  // Build set of all task IDs for dependency checking
  const allIds = new Set(tasks.map((t) => t.spec.id));
  const taskById = new Map(tasks.map((t) => [t.spec.id, t]));

  function addError(filePath: string, issue: ValidationIssue): void {
    const errors = errorsByFile.get(filePath) ?? [];
    errors.push(issue);
    errorsByFile.set(filePath, errors);
  }

  for (const loaded of tasks) {
    const { spec, filePath } = loaded;
    const countTask = shouldCount(filePath);

    // Check for duplicate IDs
    if (countTask) counts.contractsChecked++;
    const duplicates = idMap.get(spec.id) ?? [];
    if (duplicates.length > 1 && duplicates[0] !== filePath) {
      addError(filePath, {
        filePath,
        field: "id",
        message: `Duplicate task id "${spec.id}" also found in ${duplicates[0]}`,
        severity: "error",
      });
    }

    hasMissingDependencyError =
      validateTaskReferences({
        specId: spec.id,
        filePath,
        field: "depends_on",
        references: spec.depends_on ?? [],
        allIds,
        countTask,
        counts,
        missingMessage: (reference) => `Task "${spec.id}" depends on missing task "${reference}"`,
        addError,
      }) || hasMissingDependencyError;

    validateTaskReferences({
      specId: spec.id,
      filePath,
      field: "blocks",
      references: spec.blocks ?? [],
      allIds,
      countTask,
      counts,
      missingMessage: (reference) => `Task "${spec.id}" blocks missing task "${reference}"`,
      addError,
    });

    validateTaskReferences({
      specId: spec.id,
      filePath,
      field: "conflicts_with",
      references: spec.conflicts_with ?? [],
      allIds,
      countTask,
      counts,
      missingMessage: (reference) => `Task "${spec.id}" conflicts with missing task "${reference}"`,
      selfMessage: () => `Task "${spec.id}" cannot conflict with itself`,
      addError,
    });

    // Warn about missing optional fields
    for (const field of OPTIONAL_FIELDS) {
      if (countTask) counts.contractsChecked++;
      const value = spec[field];
      if (!value || (Array.isArray(value) && value.length === 0)) {
        warnings.push({
          filePath,
          field,
          message: `Optional field "${field}" is empty or missing`,
          severity: "warning",
        });
      }
    }

    // Warn about TODO placeholder values
    if (countTask) counts.contractsChecked++;
    if (spec.goal?.startsWith("TODO:")) {
      warnings.push({
        filePath,
        field: "goal",
        message: `Field "goal" still contains a TODO placeholder — replace with a real goal`,
        severity: "warning",
      });
    }
    if (countTask) counts.contractsChecked++;
    if (spec.acceptance_criteria?.some((c) => c.startsWith("TODO:"))) {
      warnings.push({
        filePath,
        field: "acceptance_criteria",
        message: `Field "acceptance_criteria" still contains a TODO placeholder — replace with real criteria`,
        severity: "warning",
      });
    }
    if (countTask) counts.contractsChecked++;
    if (spec.verification?.commands?.some((c) => c.startsWith("TODO:"))) {
      warnings.push({
        filePath,
        field: "verification.commands",
        message: `Field "verification.commands" still contains a TODO placeholder — replace with real commands`,
        severity: "warning",
      });
    }
  }

  if (options.specsDomainsDir) {
    const domainValidation = validateDomainReferences(tasks, options.specsDomainsDir, shouldCount);
    counts.domainsChecked = domainValidation.domainsChecked;
    counts.contractsChecked += domainValidation.contractsChecked;
    for (const { filePath, issue } of domainValidation.issues) {
      addError(filePath, issue);
    }
  }

  if (!hasMissingDependencyError) {
    if (countedTaskCount > 0) counts.contractsChecked++;
    const cycles = findDependencyCycles(tasks, taskById);
    for (const cycle of cycles) {
      const task = taskById.get(cycle[0]);
      if (!task) continue;
      addError(task.filePath, {
        filePath: task.filePath,
        field: "depends_on",
        message: `Circular dependency detected: ${cycle.join(" → ")}`,
        severity: "error",
      });
    }
  }

  const invalid = tasks
    .map(({ filePath }) => ({ filePath, errors: errorsByFile.get(filePath) ?? [] }))
    .filter(({ errors }) => errors.length > 0);
  const invalidFiles = new Set(invalid.map(({ filePath }) => filePath));
  const valid = tasks.filter(({ filePath }) => !invalidFiles.has(filePath));

  return { valid, invalid, warnings, counts };
}

function validateDomainReferences(
  tasks: LoadedTask[],
  specsDomainsDir: string,
  shouldCount: (filePath: string) => boolean,
): {
  issues: Array<{ filePath: string; issue: ValidationIssue }>;
  domainsChecked: number;
  contractsChecked: number;
} {
  const issues: Array<{ filePath: string; issue: ValidationIssue }> = [];
  const domains = new Set<string>();
  let contractsChecked = 0;

  for (const { spec, filePath } of tasks) {
    if (shouldCount(filePath)) {
      domains.add(spec.domain);
      contractsChecked++;
    }
    const domainPath = join(specsDomainsDir, `${spec.domain}.yaml`);
    if (existsSync(domainPath)) continue;

    issues.push({
      filePath,
      issue: {
        filePath,
        field: "domain",
        message: `Task "${spec.id}" references missing domain "${spec.domain}"`,
        severity: "error",
      },
    });
  }

  return {
    issues,
    domainsChecked: domains.size,
    contractsChecked,
  };
}

function validateTaskReferences({
  specId,
  filePath,
  field,
  references,
  allIds,
  countTask,
  counts,
  missingMessage,
  selfMessage,
  addError,
}: {
  specId: string;
  filePath: string;
  field: "depends_on" | "blocks" | "conflicts_with";
  references: string[];
  allIds: Set<string>;
  countTask: boolean;
  counts: ValidationCounts;
  missingMessage: (reference: string) => string;
  selfMessage?: (reference: string) => string;
  addError: (filePath: string, issue: ValidationIssue) => void;
}): boolean {
  let hasMissingReference = false;

  for (const reference of references) {
    if (countTask) counts.contractsChecked++;
    if (!allIds.has(reference)) {
      hasMissingReference = true;
      addError(filePath, {
        filePath,
        field,
        message: missingMessage(reference),
        severity: "error",
      });
      continue;
    }

    if (reference === specId && selfMessage) {
      addError(filePath, {
        filePath,
        field,
        message: selfMessage(reference),
        severity: "error",
      });
    }
  }

  return hasMissingReference;
}

function findDependencyCycles(tasks: LoadedTask[], taskById: Map<string, LoadedTask>): string[][] {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seenCycles = new Set<string>();

  function visit(id: string): void {
    if (inStack.has(id)) {
      const cycle = [...stack.slice(stack.indexOf(id)), id];
      const key = canonicalCycleKey(cycle);
      if (!seenCycles.has(key)) {
        seenCycles.add(key);
        cycles.push(cycle);
      }
      return;
    }

    if (visited.has(id)) return;

    visited.add(id);
    inStack.add(id);
    stack.push(id);

    for (const dep of taskById.get(id)?.spec.depends_on ?? []) {
      visit(dep);
    }

    stack.pop();
    inStack.delete(id);
  }

  for (const { spec } of tasks) {
    visit(spec.id);
  }

  return cycles;
}

function canonicalCycleKey(cycle: string[]): string {
  const nodes = cycle.slice(0, -1);
  const rotations = nodes.map((_, index) => [...nodes.slice(index), ...nodes.slice(0, index)]);
  return rotations.map((rotation) => rotation.join("\0")).sort()[0] ?? "";
}
