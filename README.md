# Manciple

**Repo-native task orchestration for coding agents.**

[Website](docs/index.html) | [Getting Started](docs/getting-started.md) | [MCP Server](docs/mcp-server.md)

Manciple turns vague coding-agent handoffs into scoped, reviewable work units that live inside your repo.

Agents are good at writing code. They are much worse at knowing where to stop, what evidence to leave behind, and how to keep parallel work from colliding. Manciple gives them a contract:

* what to change
* what not to touch
* how to verify it
* what evidence to produce
* when the work is ready for human review

No SaaS dashboard. No external database. No new agent runtime.

Just structured task specs, generated prompts, run logs, review evidence, and lifecycle state committed alongside the code.

> Formerly Assignr. Same workflow. Better name.

---

## Why Manciple exists

Most agent workflows start like this:

> Can you clean up login? The errors are confusing, the tests are flaky, and support says password reset broke after the session refactor. Please fix what you find and make sure auth still works.

That works until it doesn’t.

The agent touches too many files.
The tests are unclear.
The “done” state is vibes.
The next agent has no idea what happened.
The reviewer has to reconstruct the entire crime scene from a diff and a chat transcript.

Manciple turns that blob into a repo-native work contract.

```bash
manciple task new "Fix password reset session handling" \
  --type implementation \
  --domain auth \
  --priority high

manciple handoff fix-password-reset-session-handling
```

```yaml
goal: Fix password reset failures caused by the session refactor.

acceptance_criteria:
  - Expired reset links show a clear error.
  - Valid reset links create a fresh session.

allowed_paths:
  - src/features/auth/**
  - tests/auth/**

verification:
  commands:
    - pnpm test -- auth

outputs_required:
  - files_changed
  - tests_run
  - risks
```

![manciple task planning output](docs/images/planning-output.png)

Now the agent has boundaries, the reviewer has evidence, and the repo has memory.

---

## The workflow

Manciple is built around a simple loop:

```text
plan → task spec → agent handoff → run log → review → accept / rework
```

Each task is plain YAML. Each handoff is a generated prompt. Each run produces evidence. Each review has something concrete to check.

```text
.manciple/
  config.yaml
  domains.yaml
  tasks/
    active/
    completed/
    archived/
  prompts/
    generated/
  runs/
  reviews/
```

Your repo becomes the source of truth for agent work.

---

## What you get

### Scoped agent prompts

Compile task specs into prompts for Claude Code, Codex, Cursor, OpenCode, Aider, Goose, or whatever agent you already use.

```bash
manciple handoff build-login-page
```

The prompt includes the goal, acceptance criteria, allowed paths, verification commands, required outputs, and review expectations.

---

### Path boundaries

Tell agents where they are allowed to work.

```yaml
allowed_paths:
  - src/features/auth/**
  - tests/auth/**
```

This does not magically sandbox your filesystem. It gives the agent and reviewer an explicit contract, then makes violations obvious during review.

---

### Run logs

Capture what actually happened.

```bash
manciple run-log build-login-page \
  --result complete \
  --agent Codex \
  --model gpt-5-codex \
  --command "pnpm test -- auth" \
  --file "src/features/auth/LoginPage.tsx" \
  --risks "No known risks."
```

No more “the agent said it worked” as the only artifact.

---

### Review readiness

Before you burn reviewer time, check whether the task has the evidence it promised.

```bash
manciple review-check build-login-page
manciple review build-login-page
```

Reviewers get the original contract, the claimed changes, the files touched, the tests run, and the risks called out.

For the interactive review dashboard — queue triage, packet evidence, task graph, and durable decisions — see the [Review TUI guide](docs/review-tui.md).

---

### Parallel agent workflows

Manciple is designed for running multiple agents without losing the plot.

Managed task worktrees are enabled by default. The primary checkout keeps task
state and review evidence; each worker edits an isolated task branch. Approval
prospectively merges and verifies that branch before integrating it into the
primary checkout.

```bash
manciple task start build-login-page
manciple worktree status build-login-page
manciple review approve build-login-page
```

Set `worktrees.enabled: false` in `.manciple/config.yaml` or use
`--no-worktrees` on automation commands to opt out. See
[Parallel Workflows](docs/parallel-workflows.md) for lifecycle and recovery
details.

This is the difference between “I ran five agents” and “I can review what five agents did.”

---

## Install

Requires Node.js 18+.

```bash
npm install -g manciple
manciple --help
```

---

## Quickstart

Initialize Manciple in a repo:

```bash
manciple init
```

![manciple init output](docs/images/init-output.png)

A default `manciple init` is repo-local and idempotent. It creates the
`.manciple/` directory tree (config, lifecycle task directories, prompt and
run-log folders), adds Manciple entries to `.gitignore`, writes `.mcp.json`
with the Manciple MCP server for the repo, and copies the packaged agent
skills (`.claude/skills/`, `.codex/skills/`) and OpenCode agents
(`.opencode/agents/`) into the repo root. Everything it writes lives inside
your repository — no user-global configuration is changed. Rerunning it is
safe and skips anything already present.

Focused setup flags:

```bash
manciple init --mcp        # only write .mcp.json (skip directory/agent setup)
manciple init --agents     # only install packaged agent skills and agents
manciple init --global-mcp # ALSO write the MCP server to the user-global
                           # OpenCode config (~/.config/opencode/opencode.json).
                           # This explicit opt-in is the only way init touches
                           # user-global configuration.
```

Create a task:

```bash
manciple task new "Build login page" \
  --type implementation \
  --domain auth \
  --priority high
```

(`manciple new` remains available as a legacy alias; run `manciple --help --all`
to see every alias.)

Validate your task specs:

```bash
manciple validate
```

Check the queue:

```bash
manciple status
```

Compile an agent handoff:

```bash
manciple handoff build-login-page
```

The task lives here:

```text
.manciple/tasks/active/build-login-page.yaml
```

The generated prompt is written here:

```text
.manciple/prompts/generated/build-login-page.md
```

Paste that prompt into your coding agent.

After the agent runs, record the evidence:

```bash
manciple run-log build-login-page \
  --result complete \
  --agent Codex \
  --model gpt-5-codex \
  --command "pnpm test -- auth" \
  --file "src/features/auth/LoginPage.tsx" \
  --risks "No known risks."
```

Move it to review:

```bash
manciple set-status build-login-page needs_review
manciple review build-login-page
```

---

## Example task

```yaml
id: build-login-page
title: Build login page
status: pending
type: implementation
domain: auth
priority: high

goal: Implement email/password login with session handling.

acceptance_criteria:
  - User can log in with valid credentials.
  - Invalid credentials return a clear error.
  - Successful login creates a session.
  - Login flow has test coverage.

allowed_paths:
  - src/features/auth/**
  - tests/auth/**

verification:
  commands:
    - pnpm test -- auth

outputs_required:
  - files_changed
  - tests_run
  - risks
```

---

## Command reference

| Command                                  | Purpose                                                    |
| ---------------------------------------- | ---------------------------------------------------------- |
| `manciple init`                          | Initialize `.manciple/` in a repo (repo-local, idempotent). |
| `manciple task new <title>`              | Create a task spec. Use `--interactive` for guided setup.  |
| `manciple validate`                      | Validate task specs.                                       |
| `manciple list`                          | List active tasks.                                         |
| `manciple status`                        | Show status counts and a suggested next task.              |
| `manciple handoff [task-id]`             | Compile an agent-ready prompt or inspect the worker queue. |
| `manciple run-log <task-id>`             | Record commands, files, result, model, agent, and risks.   |
| `manciple set-status <task-id> <status>` | Update task lifecycle state.                               |
| `manciple review`                       | Open the interactive review dashboard (TTY) or show help.  |
| `manciple review <task-id>`              | Generate a reviewer prompt.                                |
| `manciple review-check [task-id]`        | Check whether required review evidence exists.             |
| `manciple worktree <command>`            | Create, inspect, release, remove, or prune task worktrees.  |
| `manciple doctor`                        | Check repo configuration.                                  |
| `manciple mcp-config`                    | Create or update `.mcp.json` for the Manciple MCP server.  |
| `manciple migrate-assignr`               | Migrate existing `.assignr/` artifacts to Manciple.        |

Legacy aliases (`manciple new`, `manciple compile`, and the others listed by
`manciple --help --all`) remain functional and print a deprecation hint that
names the canonical replacement.

---

## Works with your agents

Manciple is not trying to replace your coding agent.

It works with the tools you already use:

* Claude Code
* Codex
* Cursor
* OpenCode
* Aider
* Goose
* custom scripts
* MCP clients

Manciple owns the workflow layer: task contracts, prompt generation, run evidence, review readiness, and repo-local state.

The agent owns the code.

The human owns the review.

---

## Deeper docs

* [Getting Started](docs/getting-started.md)
* [Task Lifecycle](docs/task-lifecycle.md)
* [Parallel Workflows](docs/parallel-workflows.md)
* [Evidence and Review](docs/evidence-and-review.md)
* [Review TUI](docs/review-tui.md)
* [Review Queue](docs/review-queue.md)
* [MCP Server](docs/mcp-server.md)
* [OpenCode Agents](docs/opencode-agents.md)
* [Agent Skills](docs/agent-skills.md)

---

## Package

* npm: `manciple`
* CLI: `manciple`
* MCP binary: `manciple-mcp`
* License: MIT

---

## The pitch

Manciple is for developers who want to use coding agents aggressively without giving up engineering discipline.

It does not pretend agents are magic.
It assumes they need contracts, boundaries, receipts, and review.

That is the job.
