import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { readLatestRunLogContent } from "../review/evidence.js";
import type { ReviewPacketContext } from "../review/reviewPacket.js";
import { getReviewQueue, getTaskReviewPacket, ReviewPacketError } from "../review/reviewPacket.js";
import { loadTasks } from "../specs/loadTasks.js";
import type { TaskSpec } from "../specs/schema.js";
import { implementationPromptFilename, reviewPromptFilename } from "../templates/renderTemplate.js";
import type { ManciplePaths } from "../utils/paths.js";
import { colorForStatus, headerBanner, statusSymbol } from "../utils/styling.js";
import { approveCommand } from "./approve.js";
import { blockReviewCommand } from "./blockReview.js";
import { requestChangesCommand } from "./requestChanges.js";
import { reviewCheckCommand } from "./reviewCheck.js";
import { reviewQueueCommand } from "./reviewQueue.js";

/**
 * Machine-readable review adapters are thin layers over the assembled
 * ReviewPacket application boundary. They must not read task YAML, run logs,
 * generated prompts, git state, or lifecycle folders directly; all evidence
 * reads happen inside src/review/* services.
 */
function reviewPacketContext(p: ManciplePaths, cwd: string): ReviewPacketContext {
  return {
    specsTasksDir: p.specsTasks,
    cwd,
    generatedDir: p.promptsGenerated,
    activeDir: p.tasksActive,
    completedDir: p.tasksCompleted,
    archivedDir: p.tasksArchived,
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function formatList(items: string[] | undefined): string {
  if (!items || items.length === 0) return "_None specified._";
  return items.map((item) => `- ${item}`).join("\n");
}

function formatVerificationCommands(commands: string[] | undefined): string {
  if (!commands || commands.length === 0) return "_None specified._";
  return commands.map((cmd) => `\`\`\`bash\n${cmd}\n\`\`\``).join("\n\n");
}

export function readLatestRunLog(cwd: string, taskId: string): string {
  return readLatestRunLogContent(cwd, taskId) ?? "_No run log available._";
}

export function readGitDiff(cwd: string): string {
  const result = spawnSync("git", ["diff", "HEAD"], {
    cwd,
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    return "_No diff available._";
  }

  const diff = result.stdout.trim();

  if (!diff) {
    return "_No changes staged._";
  }

  const lines = diff.split("\n");

  if (lines.length <= 400) {
    return `\`\`\`diff\n${diff}\n\`\`\``;
  }

  return `\`\`\`diff\n${lines.slice(0, 400).join("\n")}\`\`\`\n\n_Diff truncated after 400 lines._`;
}

function compactRunLogSummary(cwd: string, taskId: string): string {
  const content = readLatestRunLogContent(cwd, taskId);
  if (!content) return "_No run log available._";

  const parts: string[] = [];

  const resultMatch = content.match(/^## Result\s*\n\n([\s\S]*?)(?=\n## |\n$)/m);
  if (resultMatch) {
    const resultVal = resultMatch[1]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("_Source:") && !l.startsWith("<!--"))
      .join(" ")
      .trim();
    if (resultVal) parts.push(`result: ${resultVal}`);
  }

  const filesMatch = content.match(/^## Files Changed\s*\n\n([\s\S]*?)(?=\n## |\n$)/m);
  if (filesMatch) {
    const count = filesMatch[1]
      .split("\n")
      .filter((l) => l.trim().startsWith("- ") && !l.includes("_Source:")).length;
    if (count > 0) parts.push(`${count} file(s) changed`);
  }

  const summary = parts.length > 0 ? parts.join("; ") : "available";
  return `_Run log ${summary}. Use \`manciple review --include-run-log\` for full context._`;
}

function compactGitDiffSummary(cwd: string): string {
  const result = spawnSync("git", ["status", "--short", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    return "_No git context available._";
  }

  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    return "_No changes staged._";
  }

  return `_Git changes available (${lines.length} file(s) modified). Use \`manciple review --include-diff\` for full diff._`;
}

export interface RenderReviewPromptOptions {
  includeRunLog?: boolean;
  includeGitDiff?: boolean;
}

export function renderReviewPrompt(
  spec: TaskSpec,
  cwd: string,
  options: RenderReviewPromptOptions = {},
): string {
  const includeRunLog = options.includeRunLog ?? false;
  const includeGitDiff = options.includeGitDiff ?? false;

  return `# Review Task: ${spec.title}

You are reviewing an agent-produced change.

Evaluate whether the implementation satisfies the task without creating unnecessary risk.

## Task Metadata

- ID: ${spec.id}
- Domain: ${spec.domain}
- Status: ${spec.status}

## Task Goal

${spec.goal.trim()}

## Acceptance Criteria

${formatList(spec.acceptance_criteria)}

## Verification Commands

${formatVerificationCommands(spec.verification?.commands)}

## Run Log

${includeRunLog ? readLatestRunLog(cwd, spec.id) : compactRunLogSummary(cwd, spec.id)}

## Git Diff

${includeGitDiff ? readGitDiff(cwd) : compactGitDiffSummary(cwd)}

## Allowed Paths

${formatList(spec.allowed_paths)}

## Forbidden Paths

${formatList(spec.forbidden_paths)}

## Implementation Review

- [ ] Allowed paths: changed files are limited to the task's allowed paths or clearly justified.
- [ ] Forbidden paths: no forbidden paths were modified.
- [ ] Acceptance criteria evidence: each criterion has implementation evidence in the diff or run log.
- [ ] Verification evidence: required commands were run and their results are recorded.
- [ ] Generated artifacts: generated prompts, run logs, or other artifacts are present and named as expected.
- [ ] Risk notes: risks are recorded, or explicitly marked as none.
- [ ] Budget warning present but warning-only behavior confirmed.

## Integration Review

- [ ] The change fits existing architecture and command/template conventions.
- [ ] Dependencies and lifecycle status are consistent with the task.
- [ ] Test, typecheck, and build coverage are adequate for the blast radius.
- [ ] No unnecessary abstractions, excessive scope, or duplicated behavior were introduced.
- [ ] Follow-up tasks are identified for any work outside scope.

## Decision

- [ ] Approve
- [ ] Request changes
- [ ] Block

### Reviewer Notes

### Findings

### Required Changes

### Suggested Follow-Ups

### Risk Assessment
`;
}

export function createReviewPrompt(
  taskId: string,
  specsTasksDir: string,
  generatedDir: string,
  cwd: string,
  options?: RenderReviewPromptOptions,
): string {
  const { tasks, errors } = loadTasks(specsTasksDir, "all");

  if (errors.length > 0) {
    console.warn(`⚠ ${errors.length} task(s) failed to load.`);
  }

  const found = tasks.find((t) => t.spec.id === taskId);

  if (!found) {
    console.error(`Task not found: ${taskId}\nRun "manciple status" to see available tasks.`);
    process.exit(1);
  }

  if (!existsSync(generatedDir)) {
    mkdirSync(generatedDir, { recursive: true });
  }

  const rendered = renderReviewPrompt(found.spec, cwd, options);
  const outPath = join(generatedDir, reviewPromptFilename(taskId));
  writeFileSync(outPath, rendered, "utf-8");

  return outPath;
}

export function reviewCommand(
  taskId: string,
  specsTasksDir: string,
  generatedDir: string,
  cwd: string,
  options?: RenderReviewPromptOptions,
): void {
  const outPath = createReviewPrompt(taskId, specsTasksDir, generatedDir, cwd, options);
  const relPath = outPath.replace(`${cwd}/`, "");

  const { tasks } = loadTasks(specsTasksDir, "all");
  const found = tasks.find((t) => t.spec.id === taskId);

  console.log(headerBanner().trimEnd());
  console.log(`  ${colorForStatus("complete")("✓")} Review prompt created\n`);
  if (found) {
    const sym = statusSymbol(found.spec.status);
    console.log(`  Task:   ${found.spec.id}`);
    console.log(`  Status: ${colorForStatus(found.spec.status)(`${sym} ${found.spec.status}`)}`);
  } else {
    console.log(`  Task:   ${taskId}`);
  }
  console.log(`  File:   ${relPath}\n`);
  console.log(
    `  Note: Review prompts are separate from compiled implementation prompts, which use ${join(
      generatedDir,
      implementationPromptFilename(taskId),
    ).replace(`${cwd}/`, "")}.`,
  );
}

/**
 * Bare `manciple review` behavior depends on whether the terminal is
 * interactive. In a TTY the review dashboard TUI is launched; in a non-TTY
 * context (pipes, scripts, CI) the command prints help and never hangs.
 */
export interface BareReviewDispatch {
  isTty: boolean;
  launchTui: (p: ManciplePaths, cwd: string) => unknown;
  showHelp: () => void;
}

export function dispatchBareReview(
  dispatch: BareReviewDispatch,
  p: ManciplePaths,
  cwd: string,
): unknown {
  if (dispatch.isTty) {
    return dispatch.launchTui(p, cwd);
  }
  dispatch.showHelp();
  return undefined;
}

export interface ReviewCommandRegistrationOptions {
  /** TTY detection override for tests; defaults to process.stdout.isTTY. */
  isTty?: () => boolean;
  /** TUI launcher override for tests; defaults to a lazy import of the review TUI. */
  launchTui?: (p: ManciplePaths, cwd: string) => void | Promise<void>;
  /** Help override for tests; defaults to the review command's own help output. */
  showHelp?: () => void;
}

export function registerReviewCommands(
  program: Command,
  p: ManciplePaths,
  cwd: string,
  options: ReviewCommandRegistrationOptions = {},
): void {
  const isTty = options.isTty ?? (() => process.stdout.isTTY);
  const launchTui =
    options.launchTui ??
    (async (paths: ManciplePaths, dir: string) => {
      const { runReviewTui } = await import("../tui/launch.js");
      await runReviewTui(paths, dir);
    });
  const showHelp = options.showHelp ?? (() => review.help());

  const review = program
    .command("review [task-id]")
    .description(
      "Open the interactive review dashboard, or manage the review process. See `manciple review --help` for subcommands.",
    )
    .option("--include-run-log", "Include full latest run log content.", false)
    .option("--include-diff", "Include full git diff content.", false)
    .action(
      (taskId: string | undefined, opts: { includeRunLog: boolean; includeDiff: boolean }) => {
        if (taskId) {
          reviewCommand(taskId, p.specsTasks, p.promptsGenerated, cwd, {
            includeRunLog: opts.includeRunLog,
            includeGitDiff: opts.includeDiff,
          });
          return;
        }
        // Bare `manciple review` opens the interactive dashboard in a TTY and
        // prints help (without hanging) when stdout is not a terminal.
        void Promise.resolve(
          dispatchBareReview(
            {
              isTty: isTty(),
              launchTui,
              showHelp,
            },
            p,
            cwd,
          ),
        ).catch((error: unknown) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exit(1);
        });
      },
    );

  review
    .command("queue")
    .description(
      "Run review queue triage (same as `manciple review-queue`). Use --json for the assembled queue as stable JSON.",
    )
    .option("--mode <mode>", "Review queue mode: triage or deep.")
    .option("--all", "In deep mode, include tasks that passed triage.", false)
    .option("--budget <tokens>", "Positive integer review budget estimate for queued packets.")
    .option("--deep-only <filter>", "In deep mode, emit only tasks matching the filter: risky.")
    .option("--machine", "Tab-delimited output for backward compatibility.", false)
    .option(
      "--json",
      "Print the assembled review queue as stable JSON with no ANSI styling.",
      false,
    )
    .action(
      (opts: {
        mode: string;
        all: boolean;
        budget?: string;
        deepOnly?: string;
        machine: boolean;
        json: boolean;
      }) => {
        if (opts.json) {
          if (opts.mode !== undefined && opts.mode !== "triage" && opts.mode !== "deep") {
            console.error(`Unsupported review queue mode: ${opts.mode}. Allowed: triage, deep.`);
            process.exit(1);
          }
          printJson(getReviewQueue(reviewPacketContext(p, cwd)));
          return;
        }
        reviewQueueCommand(p.tasksActive, cwd, {
          mode: opts.mode as "triage" | "deep",
          all: opts.all,
          budget: opts.budget,
          deepOnly: opts.deepOnly,
          machine: opts.machine,
          generatedDir: p.promptsGenerated,
          activeDir: p.tasksActive,
          completedDir: p.tasksCompleted,
          archivedDir: p.tasksArchived,
        });
      },
    );

  review
    .command("check [task-id]")
    .description("Check review readiness (same as `manciple review-check`).")
    .option("--deterministic", "Run local deterministic review gate checks.", false)
    .option("--machine", "Tab-delimited output for backward compatibility.", false)
    .action((taskId: string | undefined, opts: { deterministic: boolean; machine: boolean }) => {
      reviewCheckCommand(p.tasksActive, cwd, taskId, {
        deterministic: opts.deterministic,
        machine: opts.machine,
        generatedDir: p.promptsGenerated,
        activeDir: p.tasksActive,
        completedDir: p.tasksCompleted,
        archivedDir: p.tasksArchived,
      });
    });

  review
    .command("prompt <task-id>")
    .description("Generate a review prompt (same as `manciple review <task-id>`).")
    .option("--include-run-log", "Include full latest run log content.", false)
    .option("--include-diff", "Include full git diff content.", false)
    .action((taskId: string, opts: { includeRunLog: boolean; includeDiff: boolean }) => {
      reviewCommand(taskId, p.specsTasks, p.promptsGenerated, cwd, {
        includeRunLog: opts.includeRunLog,
        includeGitDiff: opts.includeDiff,
      });
    });

  review
    .command("packet <task-id>")
    .description(
      "Assemble the ReviewPacket for one task. Use --json for stable machine-readable output.",
    )
    .option(
      "--json",
      "Print the assembled ReviewPacket as stable JSON with no ANSI styling.",
      false,
    )
    .action((taskId: string, opts: { json: boolean }) => {
      let packet: ReturnType<typeof getTaskReviewPacket>;
      try {
        packet = getTaskReviewPacket(taskId, reviewPacketContext(p, cwd));
      } catch (error) {
        if (error instanceof ReviewPacketError) {
          console.error(error.message);
          process.exit(1);
        }
        throw error;
      }

      if (opts.json) {
        printJson(packet);
        return;
      }

      console.log(`Review packet: ${packet.taskId} (${packet.status})`);
      console.log(`  Title:     ${packet.title}`);
      console.log(
        `  Readiness: ${packet.readiness.ready ? "ready" : "not ready"} (score ${packet.readiness.score}/100)`,
      );
      console.log(
        `  Decisions: ${packet.availableDecisions.map((decision) => decision.id).join(", ") || "none"}`,
      );
      console.log(`  Blockers:  ${packet.blockers.length}`);
      console.log(`  Use --json for the full machine-readable packet.`);
    });

  review
    .command("approve <task-id>")
    .description("Approve and complete a task (same as `manciple approve`).")
    .action((taskId: string) => {
      approveCommand(taskId, {
        specsTasksDir: p.specsTasks,
        completedDir: p.tasksCompleted,
        runsDir: p.runs,
        cwd,
      });
    });

  review
    .command("changes <task-id>")
    .description(
      "Request changes and return task to in_progress (same as `manciple request-changes`).",
    )
    .requiredOption("--reason <text>", "Reason changes are required.")
    .action((taskId: string, opts: { reason: string }) => {
      requestChangesCommand(taskId, opts.reason, {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      });
    });

  review
    .command("block <task-id>")
    .description("Block review for a task (same as `manciple block-review`).")
    .requiredOption("--reason <text>", "Reason review is blocked.")
    .action((taskId: string, opts: { reason: string }) => {
      blockReviewCommand(taskId, opts.reason, {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      });
    });

  program
    .command("review-check [task-id]")
    .description("Check review readiness evidence for active needs_review tasks.")
    .option("--deterministic", "Run local deterministic review gate checks.", false)
    .option("--machine", "Tab-delimited output for backward compatibility.", false)
    .action((taskId: string | undefined, opts: { deterministic: boolean; machine: boolean }) => {
      reviewCheckCommand(p.tasksActive, cwd, taskId, {
        deterministic: opts.deterministic,
        machine: opts.machine,
        generatedDir: p.promptsGenerated,
        activeDir: p.tasksActive,
        completedDir: p.tasksCompleted,
        archivedDir: p.tasksArchived,
      });
    });

  program
    .command("review-queue")
    .description("Triage active needs_review tasks for deeper review.")
    .option("--mode <mode>", "Review queue mode: triage or deep.", "triage")
    .option("--all", "In deep mode, include tasks that passed triage.", false)
    .option("--budget <tokens>", "Positive integer review budget estimate for queued packets.")
    .option("--deep-only <filter>", "In deep mode, emit only tasks matching the filter: risky.")
    .option("--machine", "Tab-delimited output for backward compatibility.", false)
    .action(
      (opts: {
        mode: string;
        all: boolean;
        budget?: string;
        deepOnly?: string;
        machine: boolean;
      }) => {
        reviewQueueCommand(p.tasksActive, cwd, {
          mode: opts.mode as "triage" | "deep",
          all: opts.all,
          budget: opts.budget,
          deepOnly: opts.deepOnly,
          machine: opts.machine,
          generatedDir: p.promptsGenerated,
          activeDir: p.tasksActive,
          completedDir: p.tasksCompleted,
          archivedDir: p.tasksArchived,
        });
      },
    );

  program
    .command("approve <task-id>")
    .description(
      "Approve a task in needs_review, record the outcome, and move it to tasks/completed.",
    )
    .action((taskId: string) => {
      approveCommand(taskId, {
        specsTasksDir: p.specsTasks,
        completedDir: p.tasksCompleted,
        runsDir: p.runs,
        cwd,
      });
    });

  program
    .command("request-changes <task-id>")
    .description("Request changes for a task in needs_review and return it to in_progress.")
    .requiredOption("--reason <text>", "Reason changes are required.")
    .action((taskId: string, opts: { reason: string }) => {
      requestChangesCommand(taskId, opts.reason, {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      });
    });

  program
    .command("block-review <task-id>")
    .description("Block review for a task in needs_review and record the blocking reason.")
    .requiredOption("--reason <text>", "Reason review is blocked.")
    .action((taskId: string, opts: { reason: string }) => {
      blockReviewCommand(taskId, opts.reason, {
        specsTasksDir: p.specsTasks,
        runsDir: p.runs,
        cwd,
      });
    });
}
