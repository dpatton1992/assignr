import { spawnSync } from "child_process";
import { resolve } from "path";
import { fileURLToPath } from "url";

const args = process.argv
  .slice(2)
  .filter((arg) => arg !== "--")
  .map((arg) => (arg === "--silent" ? "--silent=true" : arg));
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const vitestCli = resolve(repoRoot, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [vitestCli, "run", ...args], {
  stdio: "inherit",
});

if (result.error) {
  console.error(`Failed to start vitest: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
