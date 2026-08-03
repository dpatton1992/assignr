import { createInterface } from "readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "process";
import type { Readable, Writable } from "stream";
import { TASK_TYPES, PRIORITIES } from "../constants.js";
import type { TaskType, Priority } from "../constants.js";
import { createTask } from "../tasks/taskCreationService.js";

export interface NewTaskOptions {
  type: TaskType;
  domain: string;
  priority: Priority;
  goal?: string;
  implementationNotes?: string[];
  cwd: string;
  activeDir: string;
}

export type PromptQuestion = (prompt: string) => Promise<string>;

export interface NewTaskInteractiveOptions extends NewTaskOptions {
  input?: Readable;
  output?: Writable;
  question?: PromptQuestion;
}

interface NewTaskSpecValues {
  acceptanceCriteria: string[];
  verificationCommands: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  outputsRequired: string[];
  implementationNotes: string[];
  notes: string[];
}

export class TaskCreationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskCreationError";
  }
}

const defaultSpecValues: NewTaskSpecValues = {
  acceptanceCriteria: ["TODO: add acceptance criteria"],
  verificationCommands: ["TODO: add verification commands"],
  allowedPaths: ["TODO: add allowed paths"],
  forbiddenPaths: ["TODO: add forbidden paths"],
  outputsRequired: [
    "files_changed",
    "tests_run",
    "risks",
    "follow_up_tasks",
  ],
  implementationNotes: ["TODO: add behavior, product, or design constraints."],
  notes: ["TODO: add any notes or constraints."],
};

function writeTaskFile(title: string, options: NewTaskOptions, values: NewTaskSpecValues = defaultSpecValues): string {
  const { cwd } = options;
  const result = createTask({
    title,
    type: options.type,
    domain: options.domain,
    priority: options.priority,
    goal: options.goal,
    implementationNotes: options.implementationNotes ?? values.implementationNotes,
    acceptanceCriteria: values.acceptanceCriteria,
    verificationCommands: values.verificationCommands,
    allowedPaths: values.allowedPaths,
    forbiddenPaths: values.forbiddenPaths,
    outputsRequired: values.outputsRequired,
    notes: values.notes,
    activeDir: options.activeDir,
  });

  if (!result.ok) {
    if (result.code === "duplicate" && result.existingPath) {
      throw new TaskCreationError(`Error: task spec already exists at ${result.existingPath.replace(cwd + "/", "")}`);
    }
    const prefix = result.code === "invalid_type" || result.code === "invalid_priority" ? "" : "Error: ";
    throw new TaskCreationError(`${prefix}${result.message}`);
  }

  console.log(`Created: ${result.filePath.replace(cwd + "/", "")}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Edit the spec: ${result.filePath.replace(cwd + "/", "")}`);
  console.log(`  2. Run: manciple validate`);
  console.log(`  3. Run: manciple handoff ${result.id}`);

  return result.filePath;
}

async function askRequired(question: PromptQuestion, prompt: string): Promise<string> {
  while (true) {
    const value = (await question(prompt)).trim();
    if (value) {
      return value;
    }
    console.log("Please enter a value.");
  }
}

async function askWithDefault(question: PromptQuestion, prompt: string, defaultValue: string): Promise<string> {
  const value = (await question(`${prompt} [${defaultValue}]: `)).trim();
  return value || defaultValue;
}

async function askList(question: PromptQuestion, label: string, required: boolean): Promise<string[]> {
  const values: string[] = [];

  while (true) {
    const suffix = values.length === 0 ? "" : " (blank to finish)";
    const value = (await question(`${label}${suffix}: `)).trim();
    if (!value) {
      if (required && values.length === 0) {
        console.log("Please enter at least one value.");
        continue;
      }
      return values;
    }
    values.push(value);
  }
}

export function newCommand(title: string, options: NewTaskOptions): string {
  return writeTaskFile(title, options);
}

export async function newInteractiveCommand(
  title: string | undefined,
  options: NewTaskInteractiveOptions,
): Promise<string> {
  const readline = options.question
    ? undefined
    : createInterface({
        input: options.input ?? defaultInput,
        output: options.output ?? defaultOutput,
      });
  const question = options.question ?? ((prompt: string) => readline!.question(prompt));

  try {
    const interactiveTitle = title?.trim() || (await askRequired(question, "Title: "));
    const goal = options.goal
      ? await askWithDefault(question, "Goal", options.goal)
      : await askRequired(question, "Goal: ");
    const typeValue = await askWithDefault(question, `Type (${TASK_TYPES.join(", ")})`, options.type);
    const domain = await askWithDefault(question, "Domain", options.domain);
    const priorityValue = await askWithDefault(question, `Priority (${PRIORITIES.join(", ")})`, options.priority);
    const values: NewTaskSpecValues = {
      acceptanceCriteria: await askList(question, "Acceptance criterion", true),
      verificationCommands: await askList(question, "Verification command", true),
      allowedPaths: await askList(question, "Allowed path", false),
      forbiddenPaths: await askList(question, "Forbidden path", false),
      outputsRequired: await askList(question, "Output required", false),
      implementationNotes: options.implementationNotes ?? [],
      notes: await askList(question, "Note", false),
    };

    // type/priority are validated by the shared creation service at write time.
    return writeTaskFile(interactiveTitle, {
      ...options,
      goal,
      type: typeValue as TaskType,
      domain,
      priority: priorityValue as Priority,
    }, values);
  } catch (error) {
    if (error instanceof TaskCreationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new TaskCreationError(`Error: interactive task creation failed: ${message}`);
  } finally {
    readline?.close();
  }
}
