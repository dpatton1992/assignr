import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { formatYamlDocument } from "../src/utils/yamlFormat.js";

const DEFAULT_TARGETS = [".manciple/tasks", ".manciple/specs/tasks"];

function collectYamlFiles(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  const stat = statSync(path);
  if (stat.isFile()) {
    return path.endsWith(".yaml") || path.endsWith(".yml") ? [path] : [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(path)) {
    files.push(...collectYamlFiles(join(path, entry)));
  }
  return files;
}

function formatYaml(path: string): string {
  const raw = readFileSync(path, "utf-8");
  const parsed = parse(raw);
  return formatYamlDocument(parsed);
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const targets = args.filter((arg) => arg !== "--check");
const files = (targets.length > 0 ? targets : DEFAULT_TARGETS).flatMap(collectYamlFiles).sort();

let changed = 0;
let failed = false;

for (const file of files) {
  try {
    const raw = readFileSync(file, "utf-8");
    const formatted = formatYaml(file);

    if (raw !== formatted) {
      changed += 1;
      if (checkOnly) {
        console.error(`Needs formatting: ${file}`);
      } else {
        writeFileSync(file, formatted, "utf-8");
        console.log(`Formatted: ${file}`);
      }
    }
  } catch (err) {
    failed = true;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Invalid YAML: ${file}`);
    console.error(`  ${message}`);
  }
}

if (failed || (checkOnly && changed > 0)) {
  process.exit(1);
}

if (checkOnly) {
  console.log(`Checked ${files.length} YAML file(s).`);
} else if (changed === 0) {
  console.log(`All ${files.length} YAML file(s) already formatted.`);
}
