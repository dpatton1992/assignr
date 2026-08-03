---
name: manciple-agents
description: Coordinate Manciple task-runner workers efficiently across actionable Manciple work, with each worker using the manciple-mcp-task-runner skill and Manciple MCP tools. Use when the user asks to spawn Manciple workers, process multiple Manciple tasks in parallel, or coordinate Manciple task execution across sub-agents.
---

# Manciple Agents

Coordinate worker agents for Manciple task work. Use local CPU capacity as a hard ceiling, but let Manciple's deterministic dispatch plan choose the actual assignments. Each worker must use `manciple-mcp-task-runner` as its operating procedure.

Use this skill as the parent coordinator. Do not do task implementation yourself unless a small coordinator-side change is needed to integrate worker results.

## Required Tools

Use the `Task` tool to spawn workers. If the tool is not available, stop and report that this skill requires sub-agent support.

Use the repo-local `manciple-mcp-task-runner` skill when available:

`/Users/danielpatton/Documents/GitHub/promptops/.claude/skills/manciple-mcp-task-runner/SKILL.md`

If that path does not exist, use the discovered `manciple-mcp-task-runner` skill path from the active skill list.

## Coordinator Workflow

1. Detect the worker cap.
   - Determine the available cores before spawning workers. Prefer reliable local mechanisms available in the runtime, such as Node `os.availableParallelism()`, `nproc`, or `sysctl -n hw.ncpu`.
   - Use the detected core count only as the maximum safe worker count. If no safe core count can be determined, stop and report the blocker.

2. Get the deterministic dispatch plan.
   - Call `manciple_dispatch_plan` first when MCP tools are available. If MCP is unavailable, run `manciple dispatch-plan`.
   - Treat the returned assignments, deferrals, stop conditions, and verification commands as the scheduling source of truth.
   - Spawn only assignments returned by the dispatch plan. Do not hand-pick additional tasks, infer extra workers from CPU capacity, or override deferrals in the model.
   - If the user named task ids, still use the dispatch plan and spawn only matching returned assignments. Report any named task that is absent, deferred, or stopped.

3. Spawn the returned batch of agents in parallel using the `Task` tool.
   - Cap the batch at the smaller of the detected worker cap and the number of assignments returned by the dispatch plan.
   - Before spawning each worktree-mode assignment, call `manciple_prepare_worktree` with the control repo and task id. Use its returned `control_repo`, `workspace_path`, and `mode` in the worker prompt. If preparation fails, do not spawn that worker and do not fall back to the control repo. Release successfully prepared claims if the batch cannot be launched.
   - Each `Task` call must be fully self-contained; embed all required context directly in the `prompt` parameter. Workers have no access to conversation history.
   - When Manciple MCP tools are available, include only the control repo, workspace path, execution mode, skill file path, assigned task id, ownership boundary from the dispatch plan, and any dispatch-plan notes. Tell the worker to load compact task context with `manciple_get_task_packet` before editing.
   - When MCP tools are unavailable, include the compact packet from `manciple task-packet <task-id>` plus the dispatch-plan notes.
   - Tell workers they are not alone in the codebase, not to revert edits made by others, and to respect `allowed_paths`, `forbidden_paths`, and task spec write rules.
   - Tell workers to create their own Manciple run logs and status transitions against the control repo while editing only the workspace path.

4. Continue coordinator work while workers run.
   - Inspect broad repo state, likely conflict zones, or verification setup.
   - Do not duplicate assigned worker implementation.

5. Review each completed batch.
   - Wait for all workers in the batch before refreshing task state unless a worker failure blocks the run.
   - Review each worker's final report, changed files, status, run log evidence, and verification receipt.
   - Do not merge task branches directly. Submit `needs_review` tasks through Manciple review; approval performs the task gate, prospective verification, no-ff integration, completion transition, and successful cleanup transactionally.
   - After approvals integrate the batch, verify the control repo with `manciple_verify` using profile `coordinator` when MCP tools are available, or `manciple verify --profile coordinator` from the CLI. Report the returned receipt.
   - Run `manciple_check_lifecycle` when MCP tools are available, or `manciple check-lifecycle` from the CLI. If lifecycle placement issues are reported, move only misplaced task YAML files to the directory matching their status and re-run the lifecycle check.
   - Validate Manciple metadata with `manciple_validate` when MCP tools are available.
   - Get a fresh dispatch plan before starting any later batch. Stop when the plan returns no assignments or reports a stop condition.

6. Report the run.
   - Include each worker's assigned task or sidecar responsibility.
   - Include files changed, verification receipts, final task statuses, lifecycle check result, blockers, and follow-up work.
   - Explicitly call out any worker that could not complete its task or verify its changes.

Use `manciple_format_task` or `manciple format-task <task-id> --check` only when a specific task's YAML formatting is in scope or a receipt asks for scoped formatting evidence. Do not run routine whole-repo YAML formatting loops as coordinator housekeeping.

## Worker Prompt Template

Use this shape for every worker. Fill in ALL bracketed values before spawning; workers have no access to conversation history.

```text
Use the manciple-mcp-task-runner skill at [ABSOLUTE skill path, e.g. /Users/danielpatton/Documents/GitHub/promptops/.claude/skills/manciple-mcp-task-runner/SKILL.md] for this assignment.

Control repo: [ABSOLUTE primary checkout path]
Workspace path: [ABSOLUTE path returned by manciple_prepare_worktree]
Execution mode: [worktree/in_place]

You are Worker [NUMBER] of [TOTAL_WORKERS_THIS_BATCH] in a Manciple dispatch-plan batch. The coordinator used CPU capacity as a ceiling, but this assignment comes from manciple_dispatch_plan / manciple dispatch-plan. You are not alone in the codebase. Do not revert edits made by others; adapt to existing changes and keep your edits narrowly scoped.

Assigned task or responsibility:
[task id or sidecar responsibility from the dispatch plan]

Ownership boundary:
[assignment ownership boundary from the dispatch plan, or read-only verification scope]

Task context:
- MCP tools available: [yes/no]
- Execution mode: [worktree/in_place]
- Dispatch-plan notes: [minimal notes from the assignment, deferral, or stop-condition context]
- If yes: task id is the contract; load compact task context with manciple_get_task_packet before editing.
- If no: run manciple task-packet <task-id> before editing, or use this embedded compact packet: [packet]

Instructions:
- Use Manciple MCP tools or CLI commands as the source of truth.
- Use the control repo for task packets, status, run logs, and review state. Inspect, edit, and run implementation commands only in the workspace path.
- If assigned a task id, load compact context first, set it in_progress if needed, and obey allowed_paths, forbidden_paths, acceptance_criteria, verification.commands, and outputs_required.
- Compile the full prompt only when the compact packet is insufficient and domain context is explicitly needed.
- Do not edit files under .manciple/specs/tasks directly. Only status updates through manciple_set_status are allowed.
- Verify with manciple_verify profile worker or manciple verify --profile worker and report the returned receipt as the primary verification evidence.
- Use manciple_format_task or manciple format-task <task-id> --check only when scoped task YAML formatting evidence is needed.
- Create the Manciple run log against the control repo with workspace evidence, final task status, files changed, non-test commands, tests, acceptance evidence, risks, and the deterministic verify receipt; then set final task status according to manciple-mcp-task-runner.
- For completed implementation work that changed behavior, include Decisions Made; omit it only when blocked before meaningful changes.
- In your final response, report task id, final status, files changed, verification receipt, risks, blockers, and follow-ups.
```
