#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = resolve(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/manciple-token-audit.mjs <task-id> [token-estimate options]

Runs the deterministic local Manciple token-estimate command and prints its
bucketed output. This audits Manciple handoff size only; it does not measure
total agent spend from file reads, tools, retries, internal reasoning, or
generated output.`);
  process.exit(args.length === 0 ? 1 : 0);
}

const result = spawnSync(process.execPath, [tsxCli, "src/cli.ts", "token-estimate", ...args], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    npm_config_offline: process.env.npm_config_offline ?? "true",
  },
});

if (result.error) {
  console.error(`manciple-token-audit failed to start token-estimate: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
