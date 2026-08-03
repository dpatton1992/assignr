# Getting Started

This guide expands the short README quickstart into the normal first run:
install Manciple, initialize a repo, create a scoped task, compile an agent
prompt, and record review evidence afterward.

## Install

Manciple requires Node.js 18+.

```bash
npm install -g manciple
manciple --help
```

## Initialize A Repo

Run `manciple init` at the root of the repo where agents will work:

```bash
manciple init
```

![manciple init output](images/init-output.png)

This one command does everything to set up the repo:

- Creates `.manciple/` with configuration, task directories, prompt output,
  run logs, and review evidence folders.
- Adds Manciple entries to `.gitignore`.
- Writes `.mcp.json` with the Manciple MCP server (keyed to the repo directory
  name so it is unique per repo).
- Copies packaged agent skills (`.claude/skills/`, `.codex/skills/`) and
  OpenCode agents (`.opencode/agents/`) from the installed npm package into
  your repo root so agent harnesses can find them.

Every file a default `manciple init` writes is repo-local. It does not change
user-global configuration — in particular it never edits the OpenCode global
config at `~/.config/opencode/opencode.json`. To also write the MCP server into
that user-global OpenCode config, pass the explicit opt-in flag:

```bash
manciple init --global-mcp
```

Focused setup flags skip the rest of the initialization:

```bash
manciple init --mcp        # only write .mcp.json
manciple init --agents     # only install packaged agent skills and agents
```

Running `manciple init` again is safe and idempotent — it skips anything already
set up. Use `--force` to overwrite existing files.

## Create And Handoff A Task

Create a task with a clear title, type, domain, and priority:

```bash
manciple task new "Build login page" --type implementation --domain auth --priority high
manciple validate
manciple status
manciple handoff build-login-page
```

The task spec is written to `.manciple/tasks/active/build-login-page.yaml`.
The compiled agent prompt is written to
`.manciple/prompts/generated/build-login-page.md`.

Paste the compiled prompt into Claude Code, Codex, Cursor, Aider, Goose, or
another coding agent. The prompt carries the task goal, allowed paths,
acceptance criteria, verification commands, and evidence the agent should
report.

Managed worktrees are enabled by default. Starting a task prepares its isolated
workspace and prints the path:

```bash
manciple task start build-login-page
```

The primary checkout remains the control plane for task state and run logs.
Agents edit the prepared workspace. Set `worktrees.enabled: false` in
`.manciple/config.yaml`, or use `manciple task start --no-worktrees`, to run
in-place instead.

## Record Evidence

After the implementation agent finishes, record what happened:

```bash
manciple run-log build-login-page \
  --result complete \
  --agent Codex \
  --model gpt-5-codex \
  --command "pnpm test -- auth" \
  --file "src/features/auth/LoginPage.tsx" \
  --risks "No known risks."
```

Then move the task to review and generate the reviewer prompt:

```bash
manciple set-status build-login-page needs_review
manciple review build-login-page
```

For lifecycle details, see [Task Lifecycle](task-lifecycle.md). For the review
workflow, see [Evidence and Review](evidence-and-review.md).
