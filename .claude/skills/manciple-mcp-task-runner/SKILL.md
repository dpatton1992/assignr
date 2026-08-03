---
name: manciple-mcp-task-runner
description: Complete Manciple task work using the Manciple MCP server, optionally focused on implementation, docs, test, refactor, review, or hardening work; default to any of those task types when no focus is given. Use when the user asks Claude Code to run, complete, pick up, execute, or work through a Manciple task in this repo, especially when MCP tools named manciple_get_task_packet, manciple_verify, manciple_format_task, manciple_set_status, or manciple_run_log are available.
---

# Manciple MCP Task Runner

Use Manciple as the source of truth for task scope. Prefer deterministic MCP tools over model-selected local command sequences whenever they are available.

## Optional Focus

The caller may provide `focus: implementation`, `docs`, `test`, `refactor`, `review`, `hardening`, or `any`. For a named task id, run that exact task even if its type differs from the focus. For "choose a task" requests, use `manciple_dispatch_plan` or `manciple dispatch-plan` and select only a returned assignment matching the requested focus.

Once a task is selected, obey the task spec exactly. Do not expand or shrink `allowed_paths`, `forbidden_paths`, acceptance criteria, verification, or outputs because of the focus.

## Workflow

1. Discover compact task context.
   - If the user names a task id, call `manciple_get_task_packet` first. If MCP is unavailable, run `manciple task-packet <task-id>`.
   - If asked to choose a task, use `manciple_dispatch_plan` first, then load the packet for one returned assignment.
   - Use the packet fields as the default worker context: status, dependencies, allowed and forbidden paths, path ownership warnings, acceptance criteria, implementation notes, verification commands, outputs required, and notes.
   - Call `manciple_get_task` only when you need the full YAML shape. Call `manciple_compile` only when the compact packet is insufficient and explicit domain context or full prompt prose is needed.

2. Start the task.
   - Call `manciple_prepare_worktree` with the control repo and task id. This is the authoritative start operation: it marks a pending task `in_progress`, claims or creates its managed worktree when enabled, and returns `control_repo`, `workspace_path`, and `mode`.
   - If preparation fails, stop. Do not silently fall back to editing the control repo, because that would mask worktree defects during dogfooding.
   - Treat `allowed_paths`, `forbidden_paths`, `acceptance_criteria`, `implementation_notes`, `verification_commands`, and `outputs_required` as binding constraints.

3. Implement the work.
   - Inspect and edit only the returned `workspace_path`. The returned `control_repo` remains the central task, run-log, dispatch, and review state plane.
   - Do not edit files under `.manciple/specs/tasks/` directly. Task status updates must go through `manciple_set_status`.
   - Stay inside `allowed_paths` when present. Do not edit `forbidden_paths` unless the user explicitly overrides the task.
   - Keep changes scoped to the task. If required work is outside scope, stop and report it as a follow-up instead of silently expanding the task.

4. Verify.
   - Prefer `manciple_verify` with `repo` set to `control_repo`, `workspace` set to `workspace_path`, and profile `worker` when MCP tools are available. If the returned mode is `in_place`, the two paths are the same. Report the returned receipt.
   - Treat that deterministic worker receipt as the primary verification evidence. Do not stack routine manual checklists on top of it; run additional targeted checks only when they are directly relevant to files changed or needed to diagnose a failure.
   - Use `manciple_format_task` with `check_only: true` or `manciple format-task <task-id> --check` only when scoped task YAML formatting evidence is needed. Do not run routine whole-repo YAML formatting loops during worker completion.

5. Finish.
   - Call `manciple_run_log` against `control_repo` with `workspace` set to `workspace_path` after implementation and verification. Include final task status, files changed, non-test commands in `commands_run`, test commands or receipts in `tests_run`, the deterministic verify receipt, acceptance criteria evidence, result, notes, and residual risks.
   - Format each acceptance evidence line as `<exact criterion text> => <evidence>`. Do not paraphrase the criterion on the left side; deterministic review uses the exact task text as the mapping key.
   - For completed implementation work that changed behavior, include `Decisions Made`; omit it only when the task was blocked before meaningful changes.
   - Call `manciple_validate` before final status updates when task specs may have changed or the assignment requests metadata validation.
   - Set status with `manciple_set_status`:
     - `needs_review` when implementation is complete and verification passes.
     - `blocked` when progress is stopped by missing information, failing prerequisites, or scope conflicts.
     - `partial` when meaningful work landed but acceptance criteria are not complete.
     - `failed` only when the attempted task could not be completed and no useful partial result remains.

## Tool Result Handling

Manciple MCP tool responses return JSON as text content. Parse the text before using it. If a tool result has `isError: true`, treat the JSON `error` as an operational error, not as a crashed server.

Use `manciple_compile` content directly only after deciding full prompt context is necessary. Use `manciple_get_compiled_prompt` only when a generated prompt may already exist or the user specifically asks for it.

## Reporting

In the final response, include:

- task id and final status
- files changed
- verification receipt or commands run and whether they passed
- risks, blockers, and follow-up tasks requested by `outputs_required`

Keep the report concise, but preserve concrete command names and failure details.

## CLI/MCP Parity

When working on Manciple itself, keep CLI and MCP behavior aligned. Prefer shared task-operation logic for features exposed by both surfaces, with thin CLI formatting and MCP JSON result layers. Use separate specs only for transport-specific behavior such as terminal output, stdio protocol handling, and MCP error formatting.
