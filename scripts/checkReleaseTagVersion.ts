#!/usr/bin/env node
/**
 * `pnpm exec tsx scripts/checkReleaseTagVersion.ts <tag>`
 *
 * Verifies the release-tag / package-version invariant: the tag name (after
 * removing the required leading "v") must exactly match the package.json
 * version at the commit resolved by that tag.
 *
 * Comparison is an exact SemVer string comparison after stripping only the
 * leading "v" from the tag; versions are never coerced or loosely compared.
 *
 * Exit codes:
 *   0  tag exists, is well-formed, and exactly matches package.json at the
 *      commit it resolves to
 *   1  tag is missing, malformed, unreadable, or mismatched
 *      (a useful diagnostic is written to stderr)
 */
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { resolve } from "path";

const TAG_PATTERN =
  /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type TagCheckFailureCode = "malformed" | "missing" | "unreadable" | "mismatch";

export interface TagCheckFailure {
  code: TagCheckFailureCode;
  tag: string;
  commit?: string;
  expected?: string;
  actual?: string;
  message: string;
}

export type TagCheckOutcome =
  | { ok: true; tag: string; version: string; commit: string }
  | { ok: false; failure: TagCheckFailure };

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.error?.message || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

/**
 * Returns the SemVer string after removing the required leading "v" from the
 * tag, or throws with a diagnostic for a missing or malformed tag.
 */
export function parseTagVersion(tag: string): string {
  if (typeof tag !== "string" || tag.length === 0) {
    throw new Error('Missing release tag: expected a vX.Y.Z tag, e.g. "v1.2.3".');
  }
  if (!TAG_PATTERN.test(tag)) {
    throw new Error(`Malformed release tag "${tag}": expected the form vX.Y.Z (e.g. v1.2.3).`);
  }
  return tag.slice(1);
}

/**
 * Checks the invariant for one tag. Never mutates the repository: this is a
 * read-only verification and reports mismatches instead of rewriting tags.
 */
export function checkReleaseTagVersion(tag: string, options: { cwd?: string } = {}): TagCheckOutcome {
  const cwd = options.cwd ?? process.cwd();

  let version: string;
  try {
    version = parseTagVersion(tag);
  } catch (error) {
    return { ok: false, failure: { code: "malformed", tag, message: (error as Error).message } };
  }

  let commit: string;
  try {
    commit = git(["rev-parse", "--verify", "--quiet", `${tag}^{commit}`], cwd);
  } catch {
    return {
      ok: false,
      failure: {
        code: "missing",
        tag,
        message: `Release tag "${tag}" does not exist or does not resolve to a commit. Create an annotated tag named "${tag}" on the matching version commit before pushing it.`,
      },
    };
  }

  let pkgJson: string;
  try {
    pkgJson = git(["show", `${commit}:package.json`], cwd);
  } catch {
    return {
      ok: false,
      failure: {
        code: "unreadable",
        tag,
        commit,
        message: `Release tag "${tag}" resolves to commit ${commit.slice(0, 7)} which has no readable package.json.`,
      },
    };
  }

  let pkgVersion: unknown;
  try {
    pkgVersion = (JSON.parse(pkgJson) as { version?: unknown }).version;
  } catch {
    return {
      ok: false,
      failure: {
        code: "unreadable",
        tag,
        commit,
        message: `package.json at commit ${commit.slice(0, 7)} (tag "${tag}") is not valid JSON or has no version field.`,
      },
    };
  }

  if (typeof pkgVersion !== "string" || pkgVersion !== version) {
    return {
      ok: false,
      failure: {
        code: "mismatch",
        tag,
        commit,
        expected: version,
        actual: typeof pkgVersion === "string" ? pkgVersion : undefined,
        message:
          `Release tag "${tag}" points to commit ${commit.slice(0, 7)} whose package.json version is ` +
          `${typeof pkgVersion === "string" ? pkgVersion : "missing"}; expected exactly ${version}. ` +
          "The tag name must exactly match the package.json version at the tagged commit.",
      },
    };
  }

  return { ok: true, tag, version, commit };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const tag = argv[0];
  if (!tag) {
    console.error("Usage: pnpm exec tsx scripts/checkReleaseTagVersion.ts <vX.Y.Z>");
    return 1;
  }
  const outcome = checkReleaseTagVersion(tag);
  if (outcome.ok) {
    console.log(
      `OK: tag ${outcome.tag} exactly matches package.json version ${outcome.version} at commit ${outcome.commit.slice(0, 7)}.`,
    );
    return 0;
  }
  console.error(outcome.failure.message);
  return 1;
}

const invokedDirectly = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invokedDirectly) {
  process.exitCode = main();
}
