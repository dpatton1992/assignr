# MCP Server

Manciple includes an MCP server for agents that can call tools directly.

```bash
manciple mcp-config
```

`manciple mcp-config` creates or updates `.mcp.json` for the repo. Restart your
agent client after writing `.mcp.json` so it loads the new server definition.

The MCP binary is `manciple-mcp`.

## Tools

The MCP surface mirrors the core workflow:

| Tool | Purpose |
|---|---|---|
| `manciple_list` | List tasks. |
| `manciple_get_task` | Read a task spec. |
| `manciple_get_task_packet` | Read compact bounded worker context for one task. |
| `manciple_compile` | Compile a task prompt. |
| `manciple_get_compiled_prompt` | Read an existing generated prompt. |
| `manciple_dispatch_plan` | Build deterministic coordinator assignments, deferrals, stop conditions, and verification commands. |
| `manciple_verify` | Run a deterministic verification profile and return a compact receipt. |
| `manciple_format_task` | Check or format one task YAML file by task id. |
| `manciple_check_lifecycle` | Validate task files live in the lifecycle directory matching their status. |
| `manciple_validate` | Validate task specs. |
| `manciple_set_status` | Update task status. |
| `manciple_run_log` | Create a run log. |
| `manciple_prepare_worktree` | Start a task and create or claim its configured execution workspace. |
| `manciple_get_worktree` | Return one managed task worktree record. |
| `manciple_list_worktrees` | List managed worktree records and claim states. |
| `manciple_release_worktree` | Release a claim for redispatch. |
| `manciple_remove_worktree` | Remove a registered worktree and local task branch. |
| `manciple_prune_worktrees` | Prune stale managed records and Git worktree metadata. |
| `manciple_list_review_queue` | Return the assembled review queue summary (`needsReview`, `blocked`, `completed` buckets). |
| `manciple_get_review_packet` | Return the assembled ReviewPacket for one task. |
| `manciple_review_decision` | Record one review decision (approve, request_changes, reject, block, reopen). |

Agent skills use `manciple_dispatch_plan` before spawning workers,
`manciple_get_task_packet` before task edits, `manciple_prepare_worktree` before
implementation, and `manciple_verify` for worker,
coordinator, or review receipts. Use `manciple_format_task` with `check_only`
when a task needs scoped YAML formatting evidence.

For managed work, pass the primary checkout as `repo` and the prepared task
workspace as `workspace` to `manciple_verify` and `manciple_run_log`. Approval
then verifies a prospective no-ff merge and integrates it transactionally.

The review tools (`manciple_list_review_queue`, `manciple_get_review_packet`,
`manciple_review_decision`) are thin adapters over the same assembled
ReviewPacket and review action services the CLI uses. Field names and enum
values in their JSON results match the CLI-facing application layer, so web,
CLI, and MCP clients consume one contract.

For the human CLI workflow, see [Getting Started](getting-started.md). For the
interactive review dashboard, see [Review TUI](review-tui.md).

## Review Examples

The `repo` argument scopes the operation to a repository checkout; it is
optional and defaults to the MCP server's working directory.

### Queue Retrieval

```json
{
  "name": "manciple_list_review_queue",
  "arguments": { "repo": "/path/to/repo" }
}
```

Returns the assembled `ReviewQueueSummary`:

```json
{
  "needsReview": { "rows": [{ "taskId": "build-login-page", "title": "Build login page", "status": "needs_review", "tier": "active", "domain": "auth", "priority": "high" }], "count": 1 },
  "blocked": { "rows": [], "count": 0 },
  "completed": { "rows": [], "count": 0 },
  "total": 1
}
```

### One-Task Packet Retrieval

```json
{
  "name": "manciple_get_review_packet",
  "arguments": { "repo": "/path/to/repo", "task_id": "build-login-page" }
}
```

Returns the full assembled ReviewPacket — claimed scope, changed-path
provenance, scope drift, acceptance coverage, verification outcomes, receipt,
worker notes, risks, warnings, blockers, dependencies, diff summary, available
decisions, and the readiness report. Clients consume this packet directly; the
server assembles evidence from repository files once, so clients never
independently assemble it.

### Review Decisions

`manciple_review_decision` takes `task_id`, `action`, and an optional
`reason`. `reason` is required for `request_changes`, `reject`, and `block`;
passing an empty or missing reason returns an error.

```json
{
  "name": "manciple_review_decision",
  "arguments": { "repo": "/path/to/repo", "task_id": "build-login-page", "action": "approve" }
}
```

```json
{
  "name": "manciple_review_decision",
  "arguments": { "repo": "/path/to/repo", "task_id": "build-login-page", "action": "request_changes", "reason": "Add password-reset test evidence." }
}
```

```json
{
  "name": "manciple_review_decision",
  "arguments": { "repo": "/path/to/repo", "task_id": "build-login-page", "action": "reject", "reason": "Acceptance criteria not satisfied." }
}
```

```json
{
  "name": "manciple_review_decision",
  "arguments": { "repo": "/path/to/repo", "task_id": "build-login-page", "action": "block", "reason": "Depends on unresolved auth migration." }
}
```

```json
{
  "name": "manciple_review_decision",
  "arguments": { "repo": "/path/to/repo", "task_id": "build-login-page", "action": "reopen" }
}
```

Each decision returns the shared action result (`taskId`, `outcome`,
`previousStatus`, `nextStatus`, `taskPath`, and the review-outcome receipt
path when one is written) and applies the same lifecycle effects as the CLI:

| Action | Reason | Lifecycle effect |
|---|---|---|
| `approve` | not required | Managed worktrees are verified and no-ff merged, then `needs_review` → `complete`; unmanaged tasks retain the lifecycle-only behavior. |
| `request_changes` | required, nonblank | `needs_review` → `in_progress` |
| `reject` | required, nonblank | `needs_review` → `failed` |
| `block` | required, nonblank | `needs_review` → `blocked` |
| `reopen` | not required | `complete`/`archived` → `in_progress` (moved back to `tasks/active/`) |
