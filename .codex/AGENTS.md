# Codex Instructions

## Manciple Token Audits

When a user asks Codex to audit, estimate, measure, or compare Manciple prompt token size for a task, run:

```sh
node scripts/manciple-token-audit.mjs <task-id>
```

Pass through requested estimator options such as `--budget <tokens>`, `--include-review`, `--include-run-log`, `--include-diff`, or `--include-git-context`. Report the measured buckets, total, budget, and risk line from the script output.

Do not manually count tokens or replace the script output with agent judgment. The script measures Manciple handoff size only; it does not measure total agent spend from file reads, tools, retries, internal reasoning, generated output, or model/provider accounting.

## Manciple MCP Scope

Manciple MCP is global. Pass this repo root as the `repo` argument on MCP calls
so returned task data, run logs, and verification operate on this checkout.

## Available Skills

<available_skills>
  <skill>
    <name>manciple-review</name>
    <description>Review completed Manciple task work by loading the task packet, running the task-specific deterministic review gate, evaluating acceptance criteria against run log and git diff evidence, and recording a verdict (approve/request-changes/block). Use when the user asks Codex to review, approve, or give feedback on a completed Manciple task.</description>
    <location>file:///Users/danielpatton/Documents/GitHub/promptops/.codex/skills/manciple-review/SKILL.md</location>
  </skill>
</available_skills>
