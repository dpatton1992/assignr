import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import picocolors from "picocolors";

interface InstallAssetsOptions {
  cwd: string;
  force: boolean;
}

const ASSET_DIRS = [
  { source: ".claude/skills", target: ".claude/skills" },
  { source: ".codex/skills", target: ".codex/skills" },
  { source: ".opencode/agents", target: ".opencode/agents" },
];

function packageRoot(): string {
  const commandDir = dirname(fileURLToPath(import.meta.url));
  return join(commandDir, "..", "..");
}

function copyDir(src: string, dest: string, cwd: string, force: boolean): number {
  if (!existsSync(src)) return 0;

  const entries = readdirSync(src);
  let count = 0;

  for (const entry of entries) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);

    if (statSync(srcPath).isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      count += copyDir(srcPath, destPath, cwd, force);
    } else {
      if (existsSync(destPath) && !force) {
        continue;
      }
      mkdirSync(dest, { recursive: true });
      copyFileSync(srcPath, destPath);
      count++;
    }
  }

  return count;
}

export function installAssetsCommand(options: InstallAssetsOptions): void {
  const { cwd, force } = options;
  const pkgRoot = packageRoot();
  let totalFiles = 0;

  for (const asset of ASSET_DIRS) {
    const sourceDir = join(pkgRoot, asset.source);
    const targetDir = join(cwd, asset.target);

    if (!existsSync(sourceDir)) {
      console.log(`  ${picocolors.yellow("-")} ${asset.target}/ (not available in package)`);
      continue;
    }

    const copied = copyDir(sourceDir, targetDir, cwd, force);
    if (copied > 0) {
      console.log(
        `  ${picocolors.green("✓")} ${asset.target}/ (${copied} file${copied === 1 ? "" : "s"})`,
      );
    } else {
      const alreadyExists = existsSync(targetDir) && readdirSync(targetDir).length > 0;
      if (alreadyExists) {
        console.log(
          `  ${picocolors.yellow("-")} ${asset.target}/ (already exists, use --force to overwrite)`,
        );
      }
    }
    totalFiles += copied;
  }

  if (totalFiles > 0) {
    console.log(
      `\n  ${picocolors.green(picocolors.bold(`Installed ${totalFiles} asset file${totalFiles === 1 ? "" : "s"}.`))}`,
    );
  } else {
    console.log(`\n  ${picocolors.dim("No new assets to install.")}`);
  }
}
