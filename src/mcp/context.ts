import { resolve } from "node:path";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { getPaths } from "../utils/paths.js";

export interface McpRepoContext {
  cwd: string;
  root: string;
  paths: ReturnType<typeof getPaths>;
}

export const repoInputSchema = {
  repo: z
    .string()
    .optional()
    .describe(
      "Absolute or relative repository root to scope this Manciple operation. Defaults to the MCP server process cwd for backward compatibility.",
    ),
};

export function getRepoContext(repo?: string): McpRepoContext {
  const cwd = resolve(repo ?? process.cwd());
  const config = loadConfig(cwd);
  const root = config.root;
  return {
    cwd,
    root,
    paths: getPaths(cwd, root),
  };
}
