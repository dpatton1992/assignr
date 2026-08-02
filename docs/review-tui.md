# Review TUI

`manciple review` opens an interactive review dashboard in your terminal. It is
a queue-first workflow: triage the `needs_review` bucket, open a task, inspect
the assembled evidence and scope drift, and record a durable review decision.

The dashboard is a view over two read-only contracts:

- Each task detail is a view over the **ReviewPacket** — the canonical
  assembled review contract (see [ReviewPacket](#reviewpacket)).
- The graph overlay is a view over the **TaskGraphPacket** — the canonical
  graph contract (see [TaskGraphPacket](#taskgraphpacket)).

The TUI never assembles evidence itself. It reads queue rows, packets, and
graphs through injected services that return those assembled contracts; it
never opens task YAML, run logs, generated prompts, or git state to render a
screen.

## Starting The TUI

Run the bare command in a real terminal:

```bash
manciple review
```

When stdout is a TTY the interactive dashboard launches. When stdout is piped
or redirected (scripts, CI, `manciple review | cat`), the command prints the
`review` help text and exits — it never hangs waiting for a terminal.

To review a single task non-interactively, keep using the subcommands:

```bash
manciple review <task-id>          # render a review prompt
manciple review-check <task-id>    # readiness gate
manciple review packet <task-id>   # assembled ReviewPacket summary
```

## Queue List

The first screen is the queue, grouped into three buckets:

- **Needs review** (yellow)
- **Blocked** (red)
- **Completed** (green)

Each row shows the task id, title, priority, and domain. The queue is loaded
once through the review service and refreshed only after a decision succeeds —
the dashboard never re-reads task files to reorder rows.

| Key | Action |
|---|---|
| `j` / `↓` | Move selection down |
| `k` / `↑` | Move selection up |
| `enter` | Open the selected task's ReviewPacket detail |
| `g` | Open the task graph focused on the selected task |
| `q` / `Escape` | Quit the TUI |
| `Ctrl-C` | Quit the TUI |

## Task Detail

The detail screen renders the selected task's ReviewPacket. It shows, in order:

- **Header** — task id, title, status (`needs_review`/`blocked`/`complete`),
  tier, readiness score out of 100, ready/not-ready, domain, and priority.
- **Goal** — the one-sentence contract.
- **Scope drift** — changed-path count split into in-scope, out-of-scope, and
  forbidden; a `⚠ DRIFT` marker appears when any changed path falls outside
  `allowed_paths` or inside `forbidden_paths`. Each out-of-scope and forbidden
  path is listed with the matched pattern.
- **Changed files** — count, source (`log` from the run log or `git` from
  `git status`), and insert/delete diffstat when git can compute one.
- **Acceptance** — covered count and one line per criterion, `✓` when the run
  log records evidence for it and `✗` when not, with the recorded evidence.
- **Verification** — whether required commands are recorded, then one line per
  required command with its outcome (`passed`, `failed`, `skipped`, `missing`).
- **Risks** — documented residual risks from the run log.
- **Worker** — decisions made, follow-ups, and worker notes from the run log.
- **Receipt** — whether a verification receipt is on record, its result, and
  any receipt parse error.
- **Dependencies** — declared `depends_on` entries with status and completion.
- **Warnings** — human-review reasons surfaced by readiness evaluation.
- **Available decisions** — the actions currently enabled for this task.

| Key | Action |
|---|---|
| `j` / `↓` | Scroll down one line |
| `k` / `↑` | Scroll up one line |
| `d` | Open the task-scoped git diff in the pager |
| `r` | Open the verification receipt (in-view when short, pager when long) |
| `t` | Switch to the tests/commands view |
| `g` | Open the task graph (falls back to the dependencies view without a graph service) |
| `a` | Confirm **approve** |
| `e` | Request changes (reason required) |
| `x` | Reject the task (reason required) |
| `o` | Reopen a completed or archived task |
| `q` / `Escape` | Return to the queue list |

The tests view lists each required verification command with its recorded
outcome. The dependencies view lists declared dependencies with `✓` for
complete and `…` otherwise. Both return to the detail with `q` or `Escape`.

## Pager Round-Trip

Two actions hand content to your pager instead of rendering it inline:

- **`d`** builds a task-scoped `git diff HEAD` limited to the packet's changed
  paths. Untracked paths are listed in a separate section because `git diff`
  cannot show them. This is an explicit user action — git is never read to
  render the dashboard itself.
- **`r`** opens the receipt when it is long (more than 4000 characters or
  more than 60 lines); short receipts render inline.

The pager runs after the Ink renderer unmounts (restoring the terminal), and
the app re-renders afterwards from the preserved session, returning you to the
same task, view, and scroll position.

The pager command comes from `$PAGER` (arguments allowed, e.g. `less -R`).
When `$PAGER` is unset the default is `less -R`. If no pager is configured,
the pager cannot be spawned (e.g. `ENOENT`), or the pager exits nonzero, the
content is printed inline to the restored terminal — you are never left
without the content.

All external processes spawn with argument arrays, never shell interpolation
of task ids, paths, reasons, or environment values.

## Review Decisions

Decisions are durable lifecycle mutations performed by the shared review
action layer, then reflected back into the queue by reloading it. Long diffs
and full context stay out of the dashboard; the decision screen shows the
task, the current status, and the next status.

| Decision | Key | Reason | Lifecycle effect |
|---|---|---|---|
| Approve | `a` | not required | `needs_review` → `complete`, moved to `tasks/completed/` |
| Request changes | `e` | **required**, nonblank | `needs_review` → `in_progress` |
| Reject | `x` | **required**, nonblank | `needs_review` → `failed` |
| Block | — (no TUI key; use `manciple review block <task-id> --reason <text>` or MCP) | **required**, nonblank | `needs_review` → `blocked` |
| Reopen | `o` | not required | `completed`/`archived` → `in_progress`, moved back to `tasks/active/` |

Approve and reopen show a confirmation prompt (`y` confirm, `n` or `Escape`
cancel). Request changes and reject open a reason prompt: type the reason,
`enter` confirms, `Escape` cancels, `backspace` edits. A blank reason is
rejected with an inline error. Each decision writes a durable
`<timestamp>-<task-id>-review-outcome.md` receipt under `.manciple/runs/`
(with approve/reject/block/request-changes; reopen moves the task file).

Note: only the decisions listed in the packet's `availableDecisions` are
enabled — for example `reopen` only appears for completed or archived tasks,
and the needs-review decisions only for active `needs_review` tasks. The
`block` decision is shown in the packet's available decisions but has no TUI
keybinding; record it from the CLI (`manciple review block <task-id> --reason
<text>`), the MCP `manciple_review_decision` tool, or the shared action
layer.

## Task Graph

Press `g` from the queue list or from a task detail to open the graph overlay
focused on a task. The graph is a view over TaskGraphPacket and opens in the
task's neighborhood (default depth 2 in both directions).

### Lenses

`Tab` cycles through four lenses. Every lens keeps the same topology — only
edge emphasis, badges, counts, warnings, and the detail panel change:

- **Dependencies** — emphasizes `depends_on` and `blocks` edges; warns about
  dependency cycles and dangling references.
- **Ownership** — emphasizes `ownership_overlap` edges; warns about
  `LOCKED`-path and `UNSAFE`-parallel collisions.
- **Receipts** — shows run-log receipt health (`passing`, `failing`,
  `incomplete`, `missing`) and verification health; warns about failing and
  missing receipts.
- **Status** — shows lifecycle status badges and counts; warns about blocked
  tasks.

### Navigation

| Key | Action |
|---|---|
| `j` / `↓` | Move selection down |
| `k` / `↑` | Move selection up |
| `h` | Jump to the selected task's upstream neighbor (dependencies / blockers) |
| `l` | Jump to the selected task's downstream neighbor (dependents / blocked) |
| `enter` | Drill down: open the selected task's ReviewPacket detail |
| `Tab` | Cycle lens: Dependencies → Ownership → Receipts → Status |
| `+` / `=` | Increase neighborhood depth (1–5, then unbounded `∞`) |
| `-` / `_` | Decrease neighborhood depth |
| `a` | Toggle **all-active** mode (load every lifecycle tier instead of the focus neighborhood) |
| `s` | Cycle status filter |
| `d` | Cycle domain filter |
| `t` | Cycle tier filter (`all` → `active` → `completed` → `archived`) |
| `e` | Cycle edge-type filter (`all` → `depends_on` → `blocks` → `conflicts_with` → `ownership_overlap`) |
| `r` | Reset all filters to defaults (depth 2, all lenses, no filters) |
| `g` / `q` / `Escape` | Return to the previous review view |

The header shows the focus task, lens, depth, mode (`focus` or `all-active`),
active filters, and node/edge counts. Warnings render per lens under the grid,
and a per-task detail panel shows upstream/downstream neighbors and cycles
(Dependencies), locked/unsafe paths and overlap severity (Ownership), receipt
and verification health with missing/failed commands (Receipts), and status
counts (Status).

### Layout And Narrow Terminals

In terminals at least 68 columns wide the graph renders as a layered grid:
dependency columns anchored at the focus task (`up 1`, `up 2`, …, `focus`,
`down 1`, …) with node ids and `[status] [receipt-health]` badges, followed by
an edge list. Below that width it switches to an indented focus list: the
selected node at the top with its incident edges, badges, and direction
(`→`/`←` for directed edges, `—` for undirected). The layout follows terminal
resize events.

### Legend

```text
─▶ depends_on (A depends on B) · ▸▶ blocks (A blocks B) · ══ conflicts_with · ~~ ownership_overlap
```

### Ownership Collision Severity

Ownership overlaps are classified by strength, strongest first:

- **LOCKED** — one task's `locked_paths` overlap another task's scope.
- **UNSAFE** — an `unsafe_parallel_area` overlap.
- **touched** — an explicit `touched_paths` overlap.
- **allowed** — only ordinary `allowed_paths` overlap (the weakest form).

### Recovery

- If the active filters exclude the focus task entirely, the graph falls back
  to the same filters without the focus so you still see the filtered node set.
- A graph assembly error renders an error panel with `g` or `Escape` to return.
- If a filter change leaves the selected node invisible, selection moves to
  the focus task or the first visible node instead of failing.

## ReviewPacket

`ReviewPacket` is the canonical assembled review contract for one task. CLI,
MCP, web, and TUI clients receive this object instead of assembling evidence
from repository files themselves. Clients never read task YAML, run logs,
generated prompts, or git state to construct a review view; that assembly
happens once, in the packet builder, and everything downstream renders the
result.

The packet is deterministic and JSON-safe: every path is repo-relative.

Key fields:

- **Identity** — `taskId`, `title`, `status`, `tier`, `domain`, `priority`,
  `goal`.
- **claimedScope** — the task's declared `allowedPaths` and `forbiddenPaths`.
- **Changed-path provenance** — `changedFilesSource` (`run-log`,
  `git-status`, or `unavailable`) and `changedPaths`, each entry carrying its
  `source`, whether it is `inAllowedPaths` / `inForbiddenPaths`, and the
  matched `forbiddenPattern` when one exists.
- **scopeDrift** — `changedPaths`, `outOfScopePaths`, `forbiddenPaths`,
  declared allowed/forbidden patterns, and `hasDrift`.
- **acceptanceCriteria** — each criterion with its recorded `evidence` and
  `covered` flag.
- **verification** — `requiredCommands`, per-command `commandOutcomes`
  (`passed` / `failed` / `skipped` / `missing`), `failedOrMissingChecks`, and
  `hasVerification`.
- **receipt** — the latest run log's `result`, whether a verification receipt
  is on record, its text, and any parse error.
- **workerNotes** — `decisionsMade`, `followUps`, `risks`, `notes`.
- **risks**, **warnings** (human-review reasons), and **blockers**
  (deterministic-gate blockers for the task).
- **dependencies** — declared `depends_on` entries with status and completion.
- **diffSummary** — changed-file count, source, and insert/delete counts.
- **availableDecisions** — the review actions currently enabled, with labels.
- **readiness** — the full readiness report (score, ready flag, uncovered
  criteria, absent/failed commands, documented risks).

## TaskGraphPacket

`TaskGraphPacket` is the canonical graph contract: a presentation-neutral,
deterministic, JSON-safe object of `nodes`, `edges`, `counts`, `filters`, and
`referencedButAbsent` ids. CLI, TUI, MCP, and web clients consume this instead
of assembling graph state from task YAML, run logs, readiness reports, or
path-ownership files. No raw absolute path or full run-log body is embedded.

- **Nodes** — one per task: identity, tier/status, allowed/forbidden paths,
  path-ownership claims (`touchedPaths`, `lockedPaths`, `unsafeParallelAreas`),
  receipt health, verification health, documented risks, and whether a
  detailed ReviewPacket can be assembled (`hasDetailedReviewPacket`).
- **Edges** — four types:
  - `depends_on` — directed; source depends on target.
  - `blocks` — directed; source blocks target.
  - `conflicts_with` — undirected.
  - `ownership_overlap` — undirected, with matched patterns and a severity
    (`allowed` / `touched` / `unsafe_parallel_area` / `locked`).
- **Receipt-health states** — `missing` (no run log), `incomplete` (run log
  present but no recorded verification), `passing`, or `failing` (failed
  result or failed verification commands). A command mention without a
  recorded result is never classified as passing, and superseded run logs are
  skipped.
- **Lifecycle tiers and statuses** — by default the node set contains all
  active tasks plus completed or archived tasks directly referenced by them.
  `allTasks` mode (or `tier: "all"`) loads every tier, and tier/status/domain
  filters apply to the node set.
- **Default neighborhood scope** — with a `focusTask`, nodes and edges are
  restricted to the focus task's neighborhood traversing both incoming and
  outgoing edges up to `depth` (default 2; `-1` or `Infinity` is unbounded).
- **Filtering behavior** — `depth`, `tier`, `status`, `domain`, and
  `edgeTypes` are all reflected in `filters` metadata; edges referencing a
  task absent from the packet are kept and reported in `referencedButAbsent`
  so dangling references stay visible.

## Deep Diffs Belong In Your Pager

The initial TUI is a triage and decision surface: it shows packet evidence,
scope drift, receipt health, and decisions. Deep diffs belong in your pager,
`delta`, or editor — the `d` key opens exactly the task-scoped diff you ask
for, and nothing renders a full diff inline in the dashboard.
