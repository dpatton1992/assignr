import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import picocolors from "picocolors";

interface MigrationAction {
  label: string;
  apply: () => void;
}

export interface MigrateAssignrCommandOptions {
  cwd: string;
  yes?: boolean;
  dryRun?: boolean;
  confirm?: () => boolean | Promise<boolean>;
}

function relativePath(cwd: string, filePath: string): string {
  return filePath.startsWith(`${cwd}/`) ? filePath.slice(cwd.length + 1) : filePath;
}

function replaceText(value: string): string {
  return value
    .replaceAll("@dpatt/assignr", "manciple")
    .replaceAll("@dpatt/manciple", "manciple")
    .replaceAll("assignr-mcp", "manciple-mcp")
    .replaceAll("assignr-worker", "manciple-worker")
    .replaceAll("assignr-coordinator", "manciple-coordinator")
    .replaceAll("assignr-task", "manciple-task")
    .replaceAll("assignr_", "manciple_")
    .replaceAll(".assignr", ".manciple")
    .replaceAll("Assignr", "Manciple")
    .replaceAll("assignr", "manciple");
}

function replaceJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return replaceText(value);
  }
  if (Array.isArray(value)) {
    return value.map(replaceJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [replaceText(key), replaceJsonValue(entry)]),
    );
  }
  return value;
}

function copyDirectoryMissing(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    const sourcePath = join(source, entry);
    const destinationPath = join(destination, entry);
    const sourceStat = statSync(sourcePath);

    if (sourceStat.isDirectory()) {
      copyDirectoryMissing(sourcePath, destinationPath);
      continue;
    }

    if (!existsSync(destinationPath)) {
      copyFileSync(sourcePath, destinationPath);
    }
  }
}

function updateTextFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const before = readFileSync(filePath, "utf-8");
  const after = replaceText(before);
  if (after === before) return false;
  writeFileSync(filePath, after, "utf-8");
  return true;
}

function updateJsonFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const before = readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(before);
  } catch {
    return false;
  }

  const after = `${JSON.stringify(replaceJsonValue(parsed), null, 2)}\n`;
  if (after === before) return false;
  writeFileSync(filePath, after, "utf-8");
  return true;
}

function textFileNeedsUpdate(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const before = readFileSync(filePath, "utf-8");
  return replaceText(before) !== before;
}

function jsonFileNeedsUpdate(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const before = readFileSync(filePath, "utf-8");
  try {
    const after = `${JSON.stringify(replaceJsonValue(JSON.parse(before)), null, 2)}\n`;
    return after !== before;
  } catch {
    return false;
  }
}

function updateTextTree(root: string): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    const filePath = join(root, entry);
    if (statSync(filePath).isDirectory()) {
      updateTextTree(filePath);
    } else {
      updateTextFile(filePath);
    }
  }
}

function textTreeNeedsUpdate(root: string): boolean {
  if (!existsSync(root)) return false;
  for (const entry of readdirSync(root)) {
    const filePath = join(root, entry);
    if (statSync(filePath).isDirectory()) {
      if (textTreeNeedsUpdate(filePath)) return true;
    } else if (textFileNeedsUpdate(filePath)) {
      return true;
    }
  }
  return false;
}

function collectRenames(cwd: string, dir: string, actions: MigrationAction[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const source = join(dir, entry);
    const replaced = replaceText(entry);
    const destination = join(dir, replaced);

    if (entry !== replaced && !existsSync(destination)) {
      actions.push({
        label: `Rename ${relativePath(cwd, source)} -> ${relativePath(cwd, destination)}`,
        apply: () => renameSync(source, destination),
      });
    }
  }
}

async function confirmMigration(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Proceed with Assignr -> Manciple migration? [y/N] ");
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function buildPlan(cwd: string): MigrationAction[] {
  const actions: MigrationAction[] = [];
  const assignrRoot = join(cwd, ".assignr");
  const mancipleRoot = join(cwd, ".manciple");

  if (existsSync(assignrRoot) && !existsSync(mancipleRoot)) {
    actions.push({
      label: "Move .assignr/ -> .manciple/",
      apply: () => renameSync(assignrRoot, mancipleRoot),
    });
  } else if (existsSync(assignrRoot) && existsSync(mancipleRoot)) {
    actions.push({
      label: "Copy missing files from .assignr/ into existing .manciple/",
      apply: () => copyDirectoryMissing(assignrRoot, mancipleRoot),
    });
  }

  const textFiles: Array<{ labelPath: string; sourcePath: string; targetPath: string }> = [
    {
      labelPath: join(mancipleRoot, "config.yaml"),
      sourcePath: existsSync(join(mancipleRoot, "config.yaml"))
        ? join(mancipleRoot, "config.yaml")
        : join(assignrRoot, "config.yaml"),
      targetPath: join(mancipleRoot, "config.yaml"),
    },
    {
      labelPath: join(mancipleRoot, "commands", "README.md"),
      sourcePath: existsSync(join(mancipleRoot, "commands", "README.md"))
        ? join(mancipleRoot, "commands", "README.md")
        : join(assignrRoot, "commands", "README.md"),
      targetPath: join(mancipleRoot, "commands", "README.md"),
    },
    {
      labelPath: join(cwd, ".gitignore"),
      sourcePath: join(cwd, ".gitignore"),
      targetPath: join(cwd, ".gitignore"),
    },
    {
      labelPath: join(cwd, "AGENTS.md"),
      sourcePath: join(cwd, "AGENTS.md"),
      targetPath: join(cwd, "AGENTS.md"),
    },
  ];

  for (const { labelPath, sourcePath, targetPath } of textFiles) {
    if (textFileNeedsUpdate(sourcePath)) {
      actions.push({
        label: `Update ${relativePath(cwd, labelPath)} references`,
        apply: () => updateTextFile(targetPath),
      });
    }
  }

  const jsonFiles = [join(cwd, ".mcp.json"), join(cwd, "opencode.json")];
  for (const filePath of jsonFiles) {
    if (jsonFileNeedsUpdate(filePath)) {
      actions.push({
        label: `Update ${relativePath(cwd, filePath)} references`,
        apply: () => updateJsonFile(filePath),
      });
    }
  }

  collectRenames(cwd, join(cwd, ".claude", "skills"), actions);
  collectRenames(cwd, join(cwd, ".codex", "skills"), actions);
  collectRenames(cwd, join(cwd, ".opencode", "agents"), actions);

  const assetRoots = [
    join(cwd, ".claude", "skills"),
    join(cwd, ".codex", "skills"),
    join(cwd, ".opencode", "agents"),
  ];
  for (const root of assetRoots) {
    if (textTreeNeedsUpdate(root)) {
      actions.push({
        label: `Update ${relativePath(cwd, root)} file references`,
        apply: () => updateTextTree(root),
      });
    }
  }

  return actions;
}

export async function migrateAssignrCommand(options: MigrateAssignrCommandOptions): Promise<void> {
  const { cwd, yes = false, dryRun = false } = options;
  const actions = buildPlan(cwd);

  if (actions.length === 0) {
    console.log("No Assignr artifacts found to migrate.");
    return;
  }

  console.log(picocolors.bold("Assignr -> Manciple migration preview:"));
  for (const action of actions) {
    console.log(`  ${picocolors.dim("-")} ${action.label}`);
  }

  if (dryRun) {
    console.log(`\n${picocolors.dim("Dry run only; no files changed.")}`);
    return;
  }

  const confirmed = yes || (await (options.confirm ?? confirmMigration)());
  if (!confirmed) {
    console.log("Migration cancelled.");
    return;
  }

  for (const action of actions) {
    action.apply();
  }

  console.log(`\n${picocolors.green("✓")} Migrated Assignr artifacts to Manciple.`);
  console.log(
    `  ${picocolors.dim("Run")} ${picocolors.cyan("manciple install-assets --force")} ${picocolors.dim("to refresh packaged agent assets.")}`,
  );
  console.log(
    `  ${picocolors.dim("Run")} ${picocolors.cyan("manciple mcp-config --force")} ${picocolors.dim("if your MCP client needs regenerated config.")}`,
  );
}
