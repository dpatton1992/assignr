import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildRunLog, timestamp } from "../commands/runLog.js";
import { STATUSES } from "../constants.js";
import { getRepoContext, repoInputSchema } from "./context.js";
import { errorResult, jsonResult, toolResult } from "./results.js";
import { loadTasksOrError } from "./taskHelpers.js";

export function registerRunLogTools(server: McpServer): void {
  server.registerTool(
    "manciple_run_log",
    {
      title: "Create Manciple Run Log",
      description:
        "Create a run log for one Manciple task. Pass agent context fields when available so the log is populated rather than left as TODO stubs.",
      inputSchema: {
        ...repoInputSchema,
        task_id: z.string(),
        agent: z.string().optional().describe("The agent harness or tool used (e.g. 'Claude Code', 'Cursor')."),
        model: z.string().optional().describe("The model that performed the work (e.g. 'claude-sonnet-4-5')."),
        files_changed: z.array(z.string()).optional().describe("List of file paths modified during the run."),
        commands_run: z.array(z.string()).optional().describe("List of non-test shell commands executed during the run."),
        tests_run: z.array(z.string()).optional().describe("List of test commands or test receipts executed during the run."),
        task_status: z.enum(STATUSES).optional().describe("Final task status to record in the run log."),
        acceptance_criteria_evidence: z
          .array(z.string())
          .optional()
          .describe("Evidence lines formatted as '<exact criterion text> => <evidence>'."),
        decisions_made: z
          .array(z.string())
          .optional()
          .describe("Key decisions made during completed implementation work; omit only if blocked before meaningful changes."),
        follow_ups: z.array(z.string()).optional().describe("Follow-up tasks or notes from the run."),
        verify_receipt: z
          .string()
          .optional()
          .describe("Deterministic manciple_verify or manciple verify --profile receipt text."),
        result: z
          .enum(["complete", "partial", "blocked", "failed"])
          .optional()
          .describe("Outcome of the run."),
        risks: z.string().optional().describe("Risks or residual concerns from the run."),
        notes: z.string().optional().describe("Free-form notes about the run."),
      },
    },
    ({
      repo,
      task_id,
      agent,
      model,
      files_changed,
      commands_run,
      tests_run,
      task_status,
      acceptance_criteria_evidence,
      decisions_made,
      follow_ups,
      verify_receipt,
      result,
      risks,
      notes,
    }) =>
      toolResult(() => {
        const ctx = getRepoContext(repo);
        const tasks = loadTasksOrError(ctx);
        const found = tasks.find((task) => task.spec.id === task_id);
        if (!found) return errorResult(`Task not found: ${task_id}`);

        if (!existsSync(ctx.paths.runs)) {
          mkdirSync(ctx.paths.runs, { recursive: true });
        }

        const outPath = join(ctx.paths.runs, `${timestamp()}-${found.spec.id}.md`);
        writeFileSync(
          outPath,
          buildRunLog(found.spec.title, found.spec.id, found.spec.status, ctx.paths.promptsGenerated, ctx.cwd, {
            agent,
            model,
            filesChanged: files_changed,
            commandsRun: commands_run,
            testsRun: tests_run,
            taskStatus: task_status,
            acceptanceCriteriaEvidence: acceptance_criteria_evidence,
            decisionsMade: decisions_made,
            followUps: follow_ups,
            verifyReceipt: verify_receipt,
            result,
            risks,
            notes,
          }),
          "utf-8"
        );

        return jsonResult({ path: outPath });
      })
  );
}
