# Manciple Project Instructions

This is the `manciple` repo — a task management CLI and MCP server
for structured agent workflows.

## Workflow Orchestration

Use Manciple for workflow orchestration unless the user explicitly directs you
not to. For actionable repo work, use the available Manciple MCP tools to load
or create task context, track lifecycle status, verify the work, and record run
evidence. Prefer the MCP tools over raw CLI commands when both are available,
and pass this repository root as the `repo` argument.

Small read-only questions and exploratory inspection do not require creating a
Manciple task unless the user asks for one.

## Manciple Token Audits

When asked to audit, estimate, measure, or compare Manciple prompt token size for
a task, run:

```sh
node scripts/manciple-token-audit.mjs <task-id>
```

Pass through requested estimator options such as `--budget <tokens>`,
`--include-review`, `--include-run-log`, `--include-diff`, or
`--include-git-context`. Report the measured buckets, total, budget, and risk
line from the script output.

Do not manually count tokens or replace the script output with agent judgment.
The script measures Manciple handoff size only; it does not measure total agent
spend from file reads, tools, retries, internal reasoning, generated output, or
model/provider accounting.

## Available Agents

- `@manciple-worker` — subagent that implements a single Manciple task end-to-end
  via MCP. Invoke with a task ID or ask it to choose one.
- `manciple-coordinator` — primary agent (Tab-switchable) that dispatches a plan
  and runs multiple `manciple-worker` subagents in parallel.

## MCP Tools

The `manciple` MCP server is configured in `opencode.json`. Manciple tools are
prefixed `manciple_` (e.g. `manciple_get_task_packet`, `manciple_set_status`,
`manciple_verify`). Prefer these over raw CLI calls when both are available.
Manciple MCP is global: pass this repo root as the `repo` argument on MCP calls
so returned task data, run logs, and verification operate on this checkout.

## Project Conventions

- Task specs live in `.manciple/specs/tasks/`. Do not edit them directly — use
  `manciple_set_status` for status changes.
- Run logs are written to `.manciple/runs/` by `manciple_run_log`.
- Verification uses `manciple_verify --profile worker|coordinator|review`.
- Tests: `pnpm test` (vitest). Lint: `pnpm exec tsc --noEmit`.

## Available Skills

<available_skills>
  <skill>
    <name>manciple-review</name>
    <description>Review completed Manciple task work by loading the task packet, checking review readiness with manciple_verify --profile review, evaluating acceptance criteria against run log and git diff evidence, and recording a deterministic verdict (approve/request-changes/block). Use when the user asks Claude Code to review, approve, or give feedback on a completed Manciple task.</description>
    <location>file:///Users/danielpatton/Documents/GitHub/promptops/.claude/skills/manciple-review/SKILL.md</location>
  </skill>
</available_skills>
