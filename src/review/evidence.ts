import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import type { ReviewReadinessAcceptanceEvidence, ReviewReadinessRunLog } from "./readiness.js";

/**
 * Find the path to the latest run log for a given task.
 * Checks nested `.manciple/runs/<taskId>/` first, then flat `.manciple/runs/<timestamp>-<taskId>.md`.
 * Among candidate files, prefers one with `- latest: true` in its metadata,
 * falling back to filename sort order for backward compatibility.
 */
export function findLatestRunLogPath(cwd: string, taskId: string): string | undefined {
  const runsDir = join(cwd, ".manciple", "runs");
  const taskRunLogDir = join(runsDir, taskId);

  let candidates: string[] = [];

  if (existsSync(taskRunLogDir)) {
    candidates = readdirSync(taskRunLogDir)
      .filter((file) => file.endsWith(".md"))
      .sort()
      .map((file) => join(taskRunLogDir, file));
  } else if (existsSync(runsDir)) {
    candidates = readdirSync(runsDir)
      .filter((file) => file.endsWith(`-${taskId}.md`))
      .sort()
      .map((file) => join(runsDir, file));
  }

  if (candidates.length === 0) return undefined;

  // Prefer files with `- latest: true` in metadata
  const latestMarked = candidates.filter((file) => {
    try {
      const content = readFileSync(file, "utf-8");
      const metaLines = extractMetadataSection(content);
      return metaLines.some((line) => /^-\s*Latest:\s*true\s*$/i.test(line));
    } catch {
      return false;
    }
  });

  if (latestMarked.length > 0) {
    // If multiple (shouldn't happen), take the one with latest timestamp
    return latestMarked.at(-1);
  }

  // Fall back to sort order
  return candidates.at(-1);
}

function extractMetadataSection(content: string): string[] {
  const lines = content.split("\n");
  const meta: string[] = [];
  let inMeta = false;

  for (const line of lines) {
    if (line.startsWith("## Metadata")) {
      inMeta = true;
      continue;
    }
    if (inMeta) {
      if (line.startsWith("## ")) break;
      if (line.startsWith("- ")) meta.push(line.trim());
    }
  }

  return meta;
}

/**
 * Mark a run log file as superseded by injecting a `- Superseded by: <filename>` line
 * into its Metadata section.
 */
export function markRunLogSuperseded(filePath: string, supersedingFilename: string): void {
  const content = readFileSync(filePath, "utf-8");
  const marker = `- Superseded by: ${supersedingFilename}`;

  if (content.includes(marker)) return; // already marked

  const lines = content.split("\n");
  let metaHeaderIndex = -1;
  let metaEndIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## Metadata")) {
      metaHeaderIndex = i;
      // Find the end of the metadata section (next heading or end of file)
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith("## ")) {
          metaEndIndex = j;
          break;
        }
      }
      if (metaEndIndex === -1) {
        // No subsequent heading — append at end of file
        metaEndIndex = lines.length;
      }
      break;
    }
  }

  if (metaHeaderIndex >= 0 && metaEndIndex > metaHeaderIndex) {
    const updated = [
      ...lines.slice(0, metaEndIndex),
      marker,
      ...lines.slice(metaEndIndex),
    ].join("\n");
    writeFileSync(filePath, updated, "utf-8");
  }
}

/**
 * Check if a run log content has been superseded.
 */
export function isRunLogSuperseded(content: string): boolean {
  return /^-\s*Superseded by:\s+/m.test(content);
}

/**
 * Check if a run log content marks itself as the latest.
 */
export function isRunLogLatest(content: string): boolean {
  return /^-\s*Latest:\s*true\s*$/m.test(content);
}

export function readLatestRunLogContent(cwd: string, taskId: string): string | undefined {
  const latestPath = findLatestRunLogPath(cwd, taskId);

  if (!latestPath) {
    return undefined;
  }

  return readFileSync(latestPath, "utf-8").trim();
}

export function readGitChangedFiles(cwd: string): string[] {
  const result = spawnSync("git", ["status", "--short", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((path) => {
      const renameMarker = " -> ";
      return path.includes(renameMarker) ? path.split(renameMarker).pop() ?? path : path;
    })
    .filter(Boolean);
}

export function extractRunLogSection(content: string, heading: string): string {
  const pattern = new RegExp(`^## ${heading}\\s*$`, "m");
  const match = pattern.exec(content);
  if (!match) return "";

  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const nextHeading = rest.search(/^## /m);
  return (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
}

export function parseRunLogListSection(section: string): string[] {
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function parseValueSection(section: string): string | undefined {
  const value = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("_Source:") && !line.startsWith("<!--"))
    .join("\n")
    .trim();

  if (!value || value.startsWith("Unknown:") || value === "TODO") {
    return undefined;
  }

  return value;
}

function parseAcceptanceEvidence(section: string): ReviewReadinessAcceptanceEvidence[] {
  return parseRunLogListSection(section).map((line) => {
    const separator = line.includes("=>") ? "=>" : ":";
    const [criterion, ...evidenceParts] = line.split(separator);
    return {
      criterion: criterion.trim(),
      evidence: evidenceParts.join(separator).trim() || undefined,
    };
  }).filter((entry) => entry.criterion);
}

function verificationOutcome(value: string): "passed" | "failed" | undefined {
  const outcomes = [...value.matchAll(
    /\b(pass(?:ed|ing)?|ok|success(?:ful)?|fail(?:ed|ing)?|error|non[- ]?zero|exit(?:ed)?\s+(?:code\s+)?\d+)\b/gi
  )];
  const last = outcomes.at(-1)?.[1]?.toLowerCase();
  if (!last) return undefined;
  if (/^(?:pass|ok|success)/.test(last)) return "passed";
  if (/^exit/.test(last)) return /\b0$/.test(last) ? "passed" : "failed";
  return "failed";
}

function parseCommandReceipt(
  line: string
): NonNullable<ReviewReadinessRunLog["commandResults"]>[number] | undefined {
  const separated = line.match(/^(.*)(?::\s*|\s+(?:->|=>|[-–—])\s+)(.+)$/);
  const parenthesized = line.match(/^(.*?)\s+\((.+)\)$/);
  const match = separated ?? parenthesized;
  if (!match) return undefined;

  const [, command, result] = match;
  const status = verificationOutcome(result);
  if (!command.trim() || !status) return undefined;
  return { command: command.trim(), result: result.trim(), status };
}

function parseVerificationReceipt(section: string): Pick<
  ReviewReadinessRunLog,
  "verificationReceipt" | "verificationReceiptParseError" | "verificationCommands" | "verificationResults" | "commandResults"
> {
  const verificationReceipt = parseValueSection(section);
  if (!verificationReceipt) return {};

  try {
    const parsed: unknown = JSON.parse(verificationReceipt);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }

    const receipt = parsed as Record<string, unknown>;
    const rawCommands = Array.isArray(receipt.commands_run) ? receipt.commands_run : [];
    const commandResults = rawCommands.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const commandReceipt = entry as Record<string, unknown>;
      if (typeof commandReceipt.command !== "string") return [];
      const ok = typeof commandReceipt.ok === "boolean"
        ? commandReceipt.ok
        : typeof commandReceipt.exit_code === "number"
          ? commandReceipt.exit_code === 0
          : undefined;
      return [{
        command: commandReceipt.command,
        status: ok === undefined ? undefined : ok ? "passed" : "failed",
        result: typeof commandReceipt.exit_code === "number"
          ? `exit code ${commandReceipt.exit_code}`
          : undefined,
      }];
    });
    const ok = typeof receipt.ok === "boolean" ? receipt.ok : undefined;

    if (ok === undefined && commandResults.length === 0) {
      throw new Error("expected an ok field or commands_run receipts");
    }

    return {
      verificationReceipt,
      verificationCommands: commandResults.map((entry) => entry.command),
      verificationResults: ok === undefined ? undefined : [ok ? "passed" : "failed"],
      commandResults,
    };
  } catch (error) {
    const humanReadableOk = verificationReceipt.match(/\bok\s*[:=]\s*(true|false)\b/i)?.[1];
    if (humanReadableOk) {
      return {
        verificationReceipt,
        verificationResults: [humanReadableOk.toLowerCase() === "true" ? "passed" : "failed"],
      };
    }

    return {
      verificationReceipt,
      verificationReceiptParseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function parseRunLogEvidence(content: string | undefined): ReviewReadinessRunLog[] {
  if (!content) {
    return [];
  }

  const testsRun = parseRunLogListSection(extractRunLogSection(content, "Tests Run"));
  const commandsRun = parseRunLogListSection(extractRunLogSection(content, "Commands Run"));
  const verification = parseVerificationReceipt(extractRunLogSection(content, "Verification Receipt"));
  const textCommandResults = [...commandsRun, ...testsRun]
    .map(parseCommandReceipt)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  return [{
    filesChanged: parseRunLogListSection(extractRunLogSection(content, "Files Changed")),
    testsRun,
    commandsRun,
    ...verification,
    commandResults: [...textCommandResults, ...(verification.commandResults ?? [])],
    decisionsMade: parseRunLogListSection(extractRunLogSection(content, "Decisions Made")),
    result: parseValueSection(extractRunLogSection(content, "Result")),
    risks: parseValueSection(extractRunLogSection(content, "Risks")),
    followUps: parseRunLogListSection(extractRunLogSection(content, "Follow-Up Tasks")),
    acceptanceCriteriaEvidence: parseAcceptanceEvidence(extractRunLogSection(content, "Acceptance Criteria Evidence")),
    notes: parseValueSection(extractRunLogSection(content, "Notes")),
    tokenEstimate: parseValueSection(extractRunLogSection(content, "Token Estimate")),
  }];
}
