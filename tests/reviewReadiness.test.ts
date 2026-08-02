import { describe, expect, it } from "vitest";

import { buildRunLog } from "../src/commands/runLog.js";
import { parseRunLogEvidence } from "../src/review/evidence.js";
import { evaluateReviewReadiness } from "../src/review/readiness.js";
import type { TaskSpec } from "../src/specs/schema.js";

const task: TaskSpec = {
  id: "review-ready-task",
  title: "Review ready task",
  status: "needs_review",
  type: "implementation",
  domain: "core",
  priority: "high",
  depends_on: [],
  allowed_paths: ["src/review/"],
  forbidden_paths: ["dist/"],
  goal: "Define a review readiness contract.",
  acceptance_criteria: ["Readiness can be evaluated."],
  verification: {
    commands: ["pnpm build", "pnpm test"],
  },
  outputs_required: ["files_changed", "tests_run", "decisions_made", "risks", "follow_ups"],
  notes: [],
};

describe("evaluateReviewReadiness", () => {
  it("reports ready when run-log evidence is complete", () => {
    const report = evaluateReviewReadiness(task, {
      runLogs: [{
        filesChanged: ["src/review/readiness.ts", "tests/reviewReadiness.test.ts"],
        testsRun: ["pnpm build", "pnpm test"],
        commandResults: [
          { command: "pnpm build", status: "passed" },
          { command: "pnpm test", status: "passed" },
        ],
        decisionsMade: ["Scored readiness with a checklist."],
        result: "complete",
        risks: "none",
        followUps: ["none"],
        acceptanceCriteriaEvidence: [{
          criterion: "Readiness can be evaluated.",
          evidence: "reviewReadiness tests cover complete receipts.",
        }],
      }],
    });

    expect(report.ready).toBe(true);
    expect(report.score).toBe(100);
    expect(report.humanReviewNeeded).toBe(false);
    expect(report.humanReviewReasons).toEqual([]);
    expect(report.hasRunLog).toBe(true);
    expect(report.hasChangedFiles).toBe(true);
    expect(report.changedFilesSource).toBe("run-log");
    expect(report.hasVerification).toBe(true);
    expect(report.hasVerificationCommands).toBe(true);
    expect(report.hasVerificationResults).toBe(true);
    expect(report.hasRisks).toBe(true);
    expect(report.missingReceiptFields).toEqual([]);
    expect(report.uncoveredAcceptanceCriteria).toEqual([]);
    expect(report.failedVerificationCommands).toEqual([]);
    expect(report.documentedRisks).toEqual([]);
    expect(report.missingEvidence).toEqual([]);
  });

  it("reports partial readiness with git-status changed files and missing run-log evidence", () => {
    const report = evaluateReviewReadiness(task, {
      gitChangedFiles: ["src/review/readiness.ts"],
      runLogs: [{
        commandsRun: ["pnpm build"],
        risks: "Deployment risk remains unknown.",
      }],
    });

    expect(report.ready).toBe(false);
    expect(report.hasRunLog).toBe(true);
    expect(report.hasChangedFiles).toBe(true);
    expect(report.changedFilesSource).toBe("git-status");
    expect(report.hasVerificationCommands).toBe(false);
    expect(report.hasVerificationResults).toBe(false);
    expect(report.hasVerification).toBe(false);
    expect(report.hasRisks).toBe(true);
    expect(report.missingVerificationCommands).toEqual(["pnpm test"]);
    expect(report.missingReceiptFields).toEqual(["tests_run", "decisions_made", "follow_ups"]);
    expect(report.documentedRisks).toEqual(["Deployment risk remains unknown."]);
    expect(report.uncoveredAcceptanceCriteria).toEqual(["Readiness can be evaluated."]);
    expect(report.missingEvidence).toContain("Run log is missing expected verification command(s): pnpm test.");
    expect(report.missingEvidence).toContain("No verification result is recorded in the run log.");
    expect(report.missingEvidence).toContain("Run log is missing required receipt field(s): tests_run, decisions_made, follow_ups.");
    expect(report.missingEvidence).toContain("Documented risk(s) need review: Deployment risk remains unknown.");
  });

  it("reports no-run-log missing evidence", () => {
    const report = evaluateReviewReadiness(task);

    expect(report.ready).toBe(false);
    expect(report.hasRunLog).toBe(false);
    expect(report.hasChangedFiles).toBe(false);
    expect(report.changedFilesSource).toBe("missing");
    expect(report.hasVerification).toBe(false);
    expect(report.hasRisks).toBe(false);
    expect(report.missingReceiptFields).toEqual(["files_changed", "tests_run", "decisions_made", "risks", "follow_ups"]);
    expect(report.missingEvidence).toContain("No run log is available for task review-ready-task.");
    expect(report.missingEvidence).toContain("No changed files are listed in the run log or available from git status.");
    expect(report.missingEvidence).toContain("No verification commands are recorded in the run log.");
    expect(report.missingEvidence).toContain("No verification result is recorded in the run log.");
    expect(report.missingEvidence).toContain("No risks entry is recorded in the run log; use \"none\" when no risks remain.");
    expect(report.missingEvidence).toContain("Run log is missing required receipt field(s): files_changed, tests_run, decisions_made, risks, follow_ups.");
  });

  it("distinguishes overlapping files from missing receipts", () => {
    const report = evaluateReviewReadiness(task, {
      gitChangedFiles: ["src/review/readiness.ts", "README.md"],
      runLogs: [{
        filesChanged: ["src/review/readiness.ts"],
        testsRun: ["pnpm build", "pnpm test"],
        result: "complete",
        decisionsMade: ["Recorded evidence categories separately."],
        risks: "none",
        followUps: ["none"],
        acceptanceCriteriaEvidence: [{
          criterion: "Readiness can be evaluated.",
          evidence: "Covered by tests.",
        }],
      }],
    });

    expect(report.ready).toBe(false);
    expect(report.missingReceiptFields).toEqual([]);
    expect(report.overlappingFiles).toEqual(["src/review/readiness.ts"]);
    expect(report.missingEvidence).toContain("Run-log files still overlap git changes: src/review/readiness.ts.");
  });

  it("distinguishes uncovered acceptance criteria", () => {
    const report = evaluateReviewReadiness(task, {
      runLogs: [{
        filesChanged: ["src/review/readiness.ts"],
        testsRun: ["pnpm build", "pnpm test"],
        result: "complete",
        decisionsMade: ["Recorded receipts."],
        risks: "none",
        followUps: ["none"],
      }],
    });

    expect(report.ready).toBe(false);
    expect(report.missingReceiptFields).toEqual([]);
    expect(report.uncoveredAcceptanceCriteria).toEqual(["Readiness can be evaluated."]);
  });

  it("distinguishes failing tests from absent tests", () => {
    const failing = evaluateReviewReadiness(task, {
      runLogs: [{
        filesChanged: ["src/review/readiness.ts"],
        testsRun: ["pnpm build", "pnpm test"],
        commandResults: [
          { command: "pnpm build", status: "passed" },
          { command: "pnpm test", status: "failed" },
        ],
        decisionsMade: ["Recorded failing test evidence."],
        risks: "none",
        followUps: ["none"],
        acceptanceCriteriaEvidence: [{
          criterion: "Readiness can be evaluated.",
          evidence: "Covered by tests.",
        }],
      }],
    });
    const absent = evaluateReviewReadiness(task, {
      runLogs: [{
        filesChanged: ["src/review/readiness.ts"],
        decisionsMade: ["No tests were run."],
        risks: "none",
        followUps: ["Run verification."],
        acceptanceCriteriaEvidence: [{
          criterion: "Readiness can be evaluated.",
          evidence: "Pending verification.",
        }],
      }],
    });

    expect(failing.failedVerificationCommands).toEqual(["pnpm test"]);
    expect(failing.absentVerificationCommands).toEqual([]);
    expect(absent.failedVerificationCommands).toEqual([]);
    expect(absent.absentVerificationCommands).toEqual(["pnpm build", "pnpm test"]);
  });

  it("accepts over-budget token estimates when warning-only behavior is confirmed", () => {
    const report = evaluateReviewReadiness(task, {
      runLogs: [{
        filesChanged: ["src/review/readiness.ts"],
        testsRun: ["pnpm build", "pnpm test"],
        commandResults: [
          { command: "pnpm build", status: "passed" },
          { command: "pnpm test", status: "passed" },
        ],
        decisionsMade: ["Token budget overages remain warning-only audit evidence."],
        risks: "none",
        followUps: ["none"],
        acceptanceCriteriaEvidence: [{
          criterion: "Readiness can be evaluated.",
          evidence: "Covered by tests.",
        }],
        tokenEstimate: [
          "Scope: estimates Manciple artifact/context bloat only.",
          "Budget warning: over budget (15804/4000 estimated tokens). Warning only; no workflow failed.",
        ].join("\n"),
      }],
    });

    expect(report.ready).toBe(true);
    expect(report.failedVerificationCommands).toEqual([]);
    expect(report.missingEvidence).toEqual([]);
    expect(report.checklist).toContainEqual(expect.objectContaining({
      id: "budget-warning",
      passed: true,
    }));
  });

  it("reports missing warning-only confirmation as human review evidence instead of a failed command", () => {
    const report = evaluateReviewReadiness(task, {
      runLogs: [{
        filesChanged: ["src/review/readiness.ts"],
        testsRun: ["pnpm build", "pnpm test"],
        commandResults: [
          { command: "pnpm build", status: "passed" },
          { command: "pnpm test", status: "passed" },
        ],
        decisionsMade: ["Recorded token estimate evidence."],
        risks: "none",
        followUps: ["none"],
        acceptanceCriteriaEvidence: [{
          criterion: "Readiness can be evaluated.",
          evidence: "Covered by tests.",
        }],
        tokenEstimate: "Budget warning: over budget (15804/4000 estimated tokens).",
      }],
    });

    expect(report.ready).toBe(false);
    expect(report.hasVerification).toBe(true);
    expect(report.failedVerificationCommands).toEqual([]);
    expect(report.missingEvidence).toContain(
      "Over-budget token estimate needs review evidence confirming budget overages are warning-only."
    );
    expect(report.humanReviewReasons).toContain(
      "Budget warning present but warning-only behavior confirmed: missing warning-only confirmation"
    );
  });

  it("does not require budget warning evidence for ordinary run logs without token estimates", () => {
    const report = evaluateReviewReadiness(task, {
      runLogs: [{
        filesChanged: ["src/review/readiness.ts"],
        testsRun: ["pnpm build", "pnpm test"],
        commandResults: [
          { command: "pnpm build", status: "passed" },
          { command: "pnpm test", status: "passed" },
        ],
        decisionsMade: ["Scored readiness with ordinary run-log evidence."],
        risks: "none",
        followUps: ["none"],
        acceptanceCriteriaEvidence: [{
          criterion: "Readiness can be evaluated.",
          evidence: "Covered by tests.",
        }],
      }],
    });

    expect(report.ready).toBe(true);
    expect(report.checklist).toContainEqual(expect.objectContaining({
      id: "budget-warning",
      passed: true,
      reason: "no over-budget token estimate",
    }));
  });

  it("accepts human-readable command receipts and mapped acceptance evidence", () => {
    const report = evaluateReviewReadiness(task, {
      runLogs: [{
        filesChanged: ["src/review/readiness.ts", "tests/reviewReadiness.test.ts"],
        commandsRun: ["pnpm build => PASS"],
        testsRun: ["pnpm test: passed (10 tests)"],
        decisionsMade: ["Kept review receipts readable for human reviewers."],
        result: "complete",
        risks: "No known residual readiness-scope risks.",
        followUps: ["none"],
        acceptanceCriteriaEvidence: [{
          criterion: "Readiness can be evaluated.",
          evidence: "Focused tests exercise the readiness contract and pass.",
        }],
      }],
    });

    expect(report.ready).toBe(true);
    expect(report.score).toBe(100);
    expect(report.missingVerificationCommands).toEqual([]);
    expect(report.missingReceiptFields).toEqual([]);
    expect(report.uncoveredAcceptanceCriteria).toEqual([]);
    expect(report.documentedRisks).toEqual([]);
  });

  it("does not let unrelated evidence or a no-risk prefix hide review gaps", () => {
    const report = evaluateReviewReadiness(task, {
      runLogs: [{
        filesChanged: ["src/review/readiness.ts"],
        testsRun: ["pnpm build: passed", "pnpm test: passed"],
        result: "complete",
        decisionsMade: ["Recorded the available evidence."],
        risks: "No known code risks. Browser validation was not performed.",
        followUps: ["none"],
        acceptanceCriteriaEvidence: [{
          criterion: "A different claim was exercised.",
        }],
      }],
    });

    expect(report.ready).toBe(false);
    expect(report.uncoveredAcceptanceCriteria).toEqual(["Readiness can be evaluated."]);
    expect(report.unmappedAcceptanceEvidence).toEqual(["A different claim was exercised."]);
    expect(report.documentedRisks).toEqual([
      "No known code risks. Browser validation was not performed.",
    ]);
    expect(report.missingEvidence).toContain(
      "Acceptance evidence is present but not mapped to task criteria; uncovered criteria: Readiness can be evaluated."
    );
  });

  it("round-trips command, acceptance, and verification receipts through markdown", () => {
    const content = buildRunLog(
      task.title,
      task.id,
      task.status,
      ".manciple/prompts/generated",
      process.cwd(),
      {
        result: "complete",
        filesChanged: ["src/review/readiness.ts", "tests/reviewReadiness.test.ts"],
        testsRun: ["pnpm build: passed", "pnpm test: passed (258 tests)"],
        decisionsMade: ["Kept review evidence structured."],
        risks: "No known residual risks.",
        followUps: ["none"],
        acceptanceCriteriaEvidence: [
          "Readiness can be evaluated. => Round-trip coverage exercises the rendered receipt.",
        ],
        verifyReceipt: JSON.stringify({
          ok: true,
          profile: "worker",
          commands_run: [
            { command: "pnpm build", exit_code: 0, ok: true },
            { command: "pnpm test", exit_code: 0, ok: true },
          ],
          failures: [],
        }),
      }
    );

    const runLogs = parseRunLogEvidence(content);
    const report = evaluateReviewReadiness(task, { runLogs });

    expect(runLogs[0].verificationResults).toEqual(["passed"]);
    expect(runLogs[0].commandResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "pnpm build", status: "passed" }),
      expect.objectContaining({ command: "pnpm test", status: "passed" }),
    ]));
    expect(report.ready).toBe(true);
    expect(report.missingEvidence).toEqual([]);
  });

  it("uses the final outcome when a receipt records a successful rerun", () => {
    const content = buildRunLog(
      task.title,
      task.id,
      task.status,
      ".manciple/prompts/generated",
      process.cwd(),
      {
        result: "complete",
        filesChanged: ["src/review/readiness.ts"],
        testsRun: [
          "pnpm build: failed in sandbox, rerun outside sandbox passed",
          "pnpm test: passed",
        ],
        decisionsMade: ["Recorded the successful rerun."],
        risks: "none",
        followUps: ["none"],
        acceptanceCriteriaEvidence: [
          "Readiness can be evaluated. => Covered by the successful rerun.",
        ],
      }
    );

    const report = evaluateReviewReadiness(task, {
      runLogs: parseRunLogEvidence(content),
    });

    expect(report.failedVerificationCommands).toEqual([]);
    expect(report.ready).toBe(true);
  });

  it("reports a malformed verification receipt instead of silently dropping it", () => {
    const content = buildRunLog(
      task.title,
      task.id,
      task.status,
      ".manciple/prompts/generated",
      process.cwd(),
      {
        result: "complete",
        filesChanged: ["src/review/readiness.ts"],
        testsRun: ["pnpm build: passed", "pnpm test: passed"],
        decisionsMade: ["Recorded verification evidence."],
        risks: "none",
        followUps: ["none"],
        acceptanceCriteriaEvidence: [
          "Readiness can be evaluated. => Covered by the readiness test.",
        ],
        verifyReceipt: "not-json",
      }
    );

    const report = evaluateReviewReadiness(task, {
      runLogs: parseRunLogEvidence(content),
    });

    expect(report.ready).toBe(false);
    expect(report.missingEvidence.some((entry) => (
      entry.startsWith("Verification receipt is not parseable:") && entry.includes("not-json")
    ))).toBe(true);
  });
});
