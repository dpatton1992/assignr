import { loadTasks } from "../specs/loadTasks.js";
import { buildCoordinatorQueue } from "../coordination/reviewQueue.js";
import type { CoordinatorQueueRow } from "../coordination/reviewQueue.js";
import { colorForStatus, styleCell, statusSymbol } from "../utils/styling.js";
import picocolors from "picocolors";

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, width - 3)}...`;
}

const SECTION_COLORS: Record<string, (s: string) => string> = {
  runnable: picocolors.green,
  waiting: picocolors.gray,
  needs_review: picocolors.blue,
  "complete-ready": picocolors.green,
  blocked: picocolors.red,
  "rework-needed": picocolors.yellow,
};

const SECTION_BULLETS: Record<string, string> = {
  runnable: "▶",
  waiting: "○",
  needs_review: "◆",
  "complete-ready": "✓",
  blocked: "⊘",
  "rework-needed": "◐",
};

function printSection(label: string, rows: CoordinatorQueueRow[]): void {
  const sectionColor = SECTION_COLORS[label] ?? picocolors.white;
  const bullet = SECTION_BULLETS[label] ?? "•";
  console.log(`\n${sectionColor(`${bullet} ${label}`)}`);
  console.log(sectionColor("-".repeat(label.length + 2)));

  if (rows.length === 0) {
    console.log("  none");
    return;
  }

  const idWidth = Math.max("ID".length, ...rows.map((item) => item.id.length));
  const statusWidth = Math.max("STATUS".length, ...rows.map((item) => item.status.length));
  const priorityWidth = Math.max("PRIORITY".length, ...rows.map((item) => item.priority.length));

  console.log(
    `  ${styleCell("ID", undefined, idWidth)}  ${styleCell("STATUS", undefined, statusWidth)}  ${styleCell("PRIORITY", undefined, priorityWidth)}  REASON`
  );
  for (const row of rows) {
    const coloredStatus = colorForStatus(row.status)(pad(row.status, statusWidth));
    console.log(
      `  ${pad(row.id, idWidth)}  ${coloredStatus}  ${pad(row.priority, priorityWidth)}  ${truncate(row.reason, 96)}`
    );
  }
}

export function coordinatorCommand(
  specsTasksDir: string,
  _cwd: string,
  options: { dependenciesRequireComplete?: boolean } = {},
): void {
  const { tasks, errors } = loadTasks(specsTasksDir, "all");

  if (errors.length > 0) {
    console.warn(
      `  Warning: ${errors.length} task file(s) could not be loaded (run "manciple validate" for details).`
    );
  }

  const queue = buildCoordinatorQueue(tasks, options);
  const sections: Array<[string, CoordinatorQueueRow[]]> = [
    ["runnable", queue.runnable],
    ["waiting", queue.waiting],
    ["needs_review", queue.needsReview],
    ["complete-ready", queue.completeReady],
    ["blocked", queue.blocked],
    ["rework-needed", queue.reworkNeeded],
  ];

  console.log("Manciple Coordinator Queue");
  for (const [label, rows] of sections) {
    printSection(label, rows);
  }
}
