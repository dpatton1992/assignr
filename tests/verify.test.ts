import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseVerifyProfile,
  runVerifyProfile,
  VERIFY_PROFILES,
  type VerifyCommandRunner,
  verifyCommand,
} from "../src/commands/verify.js";

describe("verify profiles", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the deterministic coordinator profile commands", async () => {
    const commands: string[] = [];
    const runner: VerifyCommandRunner = async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: "passing output", stderr: "" };
    };

    const receipt = await runVerifyProfile("coordinator", { cwd: "/repo", runner });

    expect(commands).toEqual(VERIFY_PROFILES.coordinator);
    expect(receipt).toMatchObject({
      ok: true,
      profile: "coordinator",
      failures: [],
      output: {
        included: "failures_only",
        max_chars_per_stream: 2000,
      },
    });
    expect(receipt.commands_run).toEqual(
      VERIFY_PROFILES.coordinator.map((command) => ({
        command,
        exit_code: 0,
        ok: true,
      })),
    );
    expect(JSON.stringify(receipt)).not.toContain("passing output");
  });

  it("runs the deterministic worker profile commands", async () => {
    const commands: string[] = [];
    const runner: VerifyCommandRunner = async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await runVerifyProfile("worker", { cwd: "/repo", runner });

    expect(commands).toEqual(VERIFY_PROFILES.worker);
  });

  it("runs the deterministic review profile commands", async () => {
    const commands: string[] = [];
    const runner: VerifyCommandRunner = async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await runVerifyProfile("review", { cwd: "/repo", runner });

    expect(commands).toEqual(VERIFY_PROFILES.review);
  });

  it("captures compact failure receipts without dropping later commands", async () => {
    const longStdout = "x".repeat(2100);
    const runner: VerifyCommandRunner = async (command) => {
      if (command === "pnpm test -- verify") {
        return { exitCode: 7, stdout: longStdout, stderr: "failed neatly" };
      }
      return { exitCode: 0, stdout: "success output", stderr: "" };
    };

    const receipt = await runVerifyProfile("worker", { cwd: "/repo", runner });

    expect(receipt.ok).toBe(false);
    expect(receipt.commands_run).toHaveLength(VERIFY_PROFILES.worker.length);
    expect(receipt.failures).toEqual([
      {
        command: "pnpm test -- verify",
        exit_code: 7,
        ok: false,
        output: {
          stdout: "x".repeat(2000),
          stderr: "failed neatly",
          stdout_truncated: true,
          stderr_truncated: false,
        },
      },
    ]);
  });

  it("rejects unknown profiles with a clear error", () => {
    expect(() => parseVerifyProfile("nightly")).toThrow(
      'Unknown verify profile: "nightly". Allowed: coordinator, worker, review',
    );
  });

  it("exits the CLI command for unknown profiles before running commands", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(verifyCommand("nightly", "/repo")).rejects.toThrow("process.exit(1)");

    expect(error).toHaveBeenCalledWith(
      'Unknown verify profile: "nightly". Allowed: coordinator, worker, review',
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});
