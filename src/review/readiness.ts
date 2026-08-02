import type { LoadedTask, TaskSpec } from "../specs/schema.js";

export type ChangedFilesSource = "run-log" | "git-status" | "missing";

export interface ReviewReadinessCommandResult {
  command: string;
  result?: string | null;
  status?: string | null;
}

export interface ReviewReadinessAcceptanceEvidence {
  criterion: string;
  evidence?: string | null;
}

export interface ReviewReadinessRunLog {
  filesChanged?: readonly string[];
  testsRun?: readonly string[];
  commandsRun?: readonly string[];
  verificationCommands?: readonly string[];
  verificationResults?: readonly string[];
  verificationReceipt?: string | null;
  verificationReceiptParseError?: string | null;
  commandResults?: readonly ReviewReadinessCommandResult[];
  decisionsMade?: readonly string[];
  result?: string | null;
  risks?: string | null;
  followUps?: readonly string[];
  acceptanceCriteriaEvidence?: readonly ReviewReadinessAcceptanceEvidence[];
  notes?: string | null;
  tokenEstimate?: string | null;
}

export interface ReviewReadinessEvidence {
  runLogs?: readonly ReviewReadinessRunLog[];
  gitChangedFiles?: readonly string[];
}

export interface ReviewReadinessReport {
  taskId: string;
  ready: boolean;
  score: number;
  checklist: ReviewReadinessChecklistItem[];
  humanReviewNeeded: boolean;
  humanReviewReasons: string[];
  hasRunLog: boolean;
  hasChangedFiles: boolean;
  changedFiles: string[];
  changedFilesSource: ChangedFilesSource;
  overlappingFiles: string[];
  hasVerificationCommands: boolean;
  hasVerificationResults: boolean;
  hasVerification: boolean;
  missingVerificationCommands: string[];
  failedVerificationCommands: string[];
  absentVerificationCommands: string[];
  hasRisks: boolean;
  documentedRisks: string[];
  missingReceiptFields: string[];
  uncoveredAcceptanceCriteria: string[];
  unmappedAcceptanceEvidence: string[];
  missingEvidence: string[];
}

export interface ReviewReadinessChecklistItem {
  id: string;
  label: string;
  passed: boolean;
  reason?: string;
}

function specFrom(task: LoadedTask | TaskSpec): TaskSpec {
  return "spec" in task ? task.spec : task;
}

function presentValues(values: readonly (string | null | undefined)[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value?.trim()).filter(Boolean) as string[])];
}

function hasExplicitValue(value: string | null | undefined): boolean {
  return value !== undefined && value !== null && value.trim().length > 0;
}

function runLogCommands(runLogs: readonly ReviewReadinessRunLog[]): string[] {
  return presentValues(runLogs.flatMap((log) => [
    ...(log.commandsRun ?? []),
    ...(log.testsRun ?? []),
    ...(log.verificationCommands ?? []),
    ...(log.commandResults ?? []).map((result) => result.command),
  ]));
}

function hasRecordedVerificationResult(runLogs: readonly ReviewReadinessRunLog[]): boolean {
  return runLogs.some((log) => (
    presentValues(log.verificationResults).length > 0 ||
    hasExplicitValue(log.result) ||
    (log.commandResults ?? []).some((result) => (
      hasExplicitValue(result.result) || hasExplicitValue(result.status)
    ))
  ));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandBodiesMatch(expected: string, recorded: string): boolean {
  if (recorded === expected) return true;
  if (!expected.includes("$(")) return false;

  const parts = expected.split(/\$\([^)]*\)/g).map(escapeRegExp);
  return new RegExp(`^${parts.join("[^\\s]+")}$`).test(recorded);
}

/**
 * Match a required verification command to a human-readable receipt entry.
 * Shell command substitutions may be expanded before the logger receives the
 * command, so `test "$(cat file)" = "value"` is equivalent to a recorded
 * `test "value" = "value"`. Result suffixes remain required when the receipt
 * contains text beyond the command itself.
 */
export function verificationCommandsMatch(expected: string, recorded: string): boolean {
  const expectedValue = expected.trim().replace(/\s+/g, " ");
  const recordedValue = recorded.trim().replace(/\s+/g, " ");

  if (commandBodiesMatch(expectedValue, recordedValue)) return true;

  const receipt = recordedValue.match(
    /^(.*?)(?::\s*|\s+(?:->|=>|[-–—])\s+|\s+\()(.+?)(?:\))?$/
  );
  if (!receipt) return false;

  const [, command, details] = receipt;
  return commandBodiesMatch(expectedValue, command.trim()) &&
    /\b(?:pass(?:ed|ing)?|ok|success(?:ful)?|fail(?:ed|ing)?|error|exit(?:ed)?\s+(?:code\s+)?\d+|non[- ]?zero)\b/i.test(details);
}

function missingExpectedCommands(expected: readonly string[], recorded: readonly string[]): string[] {
  return expected.filter((expectedCommand) => (
    !recorded.some((recordedCommand) => verificationCommandsMatch(expectedCommand, recordedCommand))
  ));
}

function normalizeReceiptField(field: string): string {
  return field.trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function receiptFieldIsPresent(
  field: string,
  runLogs: readonly ReviewReadinessRunLog[],
  changedFilesSource: ChangedFilesSource,
  hasVerificationEvidence: boolean,
  hasRisks: boolean
): boolean {
  switch (normalizeReceiptField(field)) {
    case "files_changed":
      return changedFilesSource !== "missing";
    case "tests_run":
      return hasVerificationEvidence;
    case "commands_run":
      return runLogCommands(runLogs).length > 0;
    case "decisions_made":
      return runLogs.some((log) => presentValues(log.decisionsMade).length > 0);
    case "risks":
      return hasRisks;
    case "follow_ups":
    case "follow_up_tasks":
      return runLogs.some((log) => presentValues(log.followUps).length > 0);
    default:
      return runLogs.some((log) => (
        presentValues(log.decisionsMade).some((value) => value.toLowerCase().includes(field.toLowerCase())) ||
        presentValues(log.followUps).some((value) => value.toLowerCase().includes(field.toLowerCase())) ||
        hasExplicitValue(log.notes) && log.notes!.toLowerCase().includes(field.toLowerCase())
      ));
  }
}

function isExplicitNone(value: string): boolean {
  const normalized = value.trim();
  return /^(?:none|n\/a|no(?:\s+[\w-]+)*\s+risks?(?:\s+(?:identified|remain(?:ing)?))?)\.?$/i.test(normalized);
}

function documentedRisks(runLogs: readonly ReviewReadinessRunLog[]): string[] {
  return presentValues(runLogs.map((log) => log.risks)).filter((risk) => !isExplicitNone(risk));
}

function tokenEstimateSections(runLogs: readonly ReviewReadinessRunLog[]): string[] {
  return presentValues(runLogs.map((log) => log.tokenEstimate));
}

function hasOverBudgetTokenEstimate(runLogs: readonly ReviewReadinessRunLog[]): boolean {
  return tokenEstimateSections(runLogs).some((section) => /Budget warning:\s*over budget\b/i.test(section));
}

function hasWarningOnlyBudgetConfirmation(runLogs: readonly ReviewReadinessRunLog[]): boolean {
  const searchable = presentValues(runLogs.flatMap((log) => [
    log.tokenEstimate,
    log.risks,
    log.notes,
    ...(log.decisionsMade ?? []),
    ...(log.acceptanceCriteriaEvidence ?? []).map((entry) => entry.evidence),
  ])).join("\n");

  return /\bwarning[- ]only\b/i.test(searchable) || /Warning only;\s*no workflow failed\./i.test(searchable);
}

function failedVerificationCommands(runLogs: readonly ReviewReadinessRunLog[]): string[] {
  const failedFromResults = runLogs.flatMap((log) => (
    log.commandResults ?? []
  ).filter((result) => {
    const status = result.status?.toLowerCase() ?? "";
    if (/\b(pass|passed|ok|success|successful)\b/.test(status)) return false;
    if (/\b(fail|failed|error|non-zero|nonzero)\b/.test(status)) return true;
    return /\b(fail|failed|error|non-zero|nonzero)\b/i.test(result.result ?? "");
  }).map((result) => result.command));

  const failedFromText = runLogs.flatMap((log) => presentValues(log.verificationResults))
    .filter((result) => /\b(fail|failed|error|non-zero|nonzero)\b/i.test(result));

  const failedFromOutcome = runLogs
    .filter((log) => /\b(failed|blocked)\b/i.test(log.result ?? ""))
    .flatMap((log) => presentValues([
      ...(log.commandsRun ?? []),
      ...(log.testsRun ?? []),
      ...(log.verificationCommands ?? []),
    ]));

  return presentValues([...failedFromResults, ...failedFromText, ...failedFromOutcome]);
}

function changedFilesFromRunLogs(runLogs: readonly ReviewReadinessRunLog[]): string[] {
  return presentValues(runLogs.flatMap((log) => log.filesChanged ?? []));
}

function pathOverlaps(runLogs: readonly ReviewReadinessRunLog[], gitChangedFiles: readonly string[] | undefined): string[] {
  const receiptFiles = new Set(changedFilesFromRunLogs(runLogs));
  return presentValues(gitChangedFiles).filter((file) => receiptFiles.has(file));
}

function acceptanceCoverage(spec: TaskSpec, runLogs: readonly ReviewReadinessRunLog[]): {
  uncovered: string[];
  unmapped: string[];
} {
  const evidence = runLogs.flatMap((log) => log.acceptanceCriteriaEvidence ?? []);
  const covered = new Set<string>();
  const mappedEvidenceIndexes = new Set<number>();

  evidence.forEach((entry, index) => {
    const criterion = entry.criterion.trim();
    if (hasExplicitValue(entry.evidence) && spec.acceptance_criteria.includes(criterion)) {
      covered.add(criterion);
      mappedEvidenceIndexes.add(index);
    }
  });

  // Older run logs stored one evidence-only bullet per criterion. When the
  // counts match, preserve that deterministic ordering instead of requiring
  // workers to rewrite otherwise complete historical receipts.
  if (evidence.length > 1 && evidence.length === spec.acceptance_criteria.length) {
    evidence.forEach((entry, index) => {
      if (!hasExplicitValue(entry.evidence) && !hasExplicitValue(entry.criterion)) return;
      covered.add(spec.acceptance_criteria[index]);
      mappedEvidenceIndexes.add(index);
    });
  }

  const unmapped = presentValues(evidence
    .filter((_entry, index) => !mappedEvidenceIndexes.has(index))
    .map((entry) => entry.evidence
      ? `${entry.criterion}: ${entry.evidence}`
      : entry.criterion));

  const searchableEvidence = presentValues(runLogs.flatMap((log) => [
    ...(log.decisionsMade ?? []),
    ...(log.followUps ?? []),
    log.notes,
  ])).join("\n").toLowerCase();

  const uncovered = spec.acceptance_criteria.filter((criterion) => (
    !covered.has(criterion) &&
    !searchableEvidence.includes(criterion.toLowerCase())
  ));

  return { uncovered, unmapped };
}

function scoreFrom(checklist: readonly ReviewReadinessChecklistItem[]): number {
  const passed = checklist.filter((item) => item.passed).length;
  return Math.round((passed / checklist.length) * 100);
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function evaluateReviewReadiness(
  task: LoadedTask | TaskSpec,
  evidence: ReviewReadinessEvidence = {}
): ReviewReadinessReport {
  const spec = specFrom(task);
  const runLogs = evidence.runLogs ?? [];
  const hasRunLog = runLogs.length > 0;

  const hasRunLogFiles = runLogs.some((log) => presentValues(log.filesChanged).length > 0);
  const hasGitFiles = presentValues(evidence.gitChangedFiles).length > 0;
  const changedFilesSource: ChangedFilesSource = hasRunLogFiles
    ? "run-log"
    : hasGitFiles
      ? "git-status"
      : "missing";
  const changedFiles = hasRunLogFiles
    ? changedFilesFromRunLogs(runLogs)
    : presentValues(evidence.gitChangedFiles);

  const recordedCommands = runLogCommands(runLogs);
  const missingVerificationCommands = missingExpectedCommands(
    spec.verification.commands,
    recordedCommands
  );
  const failedCommands = failedVerificationCommands(runLogs);
  const hasVerificationCommands = recordedCommands.length > 0 &&
    missingVerificationCommands.length === 0;
  const hasVerificationResults = hasRecordedVerificationResult(runLogs);
  const hasVerificationEvidence = recordedCommands.length > 0 && hasVerificationResults;
  const hasVerification = hasVerificationCommands && hasVerificationResults && failedCommands.length === 0;
  const hasRisks = runLogs.some((log) => hasExplicitValue(log.risks));
  const risks = documentedRisks(runLogs);
  const overlappingFiles = pathOverlaps(runLogs, evidence.gitChangedFiles);
  const acceptance = acceptanceCoverage(spec, runLogs);
  const uncoveredCriteria = acceptance.uncovered;
  const unmappedAcceptanceEvidence = acceptance.unmapped;
  const hasAcceptanceEvidence = runLogs.some((log) => (
    (log.acceptanceCriteriaEvidence ?? []).some((entry) => (
      hasExplicitValue(entry.criterion) || hasExplicitValue(entry.evidence)
    ))
  ));
  const missingReceiptFields = spec.outputs_required.filter((field) => (
    !receiptFieldIsPresent(field, runLogs, changedFilesSource, hasVerificationEvidence, hasRisks)
  ));
  const hasBudgetWarning = hasOverBudgetTokenEstimate(runLogs);
  const hasBudgetWarningOnlyConfirmation = !hasBudgetWarning || hasWarningOnlyBudgetConfirmation(runLogs);

  const missingEvidence: string[] = [];
  if (!hasRunLog) {
    missingEvidence.push(`No run log is available for task ${spec.id}.`);
  }
  if (changedFilesSource === "missing") {
    missingEvidence.push("No changed files are listed in the run log or available from git status.");
  }
  if (recordedCommands.length === 0) {
    missingEvidence.push("No verification commands are recorded in the run log.");
  } else if (missingVerificationCommands.length > 0) {
    missingEvidence.push(
      `Run log is missing expected verification command(s): ${missingVerificationCommands.join(", ")}.`
    );
  }
  if (!hasVerificationResults) {
    missingEvidence.push("No verification result is recorded in the run log.");
  }
  for (const parseError of presentValues(runLogs.map((log) => log.verificationReceiptParseError))) {
    missingEvidence.push(`Verification receipt is not parseable: ${parseError}.`);
  }
  if (failedCommands.length > 0) {
    missingEvidence.push(`Verification command(s) appear to have failed: ${failedCommands.join(", ")}.`);
  }
  if (!hasRisks) {
    missingEvidence.push("No risks entry is recorded in the run log; use \"none\" when no risks remain.");
  }
  if (missingReceiptFields.length > 0) {
    missingEvidence.push(`Run log is missing required receipt field(s): ${missingReceiptFields.join(", ")}.`);
  }
  if (uncoveredCriteria.length > 0 && !hasAcceptanceEvidence) {
    missingEvidence.push(sentence(unmappedAcceptanceEvidence.length > 0
      ? `Acceptance evidence is present but not mapped to task criteria; uncovered criteria: ${uncoveredCriteria.join(" | ")}`
      : `Acceptance criteria without evidence: ${uncoveredCriteria.join(" | ")}`));
  }
  if (!hasBudgetWarningOnlyConfirmation) {
    missingEvidence.push(
      "Over-budget token estimate needs review evidence confirming budget overages are warning-only."
    );
  }

  const checklist: ReviewReadinessChecklistItem[] = [
    {
      id: "receipt",
      label: "Required receipt fields are present",
      passed: missingReceiptFields.length === 0,
      reason: missingReceiptFields.length ? missingReceiptFields.join(", ") : undefined,
    },
    {
      id: "changed-files",
      label: "Changed files are recorded",
      passed: changedFilesSource !== "missing",
      reason: changedFilesSource === "missing" ? "missing" : changedFilesSource,
    },
    {
      id: "tests",
      label: "Expected tests are recorded and passing",
      passed: hasVerification,
      reason: [
        ...missingVerificationCommands.map((command) => `missing ${command}`),
        ...failedCommands.map((command) => `failed ${command}`),
        !hasVerificationResults ? "missing result" : "",
      ].filter(Boolean).join("; ") || undefined,
    },
    {
      id: "path-overlap",
      label: "Run-log files do not overlap current git changes",
      passed: overlappingFiles.length === 0,
      reason: overlappingFiles.join(", ") || undefined,
    },
    {
      id: "acceptance",
      label: "Acceptance criteria have evidence",
      passed: uncoveredCriteria.length === 0,
      reason: uncoveredCriteria.join(" | ") || undefined,
    },
    {
      id: "risks",
      label: "No documented residual risks",
      passed: hasRisks && risks.length === 0,
      reason: !hasRisks ? "missing risks receipt" : risks.join(" | ") || undefined,
    },
    {
      id: "budget-warning",
      label: "Budget warning present but warning-only behavior confirmed",
      passed: hasBudgetWarningOnlyConfirmation,
      reason: !hasBudgetWarning
        ? "no over-budget token estimate"
        : "missing warning-only confirmation",
    },
  ];
  const score = scoreFrom(checklist);
  const humanReviewReasons = checklist
    .filter((item) => !item.passed)
    .map((item) => item.reason ? `${item.label}: ${item.reason}` : item.label);
  const humanReviewNeeded = humanReviewReasons.length > 0;

  return {
    taskId: spec.id,
    ready: missingEvidence.length === 0,
    score,
    checklist,
    humanReviewNeeded,
    humanReviewReasons,
    hasRunLog,
    hasChangedFiles: changedFilesSource !== "missing",
    changedFiles,
    changedFilesSource,
    overlappingFiles,
    hasVerificationCommands,
    hasVerificationResults,
    hasVerification,
    missingVerificationCommands,
    failedVerificationCommands: failedCommands,
    absentVerificationCommands: missingVerificationCommands,
    hasRisks,
    documentedRisks: risks,
    missingReceiptFields,
    uncoveredAcceptanceCriteria: uncoveredCriteria,
    unmappedAcceptanceEvidence,
    missingEvidence,
  };
}
