import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkReleaseTagVersion } from "../scripts/checkReleaseTagVersion.js";
import { bumpVersion, runRelease, verifyReleaseTagInvariant } from "../scripts/release.js";

const projectRoot = process.cwd();
const checkScript = join(projectRoot, "scripts", "checkReleaseTagVersion.ts");
const tsxBin = join(projectRoot, "node_modules", ".bin", "tsx");

let repo: string;

function git(args: string[], cwd: string = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function initRepo(version = "0.4.8"): void {
  git(["init", "-b", "main"]);
  git(["config", "user.email", "tests@example.com"]);
  git(["config", "user.name", "Manciple Tests"]);
  writeFileSync(
    join(repo, "package.json"),
    `${JSON.stringify({ name: "manciple-test", version }, null, 2)}\n`,
  );
  writeFileSync(join(repo, "tracked.txt"), "base\n", "utf-8");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
}

function readVersion(): string {
  return (JSON.parse(readFileSync(join(repo, "package.json"), "utf-8")) as { version: string })
    .version;
}

function tagList(): string[] {
  return git(["tag", "--list"]).split("\n").filter(Boolean);
}

function logCount(): string {
  return git(["rev-list", "--count", "HEAD"]);
}

function runCheckCli(tag: string): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(tsxBin, [checkScript, tag], { cwd: repo, encoding: "utf-8" });
}

function captureLogs(fn: () => void): string {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  let captured: unknown[][] = [];
  try {
    fn();
    captured = [...logSpy.mock.calls];
  } finally {
    logSpy.mockRestore();
  }
  return captured.map((call) => call.map(String).join(" ")).join("\n");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "manciple-release-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("checkReleaseTagVersion", () => {
  it("passes when an annotated tag exactly matches the package.json version at the tagged commit", () => {
    initRepo("0.4.8");
    git(["tag", "-a", "v0.4.8", "-m", "Release v0.4.8"]);

    const outcome = checkReleaseTagVersion("v0.4.8", { cwd: repo });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.version).toBe("0.4.8");
      expect(outcome.tag).toBe("v0.4.8");
    }
  });

  it("passes for a lightweight tag on a matching version commit", () => {
    initRepo("0.4.8");
    git(["tag", "v0.4.8"]);

    const outcome = checkReleaseTagVersion("v0.4.8", { cwd: repo });

    expect(outcome.ok).toBe(true);
  });

  it("fails when a tag points to a commit with a different package version", () => {
    initRepo("0.4.8");
    git(["tag", "-a", "v0.4.9", "-m", "Release v0.4.9"]);

    const outcome = checkReleaseTagVersion("v0.4.9", { cwd: repo });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.code).toBe("mismatch");
      expect(outcome.failure.expected).toBe("0.4.9");
      expect(outcome.failure.actual).toBe("0.4.8");
      expect(outcome.failure.message).toContain("v0.4.9");
      expect(outcome.failure.message).toContain("0.4.8");
    }
  });

  it("fails for a missing tag", () => {
    initRepo("0.4.8");

    const outcome = checkReleaseTagVersion("v9.9.9", { cwd: repo });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.code).toBe("missing");
      expect(outcome.failure.message).toContain("does not exist");
    }
  });

  it("fails for a malformed tag without coercion", () => {
    initRepo("0.4.8");

    const noPrefix = checkReleaseTagVersion("0.4.8", { cwd: repo });
    const shortForm = checkReleaseTagVersion("v0.4", { cwd: repo });
    const looseVersion = checkReleaseTagVersion("v0.4.9.0", { cwd: repo });

    expect(noPrefix.ok).toBe(false);
    expect(shortForm.ok).toBe(false);
    expect(looseVersion.ok).toBe(false);
    if (!noPrefix.ok && !shortForm.ok && !looseVersion.ok) {
      expect(noPrefix.failure.code).toBe("malformed");
      expect(shortForm.failure.code).toBe("malformed");
      expect(looseVersion.failure.code).toBe("malformed");
      expect(noPrefix.failure.message).toContain("Malformed");
    }
  });

  it("exits zero from the CLI for a matching tag", () => {
    initRepo("0.4.8");
    git(["tag", "-a", "v0.4.8", "-m", "Release v0.4.8"]);

    const result = runCheckCli("v0.4.8");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("exits non-zero with a useful diagnostic from the CLI for a mismatched tag", () => {
    initRepo("0.4.8");
    git(["tag", "-a", "v0.4.9", "-m", "Release v0.4.9"]);

    const result = runCheckCli("v0.4.9");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("v0.4.9");
    expect(result.stderr).toContain("0.4.8");
    expect(result.stderr).toContain("expected exactly 0.4.9");
  });

  it("exits non-zero with a useful diagnostic from the CLI for missing and malformed tags", () => {
    initRepo("0.4.8");

    const missing = runCheckCli("v9.9.9");
    const malformed = runCheckCli("0.4.8");

    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("does not exist");
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain("Malformed");
  });
});

describe("release flow ordering and fail-closed gates", () => {
  it("writes the version, commits it, tags the version commit, and verifies the invariant before remote steps", () => {
    initRepo("0.4.8");
    const output = captureLogs(() => {
      runRelease(
        { bump: "patch", dryRun: false, preview: false },
        { cwd: repo, runChecks: false, runRemote: false },
      );
    });

    expect(readVersion()).toBe("0.4.9");
    expect(git(["log", "-1", "--pretty=%s"])).toBe("chore: bump version to 0.4.9");
    expect(logCount()).toBe("2");
    expect(tagList()).toEqual(["v0.4.9"]);
    expect(git(["cat-file", "-t", "v0.4.9"])).toBe("tag");
    expect(git(["rev-parse", "v0.4.9^{commit}"])).toBe(git(["rev-parse", "HEAD"]));

    const outcome = checkReleaseTagVersion("v0.4.9", { cwd: repo });
    expect(outcome.ok).toBe(true);
    expect(output).toContain("Verifying the release tag invariant for v0.4.9");
    expect(output).not.toContain("Publishing:");
  });

  it("fails closed on a dirty working tree before any change", () => {
    initRepo("0.4.8");
    writeFileSync(join(repo, "tracked.txt"), "modified\n", "utf-8");

    expect(() =>
      runRelease(
        { bump: "patch", dryRun: false, preview: false },
        { cwd: repo, runChecks: false, runRemote: false },
      ),
    ).toThrow(/dirty/);

    expect(readVersion()).toBe("0.4.8");
    expect(tagList()).toEqual([]);
    expect(logCount()).toBe("1");
  });

  it("fails closed when the release tag already exists", () => {
    initRepo("0.4.8");
    git(["tag", "v0.4.9"]);

    expect(() =>
      runRelease(
        { bump: "patch", dryRun: false, preview: false },
        { cwd: repo, runChecks: false, runRemote: false },
      ),
    ).toThrow(/already exists/);

    expect(readVersion()).toBe("0.4.8");
    expect(logCount()).toBe("1");
  });

  it("fails closed when the version commit cannot be created", () => {
    initRepo("0.4.8");
    writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", "utf-8");
    chmodSync(join(repo, ".git", "hooks", "pre-commit"), 0o755);

    expect(() =>
      runRelease(
        { bump: "patch", dryRun: false, preview: false },
        { cwd: repo, runChecks: false, runRemote: false },
      ),
    ).toThrow(/Failed to create the version commit/);

    expect(tagList()).toEqual([]);
    expect(logCount()).toBe("1");
  });

  it("fails closed when the release tag invariant is violated", () => {
    initRepo("0.4.8");
    git(["tag", "-a", "v0.4.8", "-m", "Release v0.4.8"]);
    git(["tag", "-a", "v0.4.9", "-m", "mislocated tag"]);

    expect(() => verifyReleaseTagInvariant("v0.4.9", repo)).toThrow(/invariant violated/);
    expect(() => verifyReleaseTagInvariant("v0.4.8", repo)).not.toThrow();
  });

  it("dry-run is side-effect free and describes the revised release order", () => {
    initRepo("0.4.8");
    const output = captureLogs(() => {
      runRelease({ bump: "patch", dryRun: true, preview: false }, { cwd: repo });
    });

    expect(readVersion()).toBe("0.4.8");
    expect(tagList()).toEqual([]);
    expect(logCount()).toBe("1");

    expect(output).toContain("[dry-run] Release v0.4.9");
    const steps = [
      "Update package.json to v0.4.9",
      "Run release checks: pnpm typecheck && pnpm test && pnpm build",
      "Commit the version change",
      "Create annotated tag v0.4.9 on the version commit",
      "Verify the release tag invariant",
      "npm publish",
      "git push origin v0.4.9",
      "gh release create v0.4.9",
    ];
    for (const step of steps) {
      expect(output).toContain(step);
    }
    const indexOf = (needle: string) => output.indexOf(needle);
    expect(indexOf("Update package.json to v0.4.9")).toBeLessThan(indexOf("npm publish"));
    expect(indexOf("Create annotated tag v0.4.9")).toBeLessThan(indexOf("git push origin v0.4.9"));
    expect(indexOf("Verify the release tag invariant")).toBeLessThan(indexOf("npm publish"));
    expect(indexOf("npm publish")).toBeLessThan(indexOf("git push origin v0.4.9"));
    expect(indexOf("git push origin v0.4.9")).toBeLessThan(indexOf("gh release create v0.4.9"));
  });

  it("preview mode prints release notes without side effects", () => {
    initRepo("0.4.8");
    const output = captureLogs(() => {
      runRelease({ bump: "patch", dryRun: false, preview: true }, { cwd: repo });
    });

    expect(output).toContain("## v0.4.9");
    expect(readVersion()).toBe("0.4.8");
    expect(tagList()).toEqual([]);
    expect(logCount()).toBe("1");
  });

  it("bumpVersion computes exact next versions", () => {
    expect(bumpVersion("0.4.8", "patch")).toBe("0.4.9");
    expect(bumpVersion("0.4.9", "minor")).toBe("0.5.0");
    expect(bumpVersion("0.5.0", "major")).toBe("1.0.0");
    expect(() => bumpVersion("not-a-version", "patch")).toThrow(/Invalid semver version/);
  });
});
