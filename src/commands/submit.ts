import type { Command } from "commander";
import { STATUSES } from "../constants.js";
import type { Status } from "../constants.js";
import { runLogCommand } from "./runLog.js";
import { setStatusCommand } from "./setStatus.js";
import { completeCommand } from "./complete.js";
import type { ManciplePaths } from "../utils/paths.js";

const RUN_LOG_RESULTS = ["complete", "partial", "blocked", "failed"];

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parseNumberOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative number, got "${value}".`);
  }
  return parsed;
}

export function registerSubmitCommand(program: Command, p: ManciplePaths, cwd: string): void {
  program
    .command("submit <task-id>")
    .description("Submit a task with a run log and result.")
    .option("--result <result>", `Outcome (${RUN_LOG_RESULTS.join(", ")}).`)
    .option("--blocked", "Mark as blocked (shortcut for --result blocked). Requires --reason.", false)
    .option("--complete", "Complete the task (skips review).", false)
    .option("--reason <text>", "Reason for blocking or failure.")
    .option("--agent <agent>", "Agent harness or tool used.")
    .option("--model <model>", "Model that performed the work.")
    .option("--follow-up <text>", "Follow-up note. May be repeated.", collect, [])
    .option("--decision <text>", "Decision made. May be repeated.", collect, [])
    .option("--verify-receipt <text>", "Verification receipt.")
    .option("--acceptance-evidence <evidence>", "Acceptance evidence as '<exact criterion text> => <evidence>'. May be repeated.", collect, [])
    .option("--risks <risks>", "Risks or residual concerns.")
    .option("--notes <notes>", "Free-form notes.")
    .action((taskId: string, opts: {
      result?: string;
      blocked: boolean;
      complete: boolean;
      reason?: string;
      agent?: string;
      model?: string;
      followUp: string[];
      decision: string[];
      verifyReceipt?: string;
      acceptanceEvidence: string[];
      risks?: string;
      notes?: string;
    }) => {
      let result: string;
      let doComplete = false;
      let targetStatus: string | null = null;

      if (opts.complete) {
        result = "complete";
        doComplete = true;
      } else if (opts.blocked) {
        result = "blocked";
        targetStatus = "blocked";
        if (!opts.reason) {
          console.error("error: --reason is required when using --blocked");
          process.exit(1);
        }
      } else if (opts.result) {
        result = opts.result;
        if (!RUN_LOG_RESULTS.includes(result)) {
          console.error(`Invalid result: "${result}". Allowed: ${RUN_LOG_RESULTS.join(", ")}`);
          process.exit(1);
        }
        if (result === "blocked" && !opts.reason) {
          console.error("error: --reason is required when result is blocked");
          process.exit(1);
        }
      } else {
        console.error("error: one of --result, --blocked, or --complete is required");
        process.exit(1);
      }

      // Create the run log
      runLogCommand(taskId, p.specsTasks, p.runs, p.promptsGenerated, cwd, {
        result,
        agent: opts.agent ?? "cli",
        model: opts.model,
        commandsRun: [],
        testsRun: [],
        filesChanged: [],
        decisionsMade: opts.decision,
        risks: opts.risks,
        followUps: opts.followUp,
        acceptanceCriteriaEvidence: opts.acceptanceEvidence,
        verifyReceipt: opts.verifyReceipt,
        notes: opts.notes,
      });

      // Update task status
      if (doComplete) {
        completeCommand(taskId, {
          specsTasksDir: p.specsTasks,
          completedDir: p.tasksCompleted,
          cwd,
        });
      } else if (targetStatus) {
        setStatusCommand(taskId, targetStatus as Status, p.specsTasks, cwd);
      } else if (result === "blocked" || result === "failed" || result === "partial") {
        setStatusCommand(taskId, result as Status, p.specsTasks, cwd);
      } else {
        // result=complete without --complete → needs_review
        setStatusCommand(taskId, "needs_review" as Status, p.specsTasks, cwd);
      }
    });

  program
    .command("run-log <task-id>")
    .description("Create a run log for a task.")
    .option("--result <result>", "Outcome: complete, partial, blocked, or failed.")
    .option("--task-status <status>", `Final task status to record. Allowed: ${STATUSES.join(", ")}.`)
    .option("--model <model>", "Model that performed the work.")
    .option("--agent <agent>", "Agent harness or tool used.")
    .option("--harness <harness>", "Agent harness or tool used.")
    .option("--input-tokens <count>", "Input token count recorded by the agent or harness.", parseNumberOption)
    .option("--output-tokens <count>", "Output token count recorded by the agent or harness.", parseNumberOption)
    .option("--total-tokens <count>", "Total token count recorded by the agent or harness.", parseNumberOption)
    .option("--cost-usd <amount>", "Run cost in USD recorded by the agent or harness.", parseNumberOption)
    .option("--command <command>", "Command executed during the run. May be repeated.", collect, [])
    .option("--commands-run <command>", "Command executed during the run. May be repeated.", collect, [])
    .option("--test <command>", "Test command or test receipt executed during the run. May be repeated.", collect, [])
    .option("--tests-run <command>", "Test command or test receipt executed during the run. May be repeated.", collect, [])
    .option("--file <path>", "Changed file path. May be repeated; otherwise git status is used.", collect, [])
    .option("--files-changed <path>", "Changed file path. May be repeated; otherwise git status is used.", collect, [])
    .option("--acceptance-evidence <evidence>", "Acceptance evidence as '<exact criterion text> => <evidence>'. May be repeated.", collect, [])
    .option("--verify-receipt <receipt>", "Deterministic verify receipt text or compact JSON.")
    .option("--decision <decision>", "Decision made during the run. May be repeated.", collect, [])
    .option("--follow-up <followUp>", "Follow-up task or note. May be repeated.", collect, [])
    .option("--risks <risks>", "Risks or residual concerns.")
    .option("--notes <notes>", "Free-form notes.")
    .action((taskId: string, opts: {
      result?: string;
      taskStatus?: string;
      model?: string;
      agent?: string;
      harness?: string;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      costUsd?: number;
      command: string[];
      commandsRun: string[];
      test: string[];
      testsRun: string[];
      file: string[];
      filesChanged: string[];
      acceptanceEvidence: string[];
      verifyReceipt?: string;
      decision: string[];
      followUp: string[];
      risks?: string;
      notes?: string;
    }) => {
      if (opts.result && !RUN_LOG_RESULTS.includes(opts.result)) {
        console.error(`Invalid result: "${opts.result}". Allowed: ${RUN_LOG_RESULTS.join(", ")}`);
        process.exit(1);
      }
      if (opts.taskStatus && !STATUSES.includes(opts.taskStatus as Status)) {
        console.error(`Invalid task status: "${opts.taskStatus}". Allowed: ${STATUSES.join(", ")}`);
        process.exit(1);
      }

      runLogCommand(taskId, p.specsTasks, p.runs, p.promptsGenerated, cwd, {
        result: opts.result,
        taskStatus: opts.taskStatus,
        model: opts.model,
        agent: opts.agent,
        harness: opts.harness,
        inputTokens: opts.inputTokens,
        outputTokens: opts.outputTokens,
        totalTokens: opts.totalTokens,
        costUsd: opts.costUsd,
        commandsRun: [...opts.command, ...opts.commandsRun],
        testsRun: [...opts.test, ...opts.testsRun],
        filesChanged: [...opts.file, ...opts.filesChanged],
        decisionsMade: opts.decision,
        followUps: opts.followUp,
        acceptanceCriteriaEvidence: opts.acceptanceEvidence,
        verifyReceipt: opts.verifyReceipt,
        risks: opts.risks,
        notes: opts.notes,
      });
    });
}
