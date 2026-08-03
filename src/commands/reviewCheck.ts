import picocolors from "picocolors";
import type {
  DeterministicReviewBlocker,
  DeterministicReviewBlockerKind,
} from "../review/deterministicGate.js";
import { evaluateDeterministicReviewGate } from "../review/deterministicGate.js";
import {
  parseRunLogEvidence,
  readGitChangedFiles,
  readLatestRunLogContent,
} from "../review/evidence.js";
import { evaluateReviewReadiness } from "../review/readiness.js";
import { loadTasks } from "../specs/loadTasks.js";
import { headerBanner, styleCell } from "../utils/styling.js";

export interface ReviewCheckCommandOptions {
  deterministic?: boolean;
  machine?: boolean;
  generatedDir?: string;
  activeDir?: string;
  completedDir?: string;
  archivedDir?: string;
}

function printTableHeader(idWidth: number, statusWidth: number): void {
  const rule = "─".repeat(idWidth + statusWidth + 4);
  console.log(
    `  ${styleCell("TASK", undefined, idWidth)}  ${styleCell("STATUS", undefined, statusWidth)}  SCORE  HUMAN REVIEW  DETAILS`,
  );
  console.log(`  ${rule}`);
}

function formatScore(score: number, width: number = 5): string {
  return String(score).padStart(width);
}

function truncateId(id: string): string {
  if (id.length <= 45) return id;
  return `${id.slice(0, 45)}…`;
}

const BLOCKED_KINDS_FOR_DECISION = new Set<DeterministicReviewBlockerKind>([
  "load-error",
  "lifecycle-placement",
  "status-mismatch",
  "blocked-dependency",
  "completed-active",
  "active-wrong-directory",
]);

function decisionFor(blockers: DeterministicReviewBlocker[]): "pass" | "escalate" | "blocked" {
  if (blockers.length === 0) return "pass";
  return blockers.some((blocker) => BLOCKED_KINDS_FOR_DECISION.has(blocker.kind))
    ? "blocked"
    : "escalate";
}

function summarizeBlockers(blockers: DeterministicReviewBlocker[]): string {
  if (blockers.length === 0) return "deterministic=pass";
  const counts = new Map<DeterministicReviewBlockerKind, number>();
  for (const blocker of blockers) {
    counts.set(blocker.kind, (counts.get(blocker.kind) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) => `${count} ${kind}`).join(", ");
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

export function reviewCheckCommand(
  specsTasksDir: string,
  cwd: string,
  taskId?: string,
  options: ReviewCheckCommandOptions = {},
): void {
  if (options.deterministic) {
    const report = evaluateDeterministicReviewGate({
      specsTasksDir,
      cwd,
      taskId,
      generatedDir: options.generatedDir,
      activeDir: options.activeDir,
      completedDir: options.completedDir,
      archivedDir: options.archivedDir,
    });

    const blockers = [
      ...report.loadBlockers,
      ...report.taskReports.flatMap((taskReport) => taskReport.blockers),
    ];

    if (taskId && report.taskReports.length === 0) {
      console.error(
        `Task not found: ${taskId}\nRun "manciple list --status needs_review" to see review tasks.`,
      );
      process.exit(1);
    }

    // --machine mode: tab-delimited backward compat
    if (options.machine) {
      for (const taskReport of report.taskReports) {
        if (taskReport.blockers.length === 0) {
          console.log(`ready\t${taskReport.taskId}\tdeterministic=pass`);
        } else {
          for (const blocker of taskReport.blockers) {
            console.log(`blocked\t${blocker.taskId}\t${blocker.kind}\t${blocker.reason}`);
          }
        }
        for (const advisory of taskReport.advisories) {
          console.log(`warning\t${advisory.taskId}\t${advisory.kind}\t${advisory.reason}`);
        }
      }
      for (const blocker of report.loadBlockers) {
        console.log(`blocked\t${blocker.taskId}\t${blocker.kind}\t${blocker.reason}`);
      }
      if (blockers.length > 0) {
        process.exit(1);
      }
      return;
    }

    // Formatted deterministic output
    console.log(headerBanner().trimEnd());

    // Build one entry per task (not per blocker)
    interface DeterministicEntry {
      truncatedId: string;
      fullId: string;
      gate: string;
      summary: string;
      blockers: DeterministicReviewBlocker[];
      decision: "pass" | "blocked" | "escalate";
    }

    const gateEntries: DeterministicEntry[] = [];

    for (const taskReport of report.taskReports) {
      const decision = decisionFor(taskReport.blockers);
      const truncatedId = truncateId(taskReport.taskId);

      if (decision === "pass") {
        gateEntries.push({
          truncatedId,
          fullId: taskReport.taskId,
          gate: `${picocolors.green("✓")} pass`,
          summary: "deterministic=pass",
          blockers: [],
          decision,
        });
      } else {
        const summary = summarizeBlockers(taskReport.blockers);
        const gateText =
          decision === "blocked"
            ? `${picocolors.red("⊘")} blocked`
            : `${picocolors.yellow("◐")} escalate`;
        gateEntries.push({
          truncatedId,
          fullId: taskReport.taskId,
          gate: gateText,
          summary,
          blockers: [...taskReport.blockers],
          decision,
        });
      }
    }

    for (const blocker of report.loadBlockers) {
      const truncatedId = truncateId(blocker.taskId);
      gateEntries.push({
        truncatedId,
        fullId: blocker.taskId,
        gate: `${picocolors.red("⊘")} blocked`,
        summary: blocker.kind,
        blockers: [blocker],
        decision: "blocked",
      });
    }

    if (gateEntries.length === 0) {
      console.log(
        taskId
          ? `  No needs_review task matched ${taskId}.`
          : "  No active needs_review tasks found.",
      );
      return;
    }

    // Print table (one row per task)
    const idWidth = Math.max(4, ...gateEntries.map((e) => e.truncatedId.length));
    const gateLabel = "GATE";
    const gateWidth = Math.max(gateLabel.length, ...gateEntries.map((e) => e.gate.length));
    const rule = "─".repeat(idWidth + gateWidth + 4);
    console.log(
      `  ${styleCell("TASK", undefined, idWidth)}  ${styleCell(gateLabel, undefined, gateWidth)}  BLOCKERS`,
    );
    console.log(`  ${rule}`);
    for (const entry of gateEntries) {
      console.log(
        `  ${styleCell(entry.truncatedId, undefined, idWidth)}  ${styleCell(entry.gate, undefined, gateWidth)}  ${entry.summary}`,
      );
    }

    // Print detail sections for blocked/escalated tasks
    const blockedEntries = gateEntries.filter((e) => e.decision !== "pass");
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

    const advisories = report.taskReports.flatMap((taskReport) => taskReport.advisories);
    if (advisories.length > 0) {
      console.log("");
      console.log(`  ${picocolors.yellow("Advisories")}`);
      for (const advisory of advisories) {
        console.log(`    ${picocolors.yellow("•")} ${advisory.taskId}: ${advisory.reason}`);
      }
    }

    if (blockers.length > 0) {
      process.exit(1);
    }
  }

  const { tasks, errors } = loadTasks(specsTasksDir);

  if (errors.length > 0) {
    console.warn(`  ⚠ ${errors.length} task(s) failed to load.`);
  }

  if (taskId && !tasks.some((task) => task.spec.id === taskId)) {
    console.error(
      `Task not found: ${taskId}\nRun "manciple list --status needs_review" to see review tasks.`,
    );
    process.exit(1);
  }

  const reviewTasks = tasks.filter(
    (task) => task.spec.status === "needs_review" && (!taskId || task.spec.id === taskId),
  );

  if (reviewTasks.length === 0) {
    console.log(
      taskId
        ? `  No needs_review task matched ${taskId}.`
        : "  No active needs_review tasks found.",
    );
    return;
  }

  const gitChangedFiles = readGitChangedFiles(cwd);
  let hasMissingEvidence = false;

  // --machine mode: tab-delimited backward compat
  if (options.machine) {
    for (const task of reviewTasks) {
      const report = evaluateReviewReadiness(task, {
        runLogs: parseRunLogEvidence(readLatestRunLogContent(cwd, task.spec.id)),
        gitChangedFiles,
      });
      if (!report.ready) {
        hasMissingEvidence = true;
      }
      const status = report.ready ? "ready" : "missing";
      const detail = report.ready
        ? report.humanReviewNeeded
          ? report.humanReviewReasons.join(" ")
          : "human review not required by evidence checklist"
        : report.missingEvidence.join(" ");
      console.log(
        `${status}\t${task.spec.id}\tscore=${report.score}\thuman_review=${report.humanReviewNeeded ? "yes" : "no"}\t${detail}`,
      );
    }
    if (hasMissingEvidence) {
      process.exit(1);
    }
    return;
  }

  // Formatted output
  console.log(headerBanner().trimEnd());

  const idWidth = Math.max(4, ...reviewTasks.map((t) => t.spec.id.length));
  const statusWidth = Math.max(6, ...reviewTasks.map(() => 8)); // "✓ ready" or "✕ missing"
  printTableHeader(idWidth, statusWidth);

  for (const task of reviewTasks) {
    const report = evaluateReviewReadiness(task, {
      runLogs: parseRunLogEvidence(readLatestRunLogContent(cwd, task.spec.id)),
      gitChangedFiles,
    });

    if (!report.ready) {
      hasMissingEvidence = true;
    }

    const statusLabel = report.ready
      ? `${picocolors.green("✓")} ready`
      : `${picocolors.red("✕")} missing`;
    const hrLabel = report.humanReviewNeeded ? picocolors.yellow("yes") : "no";
    const detail = report.ready
      ? report.humanReviewNeeded
        ? report.humanReviewReasons.join(" ")
        : "human review not required by evidence checklist"
      : report.missingEvidence.join(" ");
    console.log(
      `  ${styleCell(task.spec.id, undefined, idWidth)}  ${styleCell(statusLabel, undefined, statusWidth)}  ${formatScore(report.score)}  ${styleCell(hrLabel, undefined, 11)}  ${detail}`,
    );
  }

  if (hasMissingEvidence) {
    process.exit(1);
  }
}
