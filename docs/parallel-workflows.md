# Parallel Workflows

Manciple is designed for small tasks that can move through a coordinator without
turning into long-lived branches. The dependency graph and path ownership fields
make parallel work explicit before agents start editing files.

## Dependency Fields

Use `depends_on` for work this task must wait for. Use `blocks` for work this
task unlocks. Use `conflicts_with` for tasks that should not run at the same
time. Use `can_run_independently` to tell a coordinator whether nearby work can
be scheduled without waiting.

```yaml
depends_on:
  - add-auth-session-model
blocks:
  - document-login-flow
conflicts_with:
  - refactor-auth-router
can_run_independently: false
allowed_paths:
  - src/features/auth/**
  - tests/auth/**
path_ownership:
  touched_paths:
    - src/features/auth/**
  locked_paths:
    - src/features/auth/session.ts
  unsafe_parallel_areas:
    - src/features/auth/router.ts
```

## Path Ownership

Path ownership helps a coordinator avoid collisions before compile and spot
rework after a run. `touched_paths` describe the expected edit surface,
`locked_paths` describe files that should not have concurrent writers, and
`unsafe_parallel_areas` describe areas where nearby changes are likely to
interact.

Path locks and unsafe parallel areas are scheduling and review signals. They do
not create filesystem locks.

## Managed Worktrees

Worktrees are enabled by default, including for repositories whose existing
config omits the setting. The explicit config is:

```yaml
root: .manciple
worktrees:
  enabled: true
```

Set `enabled: false` to retain in-place automation. `--worktrees` and
`--no-worktrees` override that policy for `task start`, `task resume`,
`coordinator`, `dispatch-plan`, and `handoff queue`. These flags affect
automation only; explicit `manciple worktree ...` maintenance commands remain
available.

The primary checkout is the control plane for task specs, status, dispatch,
run logs, and review outcomes. Worker code changes belong in the task workspace
returned by Manciple, normally `.manciple/worktrees/<task-id>` on branch
`manciple/<task-id>`. A worker must not substitute the primary checkout if
worktree preparation fails.

```bash
manciple task start build-login-page
manciple worktree status build-login-page
```

Agents call `manciple_prepare_worktree` and use its `control_repo`,
`workspace_path`, and `mode` result. Verification uses the control repo as
`repo` and the returned workspace as `workspace`; run logs use the same split
so durable evidence stays central while Git evidence comes from the task branch.
The CLI exposes the same evidence split with
`manciple run-log <task-id> --workspace <workspace-path>` and
`manciple submit <task-id> --workspace <workspace-path> ...`. Manciple validates
that the path is the registered workspace for that task before reading Git
evidence from its base SHA.

Explicit maintenance commands are available for operators:

```bash
manciple worktree create <task-id>   # `manciple worktree <task-id>` also works
manciple worktree list --json
manciple worktree status <task-id> --json
manciple worktree release <task-id>
manciple worktree remove <task-id>
manciple worktree prune
```

Creation fails closed when the primary checkout has code changes, the path is
unrelated, the repo is not the primary Git checkout, or the task is not eligible.
Manciple records claims in Git's common directory so every linked checkout sees
the same assignment state.

## Review And Integration

A worker finishes by writing its run log against the control repo and moving the
task to `needs_review`. Review packets and deterministic gates read code evidence
from the registered worktree and central lifecycle evidence from the control
repo.

Approval is the integration transaction. Manciple validates the complete task
diff against path policy, commits remaining workspace changes, creates a
temporary integration checkout, performs a no-fast-forward prospective merge,
runs the task's verification commands there, and only then performs the same
no-fast-forward merge in the primary checkout. After that succeeds it records
the review outcome, marks the task complete, and removes the managed worktree
and branch.

Verification, merge, or review failures leave the task branch and worktree in
place for inspection or rework. The primary branch is not moved when prospective
verification fails. Direct completion commands are rejected for managed tasks;
they must go through review approval so integration cannot be bypassed.

## Coordinator Owner Loop

1. Run `manciple dispatch-plan` or call `manciple_dispatch_plan`.
2. Spawn only the returned assignments, capped by available worker capacity.
3. Leave deferred work in the queue when the plan reports dependencies, locks,
   unsafe areas, or stop conditions.
4. Prepare each returned worktree assignment and pass both the control repo and
   workspace path to its worker.
5. Review run logs, changed files, and verification receipts for completed
   slices.
6. Approve ready tasks through Manciple review so integration remains
   transactional, then verify the integrated control repo with
   `manciple_verify` profile `coordinator`.
7. Send overlapping or under-evidenced work back as rework instead of stacking
   more branches on top.

Workers should start from `manciple task-packet <task-id>` or
`manciple_get_task_packet`, prepare with `manciple_prepare_worktree`, and verify
with `manciple_verify` profile `worker` using the returned workspace. Use `manciple format-task <task-id> --check`
or `manciple_format_task` only when scoped task YAML formatting evidence is part
of the work.

Every worker receipt should include files changed, verification receipt,
decisions made, risks, and follow-ups. Merge-readiness scoring and review queue
packets are aids for that owner loop: they summarize evidence and risk, but they
do not replace a human review of the task contract, diff, and integration
behavior.

Prefer merging a verified small slice promptly over keeping many broad branches
open.
