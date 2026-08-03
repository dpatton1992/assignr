# Task Lifecycle

Manciple keeps active work separate from audit history. New tasks start in
`.manciple/tasks/active`, which is the default context agents use when listing,
compiling, validating, and choosing work.

## Task Directories

```text
.manciple/tasks/
  active/      # pending, in-progress, blocked, and needs-review work
  completed/   # accepted or finished task history
  archived/    # abandoned or superseded task history
```

Use `active` for work that still needs attention. Use `completed` for accepted
or finished tasks that should remain available as history. Use `archived` for
work that was abandoned, superseded, or intentionally removed from the active
queue.

## Status Semantics

Active task files can move through statuses such as `pending`, `in_progress`,
`blocked`, and `needs_review`. A task in `needs_review` is still active because
it needs an independent reviewer decision.

Completed and archived task files are kept out of the default active queue.
They remain useful for audit history, planning context, and later inspection
with lifecycle-aware list flags.

## Lifecycle Commands

Move accepted or finished active work to completed history:

```bash
manciple complete build-login-page
```

That direct command is for unmanaged, in-place tasks. A task with a registered
managed worktree must use `manciple review approve <task-id>`; Manciple rejects
direct completion so verification and branch integration cannot be skipped.

Archive obsolete active work:

```bash
manciple archive replace-legacy-router
```

Move a completed or archived task back into active work:

```bash
manciple reopen replace-legacy-router
```

Inspect lifecycle history when you need it:

```bash
manciple list --completed
manciple list --archived
manciple list --all
```

Validate that task files live in the directory matching their status:

```bash
manciple check-lifecycle
```

Repos that still use the old flat task layout can migrate task files into the
lifecycle directories:

```bash
manciple migrate-tasks
```

Repos that were initialized before the package rename can migrate `.assignr/`
repo artifacts and MCP/agent config to Manciple:

```bash
manciple migrate-assignr --dry-run
manciple migrate-assignr
```

Use `manciple migrate-assignr --yes` for non-interactive migration.

For first-run setup, start with [Getting Started](getting-started.md).
