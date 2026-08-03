import type { Command } from "commander";
import { styleHelpSection } from "../utils/styling.js";

const DEPRECATED_COMMANDS = new Map<string, string>([
  ["compile", "handoff"],
  ["task-packet", "handoff --packet"],
  ["planner-context", "handoff"],
  ["coordinator", "handoff queue"],
  ["dispatch-plan", "handoff queue --json"],
  ["new", "task new"],
  ["list", "task list"],
  ["set-status", "task start|pause|resume"],
  ["status", "task show"],
  ["archive", "task archive"],
  ["reopen", "task reopen"],
  ["complete", "submit --complete"],
  ["run-log", "submit"],
  ["review-check", "review check"],
  ["review-queue", "review queue"],
  ["approve", "review approve"],
  ["request-changes", "review changes"],
  ["block-review", "review block"],
  ["validate", "check tasks"],
  ["doctor", "check"],
  ["check-lifecycle", "check lifecycle"],
  ["verify", "check verify --profile <profile>"],
  ["token-estimate", "check tokens"],
  ["summarize-run-cost", "check cost"],
]);

const PRIMARY_COMMANDS = new Set(["init", "task", "handoff", "submit", "review", "check"]);
const shownDeprecation = new Set<string>();

interface CommanderInternals extends Command {
  _hidden?: boolean;
  _actionHandler?: (...args: unknown[]) => unknown;
}

function emitDeprecation(name: string): void {
  if (shownDeprecation.has(name)) return;

  shownDeprecation.add(name);
  const replacement = DEPRECATED_COMMANDS.get(name);
  if (replacement) {
    console.error(`manciple ${name} -> manciple ${replacement}`);
  }
}

export function configureLegacyCommandCompatibility(program: Command, argv: string[]): string[] {
  for (const cmd of program.commands) {
    const name = cmd.name();
    if (name === "help") continue;
    if (PRIMARY_COMMANDS.has(name)) continue;

    const legacyCommand = cmd as CommanderInternals;
    legacyCommand._hidden = true;
    const replacement = DEPRECATED_COMMANDS.get(name);
    if (replacement && legacyCommand._actionHandler) {
      const origAction = legacyCommand._actionHandler;
      legacyCommand._actionHandler = function (...args: unknown[]) {
        emitDeprecation(name);
        return origAction.apply(this, args);
      };
    }
  }

  const showAllCommands = argv.slice(2).includes("--all");
  const origHelpInformation = program.helpInformation.bind(program);
  program.helpInformation = () => {
    const toggled: CommanderInternals[] = [];
    if (showAllCommands) {
      for (const cmd of program.commands) {
        const legacyCommand = cmd as CommanderInternals;
        if (legacyCommand._hidden) {
          legacyCommand._hidden = false;
          toggled.push(legacyCommand);
        }
      }
    }

    let help = origHelpInformation();

    for (const cmd of toggled) {
      cmd._hidden = true;
    }

    if (showAllCommands) {
      help = help.replace("Commands:", "All commands (primary and legacy):");
      help += "\nLegacy command examples:\n";
      for (const [old, replacement] of DEPRECATED_COMMANDS) {
        help += `  manciple ${old.padEnd(20)} → manciple ${replacement}\n`;
      }
    } else {
      help +=
        "\nRun `manciple --help --all` to show all commands, including legacy/deprecated ones.\n";
    }

    const sections = [
      "All commands (primary and legacy):",
      "Commands:",
      "Options:",
      "Examples:",
      "Notes:",
    ];
    for (const section of sections) {
      help = help.replace(section, styleHelpSection(section));
    }

    return help;
  };

  return argv.filter((arg) => arg !== "--all");
}
