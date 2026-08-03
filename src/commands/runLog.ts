import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, basename } from "path";
import { spawnSync } from "child_process";
import { loadTasks } from "../specs/loadTasks.js";
import { findLatestRunLogPath, markRunLogSuperseded } from "../review/evidence.js";
import { findManagedWorktreeByWorkspace } from "../worktrees/manager.js";

export interface RunLogOptions {
  result?: string;
  taskStatus?: string;
  model?: string;
  agent?: string;
  harness?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  commandsRun?: string[];
  testsRun?: string[];
  filesChanged?: string[];
  decisionsMade?: string[];
  risks?: string;
  followUps?: string[];
  acceptanceCriteriaEvidence?: string[];
  verifyReceipt?: string;
  notes?: string;
  /** Filename of the run log this one supersedes, if any. */
  supersedes?: string;
  /** Managed-worktree base used to include already committed task changes. */
  gitBaseSha?: string;
  /** Git checkout used for evidence while durable state remains in the control repo. */
  evidenceCwd?: string;
}

export interface RunLogEvidenceContext {
  cwd: string;
  baseSha?: string;
}

export function resolveRunLogEvidence(
  taskId: string,
  workspace: string | undefined,
  options: {
    controlRepo: string;
    worktreesDir: string;
    specsTasksDir: string;
  },
): RunLogEvidenceContext {
  if (!workspace) return { cwd: options.controlRepo };

  const record = findManagedWorktreeByWorkspace(workspace, {
    controlRepo: options.controlRepo,
    worktreesDir: options.worktreesDir,
    specsTasksDir: options.specsTasksDir,
  });
  if (!record || record.taskId !== taskId) {
    throw new Error(`Workspace is not the managed worktree for task ${taskId}: ${workspace}`);
  }
  return { cwd: record.workspacePath, baseSha: record.baseSha };
}

interface AutoDetectedFiles {
  files: string[];
  source: string;
  fallback: string;
}

export function timestamp(): string {
  return new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace("T", "-")
    .replace(/\./, "-")
    .replace("Z", "");
}

export function currentBranch(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    encoding: "utf-8",
  });
  if (result.status !== 0 || !result.stdout) return "unknown";
  return result.stdout.trim() || "unknown";
}

function parseGitStatus(output: string): string[] {
  return output
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

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function detectChangedFiles(cwd: string, baseSha?: string): AutoDetectedFiles {
  if (baseSha) {
    const commands = [
      ["diff", "--name-only", `${baseSha}...HEAD`],
      ["diff", "--name-only"],
      ["diff", "--cached", "--name-only"],
      ["ls-files", "--others", "--exclude-standard"],
    ];
    const files = unique(commands.flatMap((args) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
      return result.status === 0 ? (result.stdout ?? "").split("\n") : [];
    }));
    return {
      files,
      source: `auto-detected from managed worktree diff since ${baseSha}`,
      fallback: files.length > 0
        ? ""
        : `No changed files detected since managed worktree base ${baseSha}.`,
    };
  }

  const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], {
    cwd,
    encoding: "utf-8",
  });

  if (status.status === 0) {
    const files = unique(parseGitStatus(status.stdout ?? ""));
    return {
      files,
      source: "auto-detected from git status",
      fallback: files.length > 0
        ? ""
        : "No changed files detected by git status.",
    };
  }

  const diff = spawnSync("git", ["diff", "--name-only"], {
    cwd,
    encoding: "utf-8",
  });

  if (diff.status === 0) {
    const files = unique((diff.stdout ?? "").split("\n"));
    return {
      files,
      source: "auto-detected from git diff --name-only",
      fallback: files.length > 0
        ? ""
        : "No changed files detected by git diff --name-only.",
    };
  }

  return {
    files: [],
    source: "unknown",
    fallback: "Unknown: git is unavailable or this directory is not a git repository.",
  };
}

function renderList(values: string[] | undefined, source: string, unknownText: string): string {
  if (values?.length) {
    return [`_Source: ${source}_`, "", ...values.map((value) => `- ${value}`)].join("\n");
  }

  return [`_Source: unknown_`, "", unknownText].join("\n");
}

export function buildRunLog(
  title: string,
  id: string,
  status: string,
  generatedDir: string,
  cwd: string,
  options: RunLogOptions = {}
): string {
  const promptPath = `${generatedDir}/${id}.md`;
  const branch = currentBranch(cwd);
  const finalStatus = options.taskStatus ?? status;
  const detected = detectChangedFiles(cwd, options.gitBaseSha);
  const filesChanged = options.filesChanged?.length
    ? renderList(unique(options.filesChanged), "provided by user", "Unknown: no changed files were provided.")
    : renderList(detected.files, detected.source, detected.fallback);
  const commandsRun = renderList(
    options.commandsRun,
    "provided by user",
    "Unknown: no commands were provided. Pass repeated --command flags or MCP commands_run values."
  );
  const testsRun = renderList(
    options.testsRun,
    "provided by user",
    "Unknown: no tests were provided. Pass test commands in tests_run or provide a deterministic verify receipt."
  );
  const decisionsMade = renderList(
    options.decisionsMade,
    "provided by user",
    "Unknown: no decisions were provided. Completed implementation work that changed behavior must record Decisions Made; omit only when blocked before meaningful changes."
  );
  const followUps = renderList(
    options.followUps,
    "provided by user",
    "Unknown: not provided."
  );
  const acceptanceCriteriaEvidence = renderList(
    options.acceptanceCriteriaEvidence,
    "provided by user",
    "Unknown: not provided."
  );
  const verifyReceipt = options.verifyReceipt
    ? `_Source: provided by user_\n\n${options.verifyReceipt}`
    : "_Source: unknown_\n\nUnknown: no deterministic verify receipt was provided.";
  const agent = options.agent ?? options.harness;
  const agentSource = agent ? "provided by user" : "unknown";
  const modelSource = options.model ? "provided by user" : "unknown";
  const resultSource = options.result ? "provided by user" : "unknown";
  const risksSource = options.risks ? "provided by user" : "unknown";
  const notesSource = options.notes ? "provided by user" : "unknown";
  const tokenEvidence = [
    options.inputTokens !== undefined ? `- Input tokens: ${options.inputTokens}` : undefined,
    options.outputTokens !== undefined ? `- Output tokens: ${options.outputTokens}` : undefined,
    options.totalTokens !== undefined ? `- Total tokens: ${options.totalTokens}` : undefined,
  ].filter(Boolean).join("\n");
  const costEvidence = options.costUsd !== undefined ? `- Cost USD: ${options.costUsd}` : "";

  const supersedesLine = options.supersedes
    ? `- Latest: true\n- Supersedes: ${options.supersedes}`
    : `- Latest: true`;

  return `# Run Log: ${title}

## Metadata

- Task ID: ${id}
- Status: ${finalStatus}
- Started: ${new Date().toISOString()}
- Agent/Harness (${agentSource}): ${agent ?? "Unknown: not provided."}
- Model (${modelSource}): ${options.model ?? "Unknown: not provided."}
- Branch: ${branch}
${supersedesLine}
${tokenEvidence || costEvidence ? `
## Usage Evidence

${tokenEvidence || "_Source: unknown_\n\nUnknown: no token evidence was provided."}

## Cost Evidence

${costEvidence || "_Source: unknown_\n\nUnknown: no cost evidence was provided."}
` : ""}

## Prompt Used

- Generated prompt path: ${promptPath}

## Files Changed

${filesChanged}

## Commands Run

${commandsRun}

## Tests Run

${testsRun}

## Verification Receipt

${verifyReceipt}

## Decisions Made

${decisionsMade}

## Result

<!-- complete | partial | blocked | failed -->
_Source: ${resultSource}_

${options.result ?? "Unknown: not provided."}

## Risks

_Source: ${risksSource}_

${options.risks ?? "Unknown: not provided."}

## Follow-Up Tasks

${followUps}

## Acceptance Criteria Evidence

${acceptanceCriteriaEvidence}

## Notes

_Source: ${notesSource}_

${options.notes ?? "Unknown: not provided."}
`;
}

export function runLogCommand(
  taskId: string,
  specsTasksDir: string,
  runsDir: string,
  generatedDir: string,
  cwd: string,
  options: RunLogOptions = {}
): void {
  const { tasks, errors } = loadTasks(specsTasksDir);

  if (errors.length > 0) {
    console.warn(`⚠ ${errors.length} task(s) failed to load.`);
  }

  const found = tasks.find((t) => t.spec.id === taskId);

  if (!found) {
    console.error(
      `Task not found: ${taskId}\nRun "manciple status" to see available tasks.`
    );
    process.exit(1);
  }

  const { spec } = found;

  if (!existsSync(runsDir)) {
    mkdirSync(runsDir, { recursive: true });
  }

  const ts = timestamp();
  const outFilename = `${ts}-${taskId}.md`;
  const outPath = join(runsDir, outFilename);

  // Find existing latest run log for the same task to mark as superseded
  const existingLatest = findLatestRunLogPath(cwd, taskId);

  if (existingLatest) {
    const existingBasename = basename(existingLatest);
    options = { ...options, supersedes: existingBasename };
  }

  const content = buildRunLog(
    spec.title,
    spec.id,
    spec.status,
    generatedDir,
    options.evidenceCwd ?? cwd,
    options,
  );

  writeFileSync(outPath, content, "utf-8");
  console.log(`Created run log: ${outPath.replace(cwd + "/", "")}`);

  // Mark the previous latest as superseded
  if (existingLatest) {
    markRunLogSuperseded(existingLatest, outFilename);
  }
}
