#!/usr/bin/env node
/**
 * `pnpm release <patch|minor|major>`
 *
 * Bumps the version in package.json, runs the release checks, commits the
 * version change, creates an annotated git tag on that version commit, and
 * verifies the release-tag invariant before any tag is pushed or GitHub
 * release is created. Then publishes to npm, pushes the tag, and creates a
 * GitHub release with generated release notes.
 *
 * The flow fails closed before publication or remote mutation when:
 *   - the working tree is dirty
 *   - the release tag already exists
 *   - the version commit cannot be created
 *   - the tag name does not exactly match the package.json version at the
 *     tagged commit
 *
 * Options:
 *   --otp <code>    npm one-time password for 2FA
 *   --dry-run       Print the revised release plan without executing
 *   --preview       Show generated release notes only
 */
import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { checkReleaseTagVersion } from "./checkReleaseTagVersion.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..");

export const VALID_BUMPS = ["patch", "minor", "major"] as const;
export type BumpType = (typeof VALID_BUMPS)[number];

export interface ReleaseOptions {
  bump: BumpType;
  otp?: string;
  dryRun: boolean;
  preview: boolean;
}

export interface ReleaseRunOptions {
  /** Repository root to operate in; defaults to this repository. */
  cwd?: string;
  /** Run pnpm typecheck/test/build against the bumped version (default true). */
  runChecks?: boolean;
  /** Run npm publish, git push, and gh release (default true). */
  runRemote?: boolean;
}

interface RunOpts {
  cwd: string;
  stdio?: "inherit" | "pipe";
}

function run(command: string, args: string[], opts: RunOpts): void {
  const result = spawnSync(command, args, { cwd: opts.cwd, stdio: opts.stdio ?? "inherit" });
  if (result.error || result.status !== 0) {
    if (result.error) {
      throw new Error(`Failed to start ${command}: ${result.error.message}`);
    }
    throw new Error(`Command failed (${[command, ...args].join(" ")}) with exit code ${result.status}`);
  }
}

function runCapture(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const printableCommand = [command, ...args].join(" ");
    throw new Error(result.stderr?.toString().trim() || result.error?.message || `Command failed: ${printableCommand}`);
  }
  return result.stdout.trim();
}

function git(args: string[], cwd: string): string {
  return runCapture("git", args, cwd);
}

function gitOk(args: string[], cwd: string): boolean {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.error === undefined && result.status === 0;
}

function gitCheck(args: string[], cwd: string, context: string): void {
  try {
    git(args, cwd);
  } catch (error) {
    throw new Error(`${context}: ${(error as Error).message}`);
  }
}

function getLastTag(cwd: string): string | null {
  try {
    return git(["describe", "--tags", "--abbrev=0"], cwd);
  } catch {
    return null;
  }
}

export function bumpVersion(version: string, bump: BumpType): string {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid semver version: "${version}"`);
  }
  const [major, minor, patch] = parts;
  switch (bump) {
    case "major": return `${major + 1}.0.0`;
    case "minor": return `${major}.${minor + 1}.0`;
    case "patch": return `${major}.${minor}.${patch + 1}`;
  }
}

export function generateReleaseNotes(newVersion: string, cwd: string): string {
  const lastTag = getLastTag(cwd);
  const log = lastTag
    ? git(["log", "--oneline", "--no-decorate", `${lastTag}..HEAD`], cwd)
    : git(["log", "--oneline", "--no-decorate"], cwd);
  const date = new Date().toISOString().slice(0, 10);
  const lines = log.split("\n").filter(Boolean).map((l) => `- ${l}`).join("\n");
  return `## v${newVersion} (${date})\n\n${lines}\n`;
}

export function parseReleaseArgs(argv: string[]): ReleaseOptions {
  const bump = argv.find((arg): arg is BumpType => (VALID_BUMPS as readonly string[]).includes(arg));
  const otpIdx = argv.indexOf("--otp");
  const otp = otpIdx >= 0 ? argv[otpIdx + 1] : undefined;
  const dryRun = argv.includes("--dry-run");
  const preview = argv.includes("--preview");
  if (!bump) {
    throw new Error(`Usage: pnpm release <${VALID_BUMPS.join("|")}> [--otp <code>] [--dry-run] [--preview]`);
  }
  return { bump, otp, dryRun, preview };
}

export function assertCleanWorktree(cwd: string): void {
  const dirty = git(["status", "--porcelain"], cwd);
  if (dirty.length > 0) {
    const lines = dirty.split("\n").map((line) => `    ${line}`).join("\n");
    throw new Error(`Refusing to release: the working tree is dirty.\n${lines}\nCommit or stash all changes before releasing.`);
  }
}

export function assertReleaseTagAbsent(tag: string, cwd: string): void {
  if (gitOk(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], cwd)) {
    throw new Error(
      `Refusing to release: release tag "${tag}" already exists. Recreating or force-moving an existing release tag is not supported.`,
    );
  }
}

export function verifyReleaseTagInvariant(tag: string, cwd: string): void {
  const outcome = checkReleaseTagVersion(tag, { cwd });
  if (!outcome.ok) {
    throw new Error(`Refusing to release: release tag invariant violated.\n  ${outcome.failure.message}`);
  }
}

export function releaseStepDescriptions(newVersion: string, options: ReleaseOptions): string[] {
  const tag = `v${newVersion}`;
  const publish = options.otp ? `npm publish --otp ${options.otp}` : "npm publish";
  return [
    `Update package.json to v${newVersion}`,
    "Run release checks: pnpm typecheck && pnpm test && pnpm build",
    `Commit the version change: git commit -m "chore: bump version to ${newVersion}"`,
    `Create annotated tag ${tag} on the version commit`,
    `Verify the release tag invariant: ${tag} must exactly match the package.json version at the tagged commit`,
    publish,
    `git push origin ${tag}`,
    `gh release create ${tag}`,
  ];
}

export function commitVersionBump(newVersion: string, cwd: string): void {
  gitCheck(["add", "package.json"], cwd, `Failed to stage package.json for v${newVersion}`);
  gitCheck(["commit", "-m", `chore: bump version to ${newVersion}`], cwd, `Failed to create the version commit for v${newVersion}`);
}

export function createReleaseTag(tag: string, cwd: string): void {
  gitCheck(["tag", "-a", tag, "-m", `Release ${tag}`], cwd, `Failed to create annotated tag ${tag}`);
}

export function runRelease(options: ReleaseOptions, runOptions: ReleaseRunOptions = {}): void {
  const cwd = runOptions.cwd ?? REPO_ROOT;
  const pkgPath = join(cwd, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
  const currentVersion = pkg.version;
  const newVersion = bumpVersion(currentVersion, options.bump);
  const tag = `v${newVersion}`;
  const notes = generateReleaseNotes(newVersion, cwd);

  if (options.preview) {
    console.log(notes);
    return;
  }

  if (options.dryRun) {
    console.log(`[dry-run] Release v${newVersion}`);
    console.log(`  Bump: ${options.bump} (v${currentVersion} -> v${newVersion})`);
    console.log("  Preflight gates (fail closed before publication or remote mutation):");
    console.log("    - Working tree must be clean");
    console.log(`    - Tag ${tag} must not already exist`);
    console.log("  Steps:");
    releaseStepDescriptions(newVersion, options).forEach((step, index) => {
      console.log(`    ${index + 1}. ${step}`);
    });
    console.log(`\n  Release notes:\n${notes}`);
    return;
  }

  // Preflight gates: fail closed before any publication or remote mutation.
  console.log("Running preflight checks...");
  assertCleanWorktree(cwd);
  assertReleaseTagAbsent(tag, cwd);

  // 1. Write the next package version.
  console.log(`\nUpdating package.json: v${currentVersion} -> v${newVersion}`);
  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n");

  // 2. Run the release checks against the bumped version.
  if (runOptions.runChecks !== false) {
    console.log("Running release checks...");
    run("pnpm", ["typecheck"], { cwd });
    run("pnpm", ["test"], { cwd });
    run("pnpm", ["build"], { cwd });
  }

  // 3. Commit the version change; fail closed if the commit cannot be created.
  console.log("Committing version change...");
  commitVersionBump(newVersion, cwd);

  // 4. Create the annotated release tag on the version commit.
  console.log(`Creating annotated git tag ${tag} on the version commit...`);
  createReleaseTag(tag, cwd);

  // 5. Invariant gate: the tag name must exactly match package.json at the tagged commit.
  console.log(`Verifying the release tag invariant for ${tag}...`);
  verifyReleaseTagInvariant(tag, cwd);

  if (runOptions.runRemote === false) {
    console.log(`\n✓ Prepared release v${newVersion} (local steps complete; remote steps skipped)`);
    return;
  }

  // 6. Publish to npm.
  const publishArgs = ["publish", ...(options.otp ? ["--otp", options.otp] : [])];
  console.log(`Publishing: npm ${publishArgs.join(" ")}`);
  run("npm", publishArgs, { cwd });

  // 7. Push the tag.
  console.log(`Pushing tag ${tag} to origin...`);
  run("git", ["push", "origin", tag], { cwd });

  // 8. Create the GitHub release.
  console.log("Creating GitHub release...");
  const tmpDir = mkdtempSync(join(tmpdir(), "manciple-release-"));
  const notesFile = join(tmpDir, "RELEASE_NOTES.md");
  writeFileSync(notesFile, notes, "utf-8");
  try {
    run("gh", ["release", "create", tag, "--title", tag, "--notes-file", notesFile], { cwd });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n✓ Released v${newVersion}`);
  console.log(`  https://github.com/dpatton1992/manciple/releases/tag/${tag}`);
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const options = parseReleaseArgs(argv);
  runRelease(options);
}

const invokedDirectly = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
