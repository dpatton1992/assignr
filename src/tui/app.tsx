import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { Key } from "ink";
import type {
  ReviewDecision,
  ReviewDecisionId,
  ReviewPacket,
  ReviewQueueRow,
  ReviewQueueSummary,
} from "../review/reviewPacket.js";
import type { ReviewService } from "./service.js";
import { buildDiffContent } from "./pager.js";
import type { CommandRunner } from "./pager.js";

/**
 * ReviewTui is the interactive review dashboard.
 *
 * Data boundary: the component reads queue rows and selected-task evidence
 * exclusively through the injected ReviewService (getReviewQueue /
 * getTaskReviewPacket). The `d` key is an explicit user-triggered external
 * action that builds a task-scoped git diff and hands it to the pager
 * callback; git is never read to render the dashboard itself.
 */

export type ViewName = "list" | "detail" | "receipt" | "tests" | "deps";

export type OpenPagerHandler = (content: string) => void;

/** Survives pager round-trips so the launcher can re-render in the same view. */
export interface ReviewTuiSession {
  selectedTaskId: string | null;
  view: ViewName;
  scroll: number;
}

export interface ReviewTuiProps {
  service: ReviewService;
  cwd: string;
  onOpenPager: OpenPagerHandler;
  session?: ReviewTuiSession;
  /** Deterministic detail scroll window for tests. Defaults from stdout rows. */
  windowHeight?: number;
  /** Injectable git runner for the external diff action; tests provide a fake. */
  diffRunner?: CommandRunner;
}

type FlatBucket = "needs_review" | "blocked" | "completed";

interface FlatRow {
  bucket: FlatBucket;
  row: ReviewQueueRow;
}

const BUCKET_ORDER: FlatBucket[] = ["needs_review", "blocked", "completed"];

function flattenQueue(queue: ReviewQueueSummary): FlatRow[] {
  return [
    ...queue.needsReview.rows.map((row) => ({ bucket: "needs_review" as const, row })),
    ...queue.blocked.rows.map((row) => ({ bucket: "blocked" as const, row })),
    ...queue.completed.rows.map((row) => ({ bucket: "completed" as const, row })),
  ];
}

function bucketLabel(bucket: FlatBucket): string {
  switch (bucket) {
    case "needs_review":
      return "Needs review";
    case "blocked":
      return "Blocked";
    case "completed":
      return "Completed";
  }
}

function bucketColor(bucket: FlatBucket): string {
  switch (bucket) {
    case "needs_review":
      return "yellow";
    case "blocked":
      return "red";
    case "completed":
      return "green";
  }
}

function nextStatusFor(action: ReviewDecisionId): string {
  switch (action) {
    case "approve":
      return "complete";
    case "request_changes":
      return "in_progress";
    case "reject":
      return "failed";
    case "block":
      return "blocked";
    case "reopen":
      return "in_progress";
  }
}

function outcomeStatusColor(status: string): string {
  switch (status) {
    case "passed":
      return "green";
    case "failed":
      return "red";
    case "missing":
      return "red";
    default:
      return "yellow";
  }
}

export function formatReceipt(packet: ReviewPacket): string {
  const parts: string[] = [];
  if (packet.receipt.result) parts.push(`result: ${packet.receipt.result}`);
  if (packet.receipt.verificationReceipt) parts.push(packet.receipt.verificationReceipt);
  if (packet.receipt.receiptParseError) parts.push(`receipt parse error: ${packet.receipt.receiptParseError}`);
  if (parts.length === 0) return "No verification receipt on record.";
  return parts.join("\n");
}

function detailLines(packet: ReviewPacket): string[] {
  const lines: string[] = [];
  lines.push(`${packet.taskId} — ${packet.title}`);
  lines.push(
    `status: ${packet.status} (${packet.tier}) · readiness ${packet.readiness.score}/100 · ${
      packet.readiness.ready ? "ready" : "not ready"
    }`
  );
  lines.push(`domain: ${packet.domain} · priority: ${packet.priority}`);
  lines.push("");
  lines.push(`Goal: ${packet.goal}`);
  lines.push("");

  const drift = packet.scopeDrift;
  const driftNote = [
    `${drift.changedPaths.length} changed path(s)`,
    ...(drift.outOfScopePaths.length > 0 ? [`${drift.outOfScopePaths.length} out of scope`] : []),
    ...(drift.forbiddenPaths.length > 0 ? [`${drift.forbiddenPaths.length} forbidden`] : []),
  ].join(" · ");
  lines.push(`Scope drift: ${driftNote}${drift.hasDrift ? "  ⚠ DRIFT" : ""}`);
  for (const path of drift.outOfScopePaths) lines.push(`  out of scope: ${path}`);
  for (const entry of drift.forbiddenPaths) lines.push(`  forbidden: ${entry.path} (${entry.pattern})`);

  const diffStats =
    packet.diffSummary.insertions !== undefined || packet.diffSummary.deletions !== undefined
      ? ` · +${packet.diffSummary.insertions ?? 0} −${packet.diffSummary.deletions ?? 0}`
      : "";
  lines.push(`Changed files: ${packet.diffSummary.changedFileCount} (${packet.diffSummary.source})${diffStats}`);
  for (const changed of packet.changedPaths) {
    lines.push(`  ${changed.source === "run-log" ? "log" : "git"} ${changed.path}`);
  }

  const coveredCount = packet.acceptanceCriteria.filter((criterion) => criterion.covered).length;
  lines.push(`Acceptance: ${coveredCount}/${packet.acceptanceCriteria.length} covered`);
  for (const criterion of packet.acceptanceCriteria) {
    const mark = criterion.covered ? "✓" : "✗";
    const evidence = criterion.evidence ? ` — ${criterion.evidence}` : "";
    lines.push(`  ${mark} ${criterion.criterion}${evidence}`);
  }

  lines.push(`Verification: ${packet.verification.hasVerification ? "recorded" : "none recorded"}`);
  for (const outcome of packet.verification.commandOutcomes) {
    const detail = outcome.detail ? ` (${outcome.detail})` : "";
    lines.push(`  ${outcome.status}: ${outcome.command}${detail}`);
  }

  const risks = packet.risks.length > 0 ? packet.risks.map((risk) => `"${risk}"`).join("; ") : "none documented";
  lines.push(`Risks: ${risks}`);

  const notes = packet.workerNotes;
  const notesParts = [
    `decisions ${notes.decisionsMade.length}`,
    `follow-ups ${notes.followUps.length}`,
    ...(notes.risks ? [`risks: ${notes.risks}`] : []),
    ...(notes.notes ? [`notes: ${notes.notes}`] : []),
  ];
  lines.push(`Worker: ${notesParts.join(" · ")}`);

  const receiptParts = [
    packet.receipt.hasVerificationReceipt ? "verification receipt present" : "no verification receipt",
    ...(packet.receipt.result ? [`result: ${packet.receipt.result}`] : []),
    ...(packet.receipt.receiptParseError ? [`parse error: ${packet.receipt.receiptParseError}`] : []),
  ];
  lines.push(`Receipt: ${receiptParts.join(" · ")}`);

  const dependencies =
    packet.dependencies.length === 0
      ? "none"
      : packet.dependencies.map((dependency) => `${dependency.taskId}:${dependency.status}`).join(", ");
  lines.push(`Dependencies: ${dependencies}`);

  const warnings =
    packet.warnings.length === 0 ? "none" : packet.warnings.map((warning) => `"${warning}"`).join("; ");
  lines.push(`Warnings: ${warnings}`);

  lines.push(
    `Available decisions: ${packet.availableDecisions.map((decision) => decision.id).join(", ") || "none"}`
  );
  return lines;
}

export function ReviewTui(props: ReviewTuiProps): React.ReactElement {
  const { service, cwd, onOpenPager, session, windowHeight, diffRunner } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [queue, setQueue] = useState<ReviewQueueSummary>(() => service.getQueue());
  const [rows, setRows] = useState<FlatRow[]>(() => flattenQueue(service.getQueue()));
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [view, setView] = useState<ViewName>(() => session?.view ?? "list");
  const [packet, setPacket] = useState<ReviewPacket | null>(null);
  const [packetError, setPacketError] = useState<string | null>(null);
  const [scroll, setScroll] = useState(() => session?.scroll ?? 0);
  const [confirmAction, setConfirmAction] = useState<{ action: ReviewDecisionId; decision: ReviewDecision } | null>(null);
  const [reasonAction, setReasonAction] = useState<{ action: "request_changes" | "reject"; decision: ReviewDecision } | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Restore the pre-pager session when the launcher re-renders after a pager
  // round-trip (selected task, view, and scroll position).
  useEffect(() => {
    if (!session?.selectedTaskId || view === "list") return;
    try {
      const loaded = service.getPacket(session.selectedTaskId);
      setPacket(loaded);
      setPacketError(null);
      setScroll(session.scroll ?? 0);
    } catch (error) {
      setPacketError(error instanceof Error ? error.message : String(error));
      setPacket(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the session so the launcher can re-render after opening a pager.
  useEffect(() => {
    if (!session) return;
    session.selectedTaskId = view === "list" ? null : (packet?.taskId ?? session.selectedTaskId);
    session.view = view;
    session.scroll = scroll;
  }, [session, view, packet, scroll]);

  const loadPacket = (taskId: string, initialScroll = 0): void => {
    try {
      const loaded = service.getPacket(taskId);
      setPacket(loaded);
      setPacketError(null);
      setView("detail");
      setScroll(initialScroll);
      setActionError(null);
      setLastAction(null);
    } catch (error) {
      setPacket(null);
      setPacketError(error instanceof Error ? error.message : String(error));
      setView("detail");
      setScroll(0);
    }
  };

  const moveSelection = (delta: number): void => {
    setSelectedIndex((current) => {
      const next = current + delta;
      return Math.max(0, Math.min(next, rows.length - 1));
    });
  };

  const performAction = (action: ReviewDecisionId, reasonValue?: string): void => {
    if (!packet) return;
    const taskId = packet.taskId;
    try {
      const result = service.applyDecision(action, taskId, reasonValue);
      // Refresh the queue from the service after success — never mutate local
      // files or optimistically reorder rows.
      const nextQueue = service.getQueue();
      const nextRows = flattenQueue(nextQueue);
      setQueue(nextQueue);
      setRows(nextRows);
      setSelectedIndex((current) => Math.max(0, Math.min(current, nextRows.length - 1)));
      setLastAction(`${result.outcome}: ${taskId} ${result.previousStatus} → ${result.nextStatus}`);
      setActionError(null);
      setPacket(null);
      setView("list");
      setScroll(0);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const startConfirm = (action: ReviewDecisionId): void => {
    const decision = packet?.availableDecisions.find((candidate) => candidate.id === action);
    if (packet && decision?.enabled) {
      setConfirmAction({ action, decision });
    }
  };

  const startReason = (action: "request_changes" | "reject"): void => {
    const decision = packet?.availableDecisions.find((candidate) => candidate.id === action);
    if (packet && decision?.enabled) {
      setReasonAction({ action, decision });
      setReason("");
      setReasonError(null);
    }
  };

  const openReceipt = (): void => {
    if (!packet) return;
    const content = formatReceipt(packet);
    const lines = content.split("\n").length;
    if (content.length > 4000 || lines > 60) {
      onOpenPager(content);
      return;
    }
    setView("receipt");
    setScroll(0);
  };

  const openExternalDiff = (): void => {
    if (!packet) return;
    onOpenPager(buildDiffContent({ packet, cwd, run: diffRunner }));
  };

  // Keep the input handler stable so useInput subscribes once; the handler
  // itself reads fresh state through a ref on every keystroke.
  const inputHandlerRef = useRef<(input: string, key: Key) => void>(() => {});
  inputHandlerRef.current = (input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }

    if (confirmAction) {
      if (key.escape || input === "n") {
        setConfirmAction(null);
        return;
      }
      if (input === "y") {
        const { action } = confirmAction;
        performAction(action);
        setConfirmAction(null);
      }
      return;
    }

    if (reasonAction) {
      if (key.escape) {
        setReasonAction(null);
        setReason("");
        setReasonError(null);
        return;
      }
      if (key.backspace) {
        setReason((current) => current.slice(0, -1));
        return;
      }
      if (key.return) {
        const trimmed = reason.trim();
        if (!trimmed) {
          setReasonError("A nonblank reason is required.");
          return;
        }
        const { action } = reasonAction;
        performAction(action, trimmed);
        setReasonAction(null);
        setReason("");
        setReasonError(null);
        return;
      }
      if (input && /^[\x20-\x7E\u00A0-\uFFFF]$/.test(input)) {
        setReason((current) => current + input);
      }
      return;
    }

    switch (view) {
      case "list": {
        if (key.escape || input === "q") {
          exit();
          return;
        }
        if (input === "j" || key.downArrow) {
          moveSelection(1);
          return;
        }
        if (input === "k" || key.upArrow) {
          moveSelection(-1);
          return;
        }
        if (key.return) {
          const selected = rows[selectedIndex];
          if (selected) loadPacket(selected.row.taskId);
        }
        return;
      }
      case "detail": {
        if (key.escape || input === "q") {
          setView("list");
          setPacket(null);
          setPacketError(null);
          setActionError(null);
          return;
        }
        if (!packet) return; // packet error state: only q/Escape navigates
        if (input === "j" || key.downArrow) {
          setScroll((current) => current + 1);
          return;
        }
        if (input === "k" || key.upArrow) {
          setScroll((current) => Math.max(0, current - 1));
          return;
        }
        if (input === "d") {
          openExternalDiff();
          return;
        }
        if (input === "r") {
          openReceipt();
          return;
        }
        if (input === "t") {
          setView("tests");
          setScroll(0);
          return;
        }
        if (input === "g") {
          setView("deps");
          setScroll(0);
          return;
        }
        if (input === "a") {
          startConfirm("approve");
          return;
        }
        if (input === "e") {
          startReason("request_changes");
          return;
        }
        if (input === "x") {
          startReason("reject");
          return;
        }
        if (input === "o") {
          startConfirm("reopen");
        }
        return;
      }
      case "receipt":
      case "tests":
      case "deps": {
        if (key.escape || input === "q") {
          setView("detail");
        }
        return;
      }
    }
  };

  useInput((input, key) => inputHandlerRef.current(input, key));

  const terminalRows = stdout.rows;
  const detailWindow = Math.max(
    4,
    Math.min(windowHeight ?? (terminalRows ? terminalRows - 8 : 14), 40)
  );

  let body: React.ReactNode;

  if (confirmAction && packet) {
    body = (
      <Box flexDirection="column">
        <Text bold>Confirm {confirmAction.action}</Text>
        <Text>
          {packet.taskId}: this moves the task from {packet.status} to {nextStatusFor(confirmAction.action)}.
        </Text>
        <Text dimColor>Press y to confirm, n or Escape to cancel.</Text>
      </Box>
    );
  } else if (reasonAction && packet) {
    body = (
      <Box flexDirection="column">
        <Text bold>
          {reasonAction.action === "request_changes" ? "Request changes" : "Reject"} — {packet.taskId}
        </Text>
        <Text>
          This moves the task from {packet.status} to{" "}
          {reasonAction.action === "request_changes" ? "in_progress" : "failed"}.
        </Text>
        <Text>Reason: {reason || " "}</Text>
        {reasonError ? <Text color="red">{reasonError}</Text> : null}
        <Text dimColor>Enter confirms · Escape cancels · backspace edits</Text>
      </Box>
    );
  } else if (view === "list") {
    body = (
      <Box flexDirection="column">
        <Text bold>Review Dashboard</Text>
        <Text dimColor>manciple review — queue triage, evidence, and decisions</Text>
        {lastAction ? <Text color="green">{lastAction}</Text> : null}
        {actionError ? <Text color="red">Action failed: {actionError}</Text> : null}
        {rows.length === 0 ? (
          <Box flexDirection="column">
            <Text>No tasks in needs_review, blocked, or completed.</Text>
            <Text dimColor>Create tasks with `manciple task new` to populate the review queue.</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {BUCKET_ORDER.map((bucket) => {
              const bucketRows = rows.filter((flat) => flat.bucket === bucket);
              if (bucketRows.length === 0) return null;
              const count =
                bucket === "needs_review"
                  ? queue.needsReview.count
                  : bucket === "blocked"
                    ? queue.blocked.count
                    : queue.completed.count;
              return (
                <Box key={bucket} flexDirection="column">
                  <Text bold color={bucketColor(bucket)}>
                    {bucketLabel(bucket)} ({count})
                  </Text>
                  {bucketRows.map((flat) => {
                    const index = rows.indexOf(flat);
                    const selected = index === selectedIndex;
                    return (
                      <Text key={flat.row.taskId} color={selected ? "cyan" : undefined} inverse={selected}>
                        {selected ? "› " : "  "}
                        {flat.row.taskId}  {flat.row.title}  [{flat.row.priority}] {flat.row.domain}
                      </Text>
                    );
                  })}
                </Box>
              );
            })}
          </Box>
        )}
        <Text dimColor>↑↓/jk move · enter inspect · q quit</Text>
      </Box>
    );
  } else if (view === "detail") {
    const lines = packet ? detailLines(packet) : [];
    const visibleLines = lines.slice(scroll, scroll + detailWindow);
    body = (
      <Box flexDirection="column">
        <Text bold color="cyan">
          Reviewing: {packet?.taskId ?? "—"}
        </Text>
        {actionError ? <Text color="red">Action failed: {actionError}</Text> : null}
        {packetError ? <Text color="red">{packetError}</Text> : null}
        {!packet && packetError ? <Text dimColor>Press q or Escape to return to the queue.</Text> : null}
        {packet ? (
          <>
            {visibleLines.map((line, index) => (
              <Text key={scroll + index}>{line}</Text>
            ))}
            <Text dimColor>
              d diff · r receipt · t tests · g deps · a approve · e changes · x reject · o reopen · ↑↓/jk scroll · q
              back
            </Text>
          </>
        ) : null}
      </Box>
    );
  } else if (view === "receipt" && packet) {
    body = (
      <Box flexDirection="column">
        <Text bold>Receipt — {packet.taskId}</Text>
        <Text>{formatReceipt(packet)}</Text>
        <Text dimColor>q or Escape to return</Text>
      </Box>
    );
  } else if (view === "tests" && packet) {
    body = (
      <Box flexDirection="column">
        <Text bold>Tests and commands — {packet.taskId}</Text>
        {packet.verification.requiredCommands.length === 0 ? (
          <Text dimColor>No required verification commands.</Text>
        ) : (
          packet.verification.commandOutcomes.map((outcome) => (
            <Text key={outcome.command} color={outcomeStatusColor(outcome.status)}>
              {outcome.status}: {outcome.command}
              {outcome.detail ? ` (${outcome.detail})` : ""}
            </Text>
          ))
        )}
        <Text dimColor>q or Escape to return</Text>
      </Box>
    );
  } else if (view === "deps" && packet) {
    body = (
      <Box flexDirection="column">
        <Text bold>Dependencies — {packet.taskId}</Text>
        {packet.dependencies.length === 0 ? (
          <Text dimColor>No declared dependencies.</Text>
        ) : (
          packet.dependencies.map((dependency) => (
            <Text key={dependency.taskId} color={dependency.complete ? "green" : "yellow"}>
              {dependency.complete ? "✓" : "…"} {dependency.taskId} ({dependency.status})
            </Text>
          ))
        )}
        <Text dimColor>q or Escape to return</Text>
      </Box>
    );
  } else {
    body = (
      <Box flexDirection="column">
        <Text dimColor>Loading review queue…</Text>
      </Box>
    );
  }

  return <Box flexDirection="column">{body}</Box>;
}
