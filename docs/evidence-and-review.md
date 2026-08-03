# Evidence And Review

`needs_review` means implementation work is finished enough for an independent
reviewer to judge it from evidence instead of conversation. The task stays in
the active queue, but it should have a run log that names the agent, commands
run, files changed, result, and known risks.

## Run Log Evidence

Record evidence after an agent finishes:

```bash
manciple run-log build-login-page \
  --result complete \
  --agent Codex \
  --model gpt-5-codex \
  --command "pnpm test -- auth" \
  --file "src/features/auth/LoginPage.tsx" \
  --risks "No known risks."
```

Useful run logs include:

- result
- agent and model
- commands run
- files changed
- known risks

## Review Prompts And Readiness

Move the task to review and generate a reviewer prompt:

```bash
manciple set-status build-login-page needs_review
manciple review build-login-page
manciple review-check build-login-page
```

`manciple review` generates a reviewer prompt with the task context, latest run
log evidence, git diff, checklist items, and a decision section.

`manciple review-check` is the quick readiness gate. It helps catch missing
evidence, unrecorded verification, and scope concerns before someone spends
attention on a deeper review.

For batch triage and deep review, see [Review Queue](review-queue.md).

## Reviewer Decisions

Approve work that satisfies the task contract:

```bash
manciple approve build-login-page
```

For a managed worktree, approval first runs the deterministic gate, commits any
remaining task changes, verifies a prospective no-ff merge in a temporary
checkout, and integrates the branch. Only a successful integration records the
approval and moves the task to completed. Failures retain the task workspace for
inspection or rework.

Return work that needs changes:

```bash
manciple request-changes build-login-page --reason "Missing password-reset test evidence."
```

Block review when a dependency or external issue prevents a fair decision:

```bash
manciple block-review build-login-page --reason "Depends on unresolved auth migration."
```

## Implementation And Integration Review

Implementation review asks whether one task satisfied its acceptance criteria
inside its allowed paths.

Integration review asks whether several accepted tasks still work together in
the repo. In multi-agent runs, each worker should leave implementation evidence
on its own task; the coordinator or reviewer can then use integration review for
cross-task conflicts, shared behavior, and final batch confidence.
