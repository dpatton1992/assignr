import { basename, dirname, join } from "node:path";
import picocolors from "picocolors";
import type {
  DeterministicReviewBlocker,
  DeterministicReviewBlockerKind,
  DeterministicReviewTaskReport,
} from "../review/deterministicGate.js";
import { evaluateDeterministicReviewGate } from "../review/deterministicGate.js";
import { headerBanner, styleCell } from "../utils/styling.js";
import { createReviewPrompt } from "./review.js";

export type ReviewQueueMode = "triage" | "deep";
export type ReviewQueueDeepOnly = "risky";

export interface ReviewQueueCommandOptions {
  mode?: ReviewQueueMode;
  all?: boolean;
  budget?: string | number;
  deepOnly?: ReviewQueueDeepOnly | string;
  machine?: boolean;
  generatedDir?: string;
  activeDir?: string;
  completedDir?: string;
  archivedDir?: string;
}

const BLOCKED_KINDS = new Set<DeterministicReviewBlockerKind>([
  "load-error",
  "lifecycle-placement",
  "status-mismatch",
  "blocked-dependency",
  "completed-active",
  "active-wrong-directory",
]);

function decisionFor(
  blockers: readonly DeterministicReviewBlocker[],
): "pass" | "escalate" | "blocked" {
  if (blockers.length === 0) return "pass";
  return blockers.some((blocker) => BLOCKED_KINDS.has(blocker.kind)) ? "blocked" : "escalate";
}

function truncateId(id: string): string {
  if (id.length <= 45) return id;
  return `${id.slice(0, 45)}…`;
}

function colorForBlockerKind(kind: DeterministicReviewBlockerKind): (s: string) => string {
  switch (kind) {
    case "path-policy":
    case "path-ownership":
    case "load-error":
      return picocolors.red;
    case "missing-evidence":
    case "missing-run-log":
      return picocolors.yellow;
    case "blocked-dependency":
      return picocolors.magenta;
    default:
      return picocolors.red;
  }
}

function formatReasons(blockers: readonly DeterministicReviewBlocker[]): string {
  if (blockers.length === 0) return "deterministic=pass";

  return blockers.map((blocker) => `${blocker.kind}: ${blocker.reason}`).join(" | ");
}

function summarizeBlockers(blockers: readonly DeterministicReviewBlocker[]): string {
  if (blockers.length === 0) return "deterministic=pass";
  const counts = new Map<DeterministicReviewBlockerKind, number>();
  for (const blocker of blockers) {
    counts.set(blocker.kind, (counts.get(blocker.kind) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) => `${count} ${kind}`).join(", ");
}

function formatDeepEvidence(taskReport: DeterministicReviewTaskReport): string {
  const readiness = taskReport.readiness;

  if (!readiness) return "readiness=unavailable";

  const evidence = [
    `score=${readiness.score}`,
    `changedFiles=${readiness.changedFilesSource}`,
    readiness.missingEvidence.length > 0 ? `missing=${readiness.missingEvidence.join(" | ")}` : "",
    readiness.failedVerificationCommands.length > 0
      ? `failedVerification=${readiness.failedVerificationCommands.join(", ")}`
      : "",
    readiness.missingVerificationCommands.length > 0
      ? `missingVerification=${readiness.missingVerificationCommands.join(", ")}`
      : "",
    readiness.documentedRisks.length > 0 ? `risks=${readiness.documentedRisks.join(" | ")}` : "",
    readiness.overlappingFiles.length > 0
      ? `overlappingFiles=${readiness.overlappingFiles.join(", ")}`
      : "",
    readiness.missingReceiptFields.length > 0
      ? `missingReceiptFields=${readiness.missingReceiptFields.join(", ")}`
      : "",
    readiness.uncoveredAcceptanceCriteria.length > 0
      ? `uncoveredAcceptanceCriteria=${readiness.uncoveredAcceptanceCriteria.join(" | ")}`
      : "",
  ].filter(Boolean);

  return evidence.join("; ");
}

function riskFlagsFor(taskReport: DeterministicReviewTaskReport): string[] {
  const readiness = taskReport.readiness;
  const flags = new Set<string>();

  for (const issue of [...taskReport.blockers, ...taskReport.advisories]) {
    switch (issue.kind) {
      case "missing-evidence":
      case "missing-run-log":
      case "missing-generated-prompt":
      case "missing-review-log":
        flags.add("missing-evidence");
        break;
      case "path-policy":
        flags.add("scope-violation");
        break;
      case "blocked-dependency":
        flags.add("dependency-conflict");
        break;
      case "path-ownership":
        flags.add("coordinator-rework");
        break;
      default:
        break;
    }
  }

  if ((readiness?.failedVerificationCommands.length ?? 0) > 0) {
    flags.add("failed-verification");
  }
  if ((readiness?.documentedRisks.length ?? 0) > 0) {
    flags.add("documented-risk");
  }
  if ((readiness?.uncoveredAcceptanceCriteria.length ?? 0) > 0) {
    flags.add("incomplete-acceptance-evidence");
  }
  if ((readiness?.missingReceiptFields.length ?? 0) > 0) {
    flags.add("missing-receipt");
  }

  return [...flags].sort();
}

function allowedPathSummary(taskReport: DeterministicReviewTaskReport): string {
  const pathPolicy = taskReport.blockers.filter((b) => b.kind === "path-policy").length;
  return `path-policy:${pathPolicy}`;
}

function evidenceCoverage(taskReport: DeterministicReviewTaskReport): string {
  const total = taskReport.acceptanceCriteriaCount;
  const uncovered = taskReport.readiness?.uncoveredAcceptanceCriteria.length ?? total;
  const covered = Math.max(0, total - uncovered);

  return `${covered}/${total}`;
}

function reviewerQuestionFor(taskReport: DeterministicReviewTaskReport): string {
  const readiness = taskReport.readiness;
  const firstReason =
    taskReport.blockers[0]?.reason ??
    readiness?.humanReviewReasons[0] ??
    taskReport.advisories[0]?.reason ??
    "";

  if (/failed|verification/i.test(firstReason)) {
    return "Which verification result should the reviewer trust?";
  }
  if (/outside allowed_paths|forbidden_paths|scope/i.test(firstReason)) {
    return "Should the out-of-scope file change be accepted or sent back?";
  }
  if (/dependency/i.test(firstReason)) {
    return "Is the dependency state safe enough for review to continue?";
  }
  if (/risk/i.test(firstReason)) {
    return "Is the documented residual risk acceptable for approval?";
  }
  if (/acceptance/i.test(firstReason)) {
    return "Which acceptance criterion still needs evidence?";
  }

  return "What evidence would let the reviewer make a confident decision?";
}

function compressedPacketFor(taskReport: DeterministicReviewTaskReport): string {
  const readiness = taskReport.readiness;
  const changedFileCount = readiness?.changedFiles.length ?? 0;
  const testsReported = readiness?.hasVerification ? "yes" : "no";
  const riskFlags = riskFlagsFor(taskReport);

  return [
    `id=${taskReport.taskId}`,
    `status=${taskReport.status}`,
    `changedFiles=${changedFileCount}`,
    `path=${allowedPathSummary(taskReport)}`,
    `tests=${testsReported}`,
    `criteria=${taskReport.acceptanceCriteriaCount}`,
    `evidence=${evidenceCoverage(taskReport)}`,
    `risks=${riskFlags.length > 0 ? riskFlags.join(",") : "none"}`,
    `question=${reviewerQuestionFor(taskReport)}`,
  ].join(";");
}

function formatPacketMultiline(taskReport: DeterministicReviewTaskReport): string[] {
  const readiness = taskReport.readiness;
  const changedFileCount = readiness?.changedFiles.length ?? 0;
  const riskFlags = riskFlagsFor(taskReport);

  return [
    `Changes: ${changedFileCount}`,
    `Path: ${allowedPathSummary(taskReport)}`,
    `Criteria: ${taskReport.acceptanceCriteriaCount}`,
    `Risks: ${riskFlags.length > 0 ? riskFlags.join(", ") : "none"}`,
    `Question: ${reviewerQuestionFor(taskReport)}`,
  ];
}

function formatCondensedEvidence(taskReport: DeterministicReviewTaskReport): string[] {
  const readiness = taskReport.readiness;
  if (!readiness) return ["readiness: unavailable"];

  const lines: string[] = [];
  lines.push(`score: ${readiness.score}`);
  lines.push(`changedFiles: ${readiness.changedFilesSource}`);
  if (readiness.missingEvidence.length > 0) {
    lines.push(`missing: ${readiness.missingEvidence.length} items`);
  }
  if (readiness.failedVerificationCommands.length > 0) {
    lines.push(`failedVerification: ${readiness.failedVerificationCommands.length} items`);
  }
  if (readiness.missingVerificationCommands.length > 0) {
    lines.push(`missingVerification: ${readiness.missingVerificationCommands.length} items`);
  }
  if (readiness.documentedRisks.length > 0) {
    lines.push(`risks: ${readiness.documentedRisks.length} items`);
  }
  if (readiness.overlappingFiles.length > 0) {
    lines.push(`overlappingFiles: ${readiness.overlappingFiles.length} items`);
  }
  if (readiness.missingReceiptFields.length > 0) {
    lines.push(`missingReceiptFields: ${readiness.missingReceiptFields.length} items`);
  }
  if (readiness.uncoveredAcceptanceCriteria.length > 0) {
    lines.push(
      `uncoveredAcceptanceCriteria: ${readiness.uncoveredAcceptanceCriteria.length} items`,
    );
  }
  return lines;
}

function estimatedTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function parseBudget(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(normalized) || normalized <= 0) {
    console.error("Invalid review queue budget: expected a positive integer.");
    process.exit(1);
  }

  return normalized;
}

function rel(cwd: string, path: string): string {
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

function mancipleRootFrom(tasksDir: string): string {
  const last = basename(tasksDir);
  const parent = dirname(tasksDir);

  if (last === "active" || last === "completed" || last === "archived") {
    return dirname(parent);
  }

  if (last === "tasks" && basename(parent) === "specs") {
    return dirname(parent);
  }

  return dirname(tasksDir);
}

function colorForDecision(decision: "pass" | "escalate" | "blocked"): (text: string) => string {
  switch (decision) {
    case "pass":
      return picocolors.green;
    case "escalate":
      return picocolors.yellow;
    case "blocked":
      return picocolors.red;
  }
}

function symbolForDecision(decision: "pass" | "escalate" | "blocked"): string {
  switch (decision) {
    case "pass":
      return "✓";
    case "escalate":
      return "◐";
    case "blocked":
      return "⊘";
  }
}

function formatDecisionLabel(decision: "pass" | "escalate" | "blocked"): string {
  const color = colorForDecision(decision);
  return color(`${symbolForDecision(decision)} ${decision}`);
}

function runTriageMode(
  report: ReturnType<typeof evaluateDeterministicReviewGate>,
  machine: boolean,
): void {
  if (machine) {
    for (const taskReport of report.taskReports) {
      const decision = decisionFor(taskReport.blockers);
      console.log(`${decision}\t${taskReport.taskId}\t${formatReasons(taskReport.blockers)}`);
    }
    for (const blocker of report.loadBlockers) {
      console.log(`blocked\t${blocker.taskId}\t${blocker.kind}: ${blocker.reason}`);
    }
    return;
  }

  const allEntries: Array<{
    truncatedId: string;
    fullId: string;
    decision: "pass" | "escalate" | "blocked";
    summary: string;
    blockers: DeterministicReviewBlocker[];
  }> = [];

  for (const taskReport of report.taskReports) {
    allEntries.push({
      truncatedId: truncateId(taskReport.taskId),
      fullId: taskReport.taskId,
      decision: decisionFor(taskReport.blockers),
      summary: summarizeBlockers(taskReport.blockers),
      blockers: [...taskReport.blockers],
    });
  }
  for (const blocker of report.loadBlockers) {
    allEntries.push({
      truncatedId: truncateId(blocker.taskId),
      fullId: blocker.taskId,
      decision: "blocked",
      summary: blocker.kind,
      blockers: [blocker],
    });
  }

  if (allEntries.length === 0) return;

  const idWidth = Math.max(4, ...allEntries.map((e) => e.truncatedId.length));
  const decisionWidth = Math.max(
    8,
    ...allEntries.map((e) => `${symbolForDecision(e.decision)} ${e.decision}`.length),
  );
  const rule = "─".repeat(idWidth + decisionWidth + 4);

  console.log(headerBanner().trimEnd());
  console.log(
    `  ${styleCell("TASK", undefined, idWidth)}  ${styleCell("DECISION", undefined, decisionWidth)}  DETAILS`,
  );
  console.log(`  ${rule}`);

  for (const entry of allEntries) {
    const coloredDecision = formatDecisionLabel(entry.decision);
    console.log(
      `  ${styleCell(entry.truncatedId, undefined, idWidth)}  ${styleCell(coloredDecision, undefined, decisionWidth)}  ${entry.summary}`,
    );
  }

  // Detail sections for escalated/blocked tasks
  const blockedEntries = allEntries.filter((e) => e.decision !== "pass");
  if (blockedEntries.length > 0) {
    console.log("");
    for (const entry of blockedEntries) {
      const summary = summarizeBlockers(entry.blockers);
      console.log(`  ── ${entry.truncatedId}  (${summary})`);
      for (const blocker of entry.blockers) {
        const color = colorForBlockerKind(blocker.kind);
        console.log(`    ${color("•")} ${color(blocker.kind)}: ${blocker.reason}`);
      }
    }
  }
}

function runDeepMode(
  specsTasksDir: string,
  cwd: string,
  generatedDir: string,
  report: ReturnType<typeof evaluateDeterministicReviewGate>,
  includeAll: boolean,
  budget: number | undefined,
  deepOnly: ReviewQueueDeepOnly | undefined,
  machine: boolean,
): void {
  if (machine) {
    // Machine-readable tab-delimited deep output
    let emitted = 0;
    let queued = 0;
    let usedBudget = 0;

    for (const taskReport of report.taskReports) {
      const riskFlags = riskFlagsFor(taskReport);
      const gateDecision = decisionFor(taskReport.blockers);
      const decision = gateDecision === "pass" && riskFlags.length > 0 ? "escalate" : gateDecision;

      if (decision === "blocked" || (!includeAll && decision === "pass")) {
        continue;
      }
      if (deepOnly === "risky" && riskFlags.length === 0) {
        continue;
      }

      queued += 1;
      const packet = compressedPacketFor(taskReport);
      const packetCost = estimatedTokens(packet);

      if (budget !== undefined && usedBudget + packetCost > budget) {
        continue;
      }

      const promptPath = createReviewPrompt(taskReport.taskId, specsTasksDir, generatedDir, cwd);
      usedBudget += packetCost;
      emitted += 1;
      console.log(
        [
          decision === "pass" ? "deep-all" : "deep",
          taskReport.taskId,
          `prompt=${rel(cwd, promptPath)}`,
          `packet=${packet}`,
          `reasons=${formatReasons(taskReport.blockers)}`,
          `evidence=${formatDeepEvidence(taskReport)}`,
        ].join("\t"),
      );
    }

    for (const blocker of report.loadBlockers) {
      console.log(`blocked\t${blocker.taskId}\t${blocker.kind}: ${blocker.reason}`);
    }

    const blockedReports = report.taskReports.filter(
      (task) => decisionFor(task.blockers) === "blocked",
    );
    for (const taskReport of blockedReports) {
      console.log(`blocked\t${taskReport.taskId}\t${formatReasons(taskReport.blockers)}`);
    }

    if (emitted === 0 && report.loadBlockers.length === 0 && blockedReports.length === 0) {
      console.log("No tasks escalated for deep review.");
    }

    if (budget !== undefined) {
      console.log(`budget\tlimit=${budget}\tfit=${emitted}/${queued}\testimated=${usedBudget}`);
    }
    return;
  }

  // Formatted deep output with section separators
  console.log(headerBanner().trimEnd());

  let emitted = 0;
  let queued = 0;
  let usedBudget = 0;
  let printedFirst = false;

  for (const taskReport of report.taskReports) {
    const riskFlags = riskFlagsFor(taskReport);
    const gateDecision = decisionFor(taskReport.blockers);
    const decision = gateDecision === "pass" && riskFlags.length > 0 ? "escalate" : gateDecision;

    if (decision === "blocked" || (!includeAll && decision === "pass")) {
      continue;
    }
    if (deepOnly === "risky" && riskFlags.length === 0) {
      continue;
    }

    queued += 1;
    const packet = compressedPacketFor(taskReport);
    const packetCost = estimatedTokens(packet);

    if (budget !== undefined && usedBudget + packetCost > budget) {
      continue;
    }

    const promptPath = createReviewPrompt(taskReport.taskId, specsTasksDir, generatedDir, cwd);
    usedBudget += packetCost;
    emitted += 1;

    if (printedFirst) {
      console.log("");
    }
    printedFirst = true;

    const decisionLabel = formatDecisionLabel(decision);
    const _decisionColor = colorForDecision(decision);
    console.log(
      `  ${picocolors.bold("── Task:")} ${truncateId(taskReport.taskId)} ${picocolors.dim(`(${decisionLabel})`)}`,
    );
    console.log(`  ${picocolors.bold("Prompt:")}  ${rel(cwd, promptPath)}`);
    console.log(`  ${picocolors.bold("Packet:")}`);
    for (const line of formatPacketMultiline(taskReport)) {
      console.log(`    ${line}`);
    }
    console.log(`  ${picocolors.bold("Reasons:")} ${summarizeBlockers(taskReport.blockers)}`);

    const evidenceLines = formatCondensedEvidence(taskReport);
    console.log(`  ${picocolors.bold("Evidence:")}`);
    for (const line of evidenceLines) {
      console.log(`    ${line}`);
    }
    if (riskFlags.length > 0) {
      console.log(`  ${picocolors.bold("Risks:")}   ${riskFlags.join(", ")}`);
    }
  }

  // Print blocked tasks at the bottom
  const blockedReports = report.taskReports.filter(
    (task) => decisionFor(task.blockers) === "blocked",
  );
  const hasBlocked = blockedReports.length > 0 || report.loadBlockers.length > 0;

  if (hasBlocked) {
    if (printedFirst) console.log("");
    console.log(`  ${picocolors.bold(picocolors.red("Blocked tasks:"))}`);
    for (const taskReport of blockedReports) {
      console.log(
        `    ${picocolors.red("⊘")} ${truncateId(taskReport.taskId)}  ${summarizeBlockers(taskReport.blockers)}`,
      );
    }
    for (const blocker of report.loadBlockers) {
      console.log(`    ${picocolors.red("⊘")} ${blocker.taskId}  ${blocker.kind}`);
    }
  }

  if (emitted === 0 && blockedReports.length === 0 && report.loadBlockers.length === 0) {
    console.log("  No tasks escalated for deep review.");
  }

  if (budget !== undefined) {
    const budgetColor = emitted > 0 ? picocolors.green : picocolors.yellow;
    console.log(
      `\n  ${budgetColor(`Budget: limit=${budget}, fit=${emitted}/${queued}, estimated=${usedBudget}`)}`,
    );
  }
}

export function reviewQueueCommand(
  specsTasksDir: string,
  cwd: string,
  options: ReviewQueueCommandOptions = {},
): void {
  const mode = options.mode ?? "triage";
  const generatedDir =
    options.generatedDir ?? join(mancipleRootFrom(specsTasksDir), "prompts", "generated");
  const budget = parseBudget(options.budget);
  const deepOnly = options.deepOnly;

  if (mode !== "triage" && mode !== "deep") {
    console.error(`Unsupported review queue mode: ${mode}. Allowed: triage, deep.`);
    process.exit(1);
  }
  if (deepOnly !== undefined && deepOnly !== "risky") {
    console.error(`Unsupported review queue deep-only filter: ${deepOnly}. Allowed: risky.`);
    process.exit(1);
  }

  const report = evaluateDeterministicReviewGate({
    specsTasksDir,
    cwd,
    generatedDir,
    activeDir: options.activeDir,
    completedDir: options.completedDir,
    archivedDir: options.archivedDir,
  });

  if (report.taskReports.length === 0 && report.loadBlockers.length === 0) {
    console.log("No active needs_review tasks found.");
    return;
  }

  const machine = options.machine ?? false;

  if (mode === "deep") {
    runDeepMode(
      specsTasksDir,
      cwd,
      generatedDir,
      report,
      options.all ?? false,
      budget,
      deepOnly,
      machine,
    );
  } else {
    runTriageMode(report, machine);
    if (budget !== undefined) {
      if (machine) {
        const rows = report.taskReports.length;
        console.log(`budget\tlimit=${budget}\tfit=${rows}/${rows}\testimated=${rows}`);
      } else {
        const rows = report.taskReports.length;
        console.log(`\n  Budget: limit=${budget}, fit=${rows}/${rows}, estimated=${rows}`);
      }
    }
  }

  if (
    report.loadBlockers.length > 0 ||
    report.taskReports.some((task) => decisionFor(task.blockers) === "blocked")
  ) {
    process.exit(1);
  }
}
