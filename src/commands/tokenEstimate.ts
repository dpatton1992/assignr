import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { findLatestRunLogPath } from "../review/evidence.js";
import { loadTasks } from "../specs/loadTasks.js";
import {
  REVIEW_TEMPLATE,
  renderTemplate,
  renderVerificationCommands,
} from "../templates/renderTemplate.js";
import { getTemplate, loadDomainContext } from "./compile.js";
import { readGitDiff, readLatestRunLog, renderReviewPrompt } from "./review.js";

export const DEFAULT_TOKEN_BUDGET = 4000;
export const TOKEN_HEURISTIC_DESCRIPTION =
  "Deterministic local heuristic: estimated tokens = ceil(characters / 4). No external APIs are called.";
export const TOKEN_ESTIMATE_SCOPE_DESCRIPTION =
  "Scope: estimates Manciple artifact/context bloat only, not total provider, harness, tool, retry, reasoning, or generated-output usage.";

export interface TokenEstimateOptions {
  specsTasksDir: string;
  cwd: string;
  taskId: string;
  budget?: number;
  includeReview?: boolean;
  includeRunLog?: boolean;
  includeDiff?: boolean;
  includeGitContext?: boolean;
  appendRunLog?: boolean;
}

export interface TokenEstimateBucket {
  label: string;
  chars: number;
  estimatedTokens: number;
  optional?: boolean;
}

export interface TokenEstimateResult {
  taskId: string;
  budget: number;
  compiledPrompt: TokenEstimateBucket;
  buckets: TokenEstimateBucket[];
  optionalBuckets: TokenEstimateBucket[];
  totalWithOptional: TokenEstimateBucket;
  risk: "ok" | "over_budget";
}

export function estimateTokens(characters: number): number {
  return Math.ceil(characters / 4);
}

function estimateBucket(label: string, content: string, optional = false): TokenEstimateBucket {
  const chars = content.length;
  return {
    label,
    chars,
    estimatedTokens: estimateTokens(chars),
    optional,
  };
}

function outputRequiredText(values: string[] | undefined): string {
  if (!values || values.length === 0) return "_None specified._";
  return values.map((value) => `- ${value}`).join("\n");
}

function verificationReviewContract(spec: {
  verification?: { commands: string[] };
  outputs_required?: string[];
}): string {
  return [
    "## Verification Commands",
    renderVerificationCommands(spec.verification?.commands ?? []),
    "## Required Output",
    outputRequiredText(spec.outputs_required),
    "## Review Readiness",
    REVIEW_TEMPLATE.split("## Review Readiness")[1]?.trim() ?? "",
  ].join("\n\n");
}

function readGitContext(cwd: string): string {
  const result = spawnSync("git", ["status", "--short", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    return "_No git context available._";
  }

  const status = result.stdout.trim();
  return status ? `Git status --short:\n${status}` : "_No changed files._";
}

export function buildTokenEstimate(options: TokenEstimateOptions): TokenEstimateResult {
  const budget = options.budget ?? DEFAULT_TOKEN_BUDGET;
  const { tasks, errors } = loadTasks(options.specsTasksDir, "all");

  if (errors.length > 0) {
    throw new Error(`Cannot estimate tokens: ${errors.length} task(s) failed to load.`);
  }

  const found = tasks.find((task) => task.spec.id === options.taskId);
  if (!found) {
    throw new Error(`No task found with id: ${options.taskId}`);
  }

  const spec = found.spec;
  const template = getTemplate(spec.type);
  const domainContext = loadDomainContext(options.specsTasksDir, spec.domain, options.cwd) ?? "";
  const compiledPrompt = renderTemplate(template, spec, domainContext || undefined);
  const taskSpecRaw = readFileSync(found.filePath, "utf-8");

  const buckets = [
    estimateBucket("task spec", taskSpecRaw),
    estimateBucket("domain context", domainContext),
    estimateBucket("template/instructions", template),
    estimateBucket("verification/review contract", verificationReviewContract(spec)),
  ];

  const optionalBuckets: TokenEstimateBucket[] = [];

  if (options.includeReview) {
    optionalBuckets.push(
      estimateBucket(
        "review prompt",
        renderReviewPrompt(spec, options.cwd, {
          includeRunLog: options.includeRunLog ?? false,
          includeGitDiff: options.includeDiff ?? false,
        }),
        true,
      ),
    );
  }

  if (options.includeRunLog) {
    optionalBuckets.push(
      estimateBucket("latest run log", readLatestRunLog(options.cwd, spec.id), true),
    );
  }

  if (options.includeDiff) {
    optionalBuckets.push(estimateBucket("git diff", readGitDiff(options.cwd), true));
  }

  if (options.includeGitContext) {
    optionalBuckets.push(estimateBucket("git context", readGitContext(options.cwd), true));
  }

  const compiledBucket = estimateBucket("base Manciple handoff", compiledPrompt);
  const optionalChars = optionalBuckets.reduce((sum, bucket) => sum + bucket.chars, 0);
  const totalChars = compiledBucket.chars + optionalChars;
  const totalWithOptional = {
    label: "total with requested optional sources",
    chars: totalChars,
    estimatedTokens: estimateTokens(totalChars),
  };

  return {
    taskId: spec.id,
    budget,
    compiledPrompt: compiledBucket,
    buckets,
    optionalBuckets,
    totalWithOptional,
    risk: totalWithOptional.estimatedTokens > budget ? "over_budget" : "ok",
  };
}

function renderBucket(bucket: TokenEstimateBucket): string {
  return `- ${bucket.label}: ${bucket.chars} chars, ~${bucket.estimatedTokens} tokens`;
}

export function renderTokenEstimateRunLogSection(result: TokenEstimateResult): string {
  const budgetLine =
    result.risk === "over_budget"
      ? `Budget warning: over budget (${result.totalWithOptional.estimatedTokens}/${result.budget} estimated tokens). Warning only; no workflow failed.`
      : `Budget warning: within budget (${result.totalWithOptional.estimatedTokens}/${result.budget} estimated tokens). Warning only; no workflow failed.`;
  const optional =
    result.optionalBuckets.length > 0
      ? result.optionalBuckets.map(renderBucket).join("\n")
      : "- optional sources: not requested";

  return `## Token Estimate

_Source: manciple token-estimate --append-run-log_

${TOKEN_ESTIMATE_SCOPE_DESCRIPTION}
- estimated: true
- method: ceil(characters / 4)

### Token Buckets

${renderBucket(result.compiledPrompt)}
${optional}

### Base Manciple Handoff Detail

${result.buckets.map(renderBucket).join("\n")}

### Budget

${budgetLine}
`;
}

export function appendTokenEstimateToLatestRunLog(
  result: TokenEstimateResult,
  cwd: string,
): string {
  const outPath = findLatestRunLogPath(cwd, result.taskId);
  if (!outPath) {
    throw new Error(
      `No existing run log found for task ${result.taskId}; create one before using --append-run-log.`,
    );
  }

  appendFileSync(outPath, `\n${renderTokenEstimateRunLogSection(result)}`, "utf-8");
  return outPath;
}

export function renderTokenEstimate(result: TokenEstimateResult): string {
  const optional =
    result.optionalBuckets.length > 0
      ? result.optionalBuckets.map(renderBucket).join("\n")
      : "- optional sources: not requested";
  const risk =
    result.risk === "over_budget"
      ? `Risk: over budget (${result.totalWithOptional.estimatedTokens}/${result.budget} estimated tokens).`
      : `Risk: within budget (${result.totalWithOptional.estimatedTokens}/${result.budget} estimated tokens).`;

  return `# Token Estimate: ${result.taskId}

${TOKEN_HEURISTIC_DESCRIPTION}
${TOKEN_ESTIMATE_SCOPE_DESCRIPTION}
- estimated: true
- method: ceil(characters / 4)
Budget: ${result.budget} estimated tokens

## Token Buckets

${renderBucket(result.compiledPrompt)}
${optional}

## Base Manciple Handoff Detail

${result.buckets.map(renderBucket).join("\n")}

## Total

${renderBucket(result.totalWithOptional)}
${risk}`;
}

export function tokenEstimateCommand(options: TokenEstimateOptions): void {
  try {
    const result = buildTokenEstimate(options);
    console.log(renderTokenEstimate(result));
    if (options.appendRunLog) {
      const outPath = appendTokenEstimateToLatestRunLog(result, options.cwd);
      console.log(`Appended token estimate to run log: ${outPath.replace(`${options.cwd}/`, "")}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
