import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { extractRunLogSection, parseRunLogListSection } from "../review/evidence.js";

interface RunLogRecord {
  path: string;
  content: string;
  taskId: string;
  agent?: string;
  model?: string;
  commandsRun: string[];
  testsRun: string[];
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

interface CountedUsage {
  name: string;
  count: number;
}

export interface RunCostSummary {
  taskCount: number;
  runCount: number;
  agents: CountedUsage[];
  models: CountedUsage[];
  commandsRecorded: number;
  testsRecorded: number;
  tokenRuns: number;
  costRuns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

function increment(counts: Map<string, number>, value: string | undefined): void {
  if (!value) return;
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

function countedUsage(counts: Map<string, number>): CountedUsage[] {
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function parseMetadataValue(content: string, label: string): string | undefined {
  const pattern = new RegExp(`^- ${label}(?: \\([^)]+\\))?:\\s*(.+)$`, "m");
  const value = pattern.exec(content)?.[1]?.trim();
  if (!value || value.startsWith("Unknown:")) return undefined;
  return value;
}

function parseNumberLine(content: string, label: string): number | undefined {
  const pattern = new RegExp(`^- ${label}:\\s*([0-9]+(?:\\.[0-9]+)?)\\s*$`, "m");
  const value = pattern.exec(content)?.[1];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function taskIdFromFilename(filePath: string): string {
  return basename(filePath)
    .replace(/\.md$/, "")
    .replace(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-/, "")
    .replace(/-review-outcome$/, "");
}

function discoverRunLogPaths(runsDir: string): string[] {
  if (!existsSync(runsDir)) return [];

  return readdirSync(runsDir)
    .flatMap((entry) => {
      const fullPath = join(runsDir, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        return readdirSync(fullPath)
          .filter((file) => file.endsWith(".md"))
          .map((file) => join(fullPath, file));
      }
      return entry.endsWith(".md") ? [fullPath] : [];
    })
    .sort();
}

function parseRunLog(filePath: string): RunLogRecord {
  const content = readFileSync(filePath, "utf-8");
  return {
    path: filePath,
    content,
    taskId: parseMetadataValue(content, "Task ID") ?? taskIdFromFilename(filePath),
    agent: parseMetadataValue(content, "Agent/Harness"),
    model: parseMetadataValue(content, "Model"),
    commandsRun: parseRunLogListSection(extractRunLogSection(content, "Commands Run")),
    testsRun: parseRunLogListSection(extractRunLogSection(content, "Tests Run")),
    inputTokens: parseNumberLine(content, "Input tokens"),
    outputTokens: parseNumberLine(content, "Output tokens"),
    totalTokens: parseNumberLine(content, "Total tokens"),
    costUsd: parseNumberLine(content, "Cost USD"),
  };
}

export function summarizeRunCost(runsDir: string, taskId?: string): RunCostSummary {
  const records = discoverRunLogPaths(runsDir)
    .map(parseRunLog)
    .filter((record) => record.content.startsWith("# Run Log:"))
    .filter((record) => !taskId || record.taskId === taskId);
  const agents = new Map<string, number>();
  const models = new Map<string, number>();

  let commandsRecorded = 0;
  let testsRecorded = 0;
  let tokenRuns = 0;
  let costRuns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costUsd = 0;

  for (const record of records) {
    increment(agents, record.agent);
    increment(models, record.model);
    commandsRecorded += record.commandsRun.length;
    testsRecorded += record.testsRun.length;

    const hasTokenEvidence =
      record.inputTokens !== undefined ||
      record.outputTokens !== undefined ||
      record.totalTokens !== undefined;
    if (hasTokenEvidence) {
      tokenRuns += 1;
      inputTokens += record.inputTokens ?? 0;
      outputTokens += record.outputTokens ?? 0;
      totalTokens += record.totalTokens ?? (record.inputTokens ?? 0) + (record.outputTokens ?? 0);
    }

    if (record.costUsd !== undefined) {
      costRuns += 1;
      costUsd += record.costUsd;
    }
  }

  return {
    taskCount: new Set(records.map((record) => record.taskId)).size,
    runCount: records.length,
    agents: countedUsage(agents),
    models: countedUsage(models),
    commandsRecorded,
    testsRecorded,
    tokenRuns,
    costRuns,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
  };
}

function renderUsage(values: CountedUsage[]): string {
  if (values.length === 0) return "- Unknown: no evidence recorded.";
  return values.map((value) => `- ${value.name}: ${value.count}`).join("\n");
}

export function renderRunCostSummary(summary: RunCostSummary, taskId?: string): string {
  const tokenCoverage =
    summary.runCount === 0
      ? "Unknown: no run logs found."
      : summary.tokenRuns === 0
        ? "Unknown: no token evidence recorded."
        : `${summary.tokenRuns}/${summary.runCount} run(s) include token evidence.`;
  const costCoverage =
    summary.runCount === 0
      ? "Unknown: no run logs found."
      : summary.costRuns === 0
        ? "Unknown: no cost evidence recorded."
        : `${summary.costRuns}/${summary.runCount} run(s) include cost evidence.`;

  return `# Run Cost Summary${taskId ? `: ${taskId}` : ""}

- Task count: ${summary.taskCount}
- Run count: ${summary.runCount}
- Commands recorded: ${summary.commandsRecorded}
- Tests recorded: ${summary.testsRecorded}

## Agent/Harness Usage

${renderUsage(summary.agents)}

## Model Usage

${renderUsage(summary.models)}

## Token Evidence

- Coverage: ${tokenCoverage}
- Input tokens: ${summary.tokenRuns > 0 ? summary.inputTokens : "Unknown"}
- Output tokens: ${summary.tokenRuns > 0 ? summary.outputTokens : "Unknown"}
- Total tokens: ${summary.tokenRuns > 0 ? summary.totalTokens : "Unknown"}

## Cost Evidence

- Coverage: ${costCoverage}
- Cost USD: ${summary.costRuns > 0 ? summary.costUsd.toFixed(6) : "Unknown"}
`;
}

export function summarizeRunCostCommand(runsDir: string, taskId?: string): void {
  console.log(renderRunCostSummary(summarizeRunCost(runsDir, taskId), taskId));
}
