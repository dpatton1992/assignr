import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";
import picocolors from "picocolors";

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

interface OpenCodeConfig {
  mcp?: Record<string, unknown>;
  [key: string]: unknown;
}

const SERVER_NAME = "manciple";

function mancipleNpxArgs(): string[] {
  return ["--yes", "--package", "manciple", "manciple-mcp"];
}

/**
 * Resolve the OpenCode global config path.
 * Checks ~/.config/opencode/opencode.json first, then ~/.opencode/opencode.json.
 */
function openCodeGlobalConfigPath(): string | null {
  const home = homedir();
  const candidates = [
    join(home, ".config", "opencode", "opencode.json"),
    join(home, ".opencode", "opencode.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Default to XDG-style
  return join(home, ".config", "opencode", "opencode.json");
}

/**
 * Write the manciple MCP entry into the OpenCode global config
 * so that every repo automatically gets the server.
 */
function setupOpenCodeGlobalConfig(force: boolean): void {
  const configPath = openCodeGlobalConfigPath();
  if (!configPath) return;

  let config: OpenCodeConfig = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8")) as OpenCodeConfig;
    } catch {
      if (!force) {
        console.log(`  ${picocolors.yellow('-')} ${configPath} (unparseable, use --force to overwrite)`);
        return;
      }
      config = {};
    }
  }

  const mcp = config.mcp ?? {};
  if (Object.prototype.hasOwnProperty.call(mcp, SERVER_NAME)) {
    if (!force) {
      return; // idempotent — already configured
    }
  }

  mcp[SERVER_NAME] = {
    type: "local",
    command: ["npx", ...mancipleNpxArgs()],
    enabled: true,
  };
  config.mcp = mcp;

  const configDir = dirname(configPath);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  console.log(`  ${picocolors.green('✓')} ${configPath} (${SERVER_NAME})`);
}

/**
 * Write the manciple MCP entry into the local .mcp.json for editors
 * (Cline, Claude Desktop, etc.) that look for project-level MCP config.
 */
function setupLocalMcpConfig(cwd: string, force: boolean): void {
  const configPath = join(cwd, ".mcp.json");

  let config: McpConfig = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8")) as McpConfig;
    } catch {
      if (!force) {
        console.log(`  ${picocolors.yellow('-')} ${relative(cwd, configPath)} (unparseable, use --force to overwrite)`);
        return;
      }
    }
  }

  const mcpServers = (config.mcpServers ?? {}) as Record<string, unknown>;
  if (typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    if (!force) {
      console.log(`  ${picocolors.yellow('-')} ${relative(cwd, configPath)} (invalid mcpServers, use --force to overwrite)`);
      return;
    }
  }

  if (Object.prototype.hasOwnProperty.call(mcpServers, SERVER_NAME)) {
    if (!force) {
      return; // idempotent — already configured
    }
  }

  (mcpServers as Record<string, unknown>)[SERVER_NAME] = {
    command: "npx",
    args: mancipleNpxArgs(),
  };
  config.mcpServers = mcpServers;

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  console.log(`  ${picocolors.green('✓')} ${relative(cwd, configPath)} (${SERVER_NAME})`);
}

/**
 * Init-friendly MCP setup — logs warnings instead of exiting on errors.
 * This is the version used by `manciple init`.
 *
 * By default it writes only the repository-local `.mcp.json`. The user-global
 * OpenCode config (`~/.config/opencode/opencode.json`) is written only when
 * `options.global` is explicitly set (e.g. `manciple init --global-mcp`), so
 * default initialization never changes user-global configuration.
 */
export function setupMcpConfig(cwd: string, force: boolean, options?: { global?: boolean }): void {
  setupLocalMcpConfig(cwd, force);
  if (options?.global) {
    setupOpenCodeGlobalConfig(force);
  }
}

export function mcpConfigCommand(options: { cwd: string; force: boolean }): void {
  const { cwd, force } = options;
  const configPath = join(cwd, ".mcp.json");

  let config: McpConfig = {};

  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8")) as McpConfig;
    } catch (err) {
      console.error(
        `Could not parse ${relative(cwd, configPath)}: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(1);
    }
  }

  const mcpServers = config.mcpServers ?? {};
  if (typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    console.error(`Invalid ${relative(cwd, configPath)}: "mcpServers" must be an object.`);
    process.exit(1);
  }

  if (Object.prototype.hasOwnProperty.call(mcpServers, SERVER_NAME) && !force) {
    console.error(
      `${relative(cwd, configPath)} already has an "${SERVER_NAME}" MCP server. Use --force to overwrite it.`
    );
    process.exit(1);
  }

  config.mcpServers = {
    ...mcpServers,
    [SERVER_NAME]: {
      command: "npx",
    args: mancipleNpxArgs(),
    },
  };

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  console.log(`Wrote MCP config: ${relative(cwd, configPath)}`);
}
