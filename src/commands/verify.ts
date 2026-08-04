import { spawn } from "node:child_process";

export const VERIFY_PROFILE_NAMES = ["coordinator", "worker", "review"] as const;
export type VerifyProfile = (typeof VERIFY_PROFILE_NAMES)[number];

export const VERIFY_PROFILES: Record<VerifyProfile, readonly string[]> = {
  coordinator: ["pnpm typecheck", "pnpm test -- coordinator", "pnpm test -- mcpList"],
  worker: ["pnpm typecheck", "pnpm test -- verify", "pnpm test -- runLog", "pnpm test -- mcpList"],
  review: [
    "pnpm typecheck",
    "pnpm test -- reviewCheck",
    "pnpm test -- reviewQueue",
    "pnpm test -- mcpList",
  ],
};

const MAX_SNIPPET_CHARS = 2_000;

export interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type VerifyCommandRunner = (command: string, cwd: string) => Promise<CommandRunResult>;

export interface VerifyCommandReceipt {
  command: string;
  exit_code: number;
  ok: boolean;
}

export interface CompactOutput {
  stdout?: string;
  stderr?: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

export interface VerifyFailureReceipt extends VerifyCommandReceipt {
  output: CompactOutput;
}

export interface VerifyReceipt {
  ok: boolean;
  profile: VerifyProfile;
  commands_run: VerifyCommandReceipt[];
  failures: VerifyFailureReceipt[];
  output: {
    included: "failures_only";
    max_chars_per_stream: number;
  };
}

export function parseVerifyProfile(profile: string): VerifyProfile {
  if (VERIFY_PROFILE_NAMES.includes(profile as VerifyProfile)) {
    return profile as VerifyProfile;
  }

  throw new Error(
    `Unknown verify profile: "${profile}". Allowed: ${VERIFY_PROFILE_NAMES.join(", ")}`,
  );
}

function compactStream(value: string): { value?: string; truncated: boolean } {
  if (value.length === 0) {
    return { truncated: false };
  }

  if (value.length <= MAX_SNIPPET_CHARS) {
    return { value, truncated: false };
  }

  return { value: value.slice(0, MAX_SNIPPET_CHARS), truncated: true };
}

function compactOutput(result: CommandRunResult): CompactOutput {
  const stdout = compactStream(result.stdout);
  const stderr = compactStream(result.stderr);

  return {
    ...(stdout.value !== undefined ? { stdout: stdout.value } : {}),
    ...(stderr.value !== undefined ? { stderr: stderr.value } : {}),
    stdout_truncated: stdout.truncated,
    stderr_truncated: stderr.truncated,
  };
}

function appendBounded(previous: string, chunk: Buffer | string): string {
  if (previous.length > MAX_SNIPPET_CHARS) {
    return previous;
  }

  return `${previous}${chunk.toString()}`.slice(0, MAX_SNIPPET_CHARS + 1);
}

export async function shellCommandRunner(command: string, cwd: string): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });

    child.on("error", (err) => {
      stderr = appendBounded(stderr, err.message);
      resolve({ exitCode: 1, stdout, stderr });
    });

    child.on("close", (code, signal) => {
      resolve({
        exitCode: code ?? (signal ? 1 : 0),
        stdout,
        stderr,
      });
    });
  });
}

export async function runVerifyProfile(
  profile: VerifyProfile,
  options: {
    cwd: string;
    runner?: VerifyCommandRunner;
  },
): Promise<VerifyReceipt> {
  const runner = options.runner ?? shellCommandRunner;
  const commands = VERIFY_PROFILES[profile];
  const commandsRun: VerifyCommandReceipt[] = [];
  const failures: VerifyFailureReceipt[] = [];

  for (const command of commands) {
    const result = await runner(command, options.cwd);
    const commandReceipt = {
      command,
      exit_code: result.exitCode,
      ok: result.exitCode === 0,
    };
    commandsRun.push(commandReceipt);

    if (!commandReceipt.ok) {
      failures.push({
        ...commandReceipt,
        output: compactOutput(result),
      });
    }
  }

  return {
    ok: failures.length === 0,
    profile,
    commands_run: commandsRun,
    failures,
    output: {
      included: "failures_only",
      max_chars_per_stream: MAX_SNIPPET_CHARS,
    },
  };
}

export async function verifyCommand(profileName: string | undefined, cwd: string): Promise<void> {
  if (!profileName) {
    console.error(`Missing verify profile. Allowed: ${VERIFY_PROFILE_NAMES.join(", ")}`);
    process.exit(1);
  }

  let profile: VerifyProfile;
  try {
    profile = parseVerifyProfile(profileName);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  const receipt = await runVerifyProfile(profile, { cwd });
  console.log(JSON.stringify(receipt, null, 2));
  if (!receipt.ok) {
    process.exit(1);
  }
}
