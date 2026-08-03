# Agent Skills

Skill files for Claude Code and Codex live in `.claude/skills/` and
`.codex/skills/`.

The npm package ships both directories. Run `manciple init` from your repo root
to copy them from the installed package automatically (along with MCP config,
`.gitignore` entries, and the OpenCode agents):

```bash
manciple init
```

Or run `manciple install-assets` separately if you only want to update the skill
files without re-running full init:

```bash
manciple install-assets
```

Both copy `.claude/skills/` and `.codex/skills/` from
`node_modules/manciple/` into your repo root, plus the OpenCode agents
(see [OpenCode Agents](opencode-agents.md)).

## Available Skills

- `manciple-mcp-task-runner`: pick up, execute, verify, log, and close one task
  through MCP.
- `manciple-agents`: coordinate multiple Manciple task workers in parallel.

The skills delegate routine scheduling and verification decisions to
deterministic Manciple surfaces:

- Coordinators call `manciple_dispatch_plan` or `manciple dispatch-plan` before
  spawning workers, then prepare and spawn only the returned assignments.
- Workers start from `manciple_get_task_packet` or `manciple task-packet
  <task-id>`, then call `manciple_prepare_worktree` and edit only its returned
  workspace, using full prompt compilation only when domain context is needed.
- Workers and coordinators report receipts from `manciple_verify` or
  `manciple verify --profile worker|coordinator|review`.
- Workers write status and run-log state against the returned control repo and
  pass the workspace to verification and run-log tools for code evidence.
- Scoped YAML checks use `manciple_format_task` or `manciple format-task
  <task-id> --check`; the skills do not run routine whole-repo formatting loops.

Use the MCP setup in [MCP Server](mcp-server.md) when the agent should call
Manciple tools directly. Use [Getting Started](getting-started.md) for the
underlying CLI flow those skills automate.

For OpenCode agent documentation — the `manciple-worker` and
`manciple-coordinator` agents, their configuration files, MCP setup, and
project-level rules — see [OpenCode Agents](opencode-agents.md).
