# OpenCode Agents

OpenCode reads `.claude/skills/` automatically via its Claude Code compatibility
layer — no separate `.opencode/skills/` copies are needed.

The npm package ships `.opencode/agents/` for OpenCode release consumers. Run
this from your repo root to install them from the installed package:

```bash
manciple install-assets
```

Or run `manciple init` (or `manciple init --agents` for assets only) to set up
the Manciple structure and assets together. After installing, configure the
Manciple MCP server for this repo.

Two custom agents are defined in `.opencode/agents/`:

## `manciple-worker` (Subagent Mode)

`manciple-worker` implements a single Manciple task end-to-end via MCP. It loads
the task packet, runs the work, verifies, writes a run log, and sets the final
status.

- **Configuration**: `.opencode/agents/manciple-worker.md`
- **Mode**: `subagent` — invoked by the coordinator or directly by the user.
- **Invocation**: Use `@manciple-worker` with a task ID, or ask it to choose one.
- **Workflow**: Calls the `skill` tool with `name: "manciple-mcp-task-runner"` to
  load the runner workflow at runtime. Uses Manciple MCP tools
  (`manciple_get_task_packet`, `manciple_prepare_worktree`, `manciple_set_status`, `manciple_verify`,
  `manciple_run_log`) as the primary interface.

## `manciple-coordinator` (Primary Mode)

`manciple-coordinator` coordinates multiple Manciple task workers in parallel. It
dispatches a plan, spawns `manciple-worker` subagents for each assignment, and
aggregates results.

- **Configuration**: `.opencode/agents/manciple-coordinator.md`
- **Mode**: `primary` — reachable via the Tab key in OpenCode.
- **Invocation**: Switch to this agent using Tab, or configure it as the startup
  agent.
- **Workflow**: Calls the `skill` tool with `name: "manciple-agents"` to load the
  coordination workflow. Uses `manciple_dispatch_plan` to determine task
  assignments, prepares their isolated workspaces, spawns `manciple-worker`
  subagents in parallel (up to detected CPU core count) via the `task` tool,
  sends completed branches through review integration, then runs
  `manciple_verify` with `profile: "coordinator"` against the control repo.

## MCP Server

The Manciple MCP server is registered in `opencode.json` at the repo root:

```json
{
  "mcp": {
    "manciple-promptops": {
      "type": "local",
      "command": ["node", "./bin/manciple-mcp.js"],
      "enabled": true
    }
  }
}
```

The server key is `manciple-<repo-dir-name>` so that each repo gets a unique
MCP server name. This prevents agents in one repo from accidentally calling
the MCP tools of another repo.

Manciple tools are prefixed `manciple_` (e.g. `manciple_get_task_packet`,
`manciple_set_status`, `manciple_verify`). Prefer these over raw CLI calls when
both are available. See [MCP Server](mcp-server.md) for the full tool surface.

The release surface is the reusable `.opencode/agents/` directory. Local
OpenCode runtime dependencies such as `.opencode/node_modules/` and local
OpenCode package files are project artifacts, not packaged Manciple agent
assets.

## Skills at Runtime

Both agents load their workflow by calling the `skill` tool at runtime:

- `manciple-worker` calls `skill` with `name: "manciple-mcp-task-runner"`.
- `manciple-coordinator` calls `skill` with `name: "manciple-agents"`.

This keeps the agent configuration files concise — they define permissions and
entry point behavior, while the skills provide the detailed workflow steps.

## Project-Level Rules

[`AGENTS.md`](../AGENTS.md) at the repo root provides project-level instructions
for OpenCode sessions:

- **Token audit instructions**: How to run the Manciple token audit script and
  report results deterministically.
- **Agent hints**: Available agents (`@manciple-worker`,
  `manciple-coordinator`) and how to use them.
- **MCP tool conventions**: Which tools to prefer and naming conventions.
- **Project conventions**: Task spec locations, run logs, verification profiles,
  and test/lint commands.

## See Also

- [MCP Server](mcp-server.md): MCP setup and tool surface.
- [Agent Skills](agent-skills.md): Skill files for Manciple workflows across
  different agent platforms.
- [Evidence and Review](evidence-and-review.md): Run logs, review prompts, and
  reviewer decisions.
- [Getting Started](getting-started.md): Human CLI workflow for Manciple.
