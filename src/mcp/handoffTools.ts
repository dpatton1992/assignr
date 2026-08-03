import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parse } from "yaml";
import { z } from "zod";
import { formatTaskById } from "../commands/formatTask.js";
import { buildTaskPacket } from "../commands/taskPacket.js";
import { loadTasks, pathOwnershipWarningsForTask } from "../specs/loadTasks.js";
import type { TaskSpec } from "../specs/schema.js";
import {
  IMPLEMENTATION_TEMPLATE,
  REVIEW_TEMPLATE,
  renderDomainContext,
  renderTemplate,
  TEST_TEMPLATE,
} from "../templates/renderTemplate.js";
import { getRepoContext, repoInputSchema } from "./context.js";
import { errorResult, jsonResult, toolResult } from "./results.js";

function getTemplate(type: TaskSpec["type"]): string {
  switch (type) {
    case "review":
      return REVIEW_TEMPLATE;
    case "test":
      return TEST_TEMPLATE;
    default:
      return IMPLEMENTATION_TEMPLATE;
  }
}

function loadDomainContextForPaths(
  domain: string,
  specsDomainsDir: string,
  cwdForRelativePaths: string,
): { content?: string; warning?: string } {
  const domainPath = join(specsDomainsDir, `${domain}.yaml`);

  if (!existsSync(domainPath)) {
    return {
      warning: `Optional domain context not found for "${domain}" at ${relative(cwdForRelativePaths, domainPath)}; compiled without domain context.`,
    };
  }

  const raw = readFileSync(domainPath, "utf-8");
  const parsed = parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  return { content: renderDomainContext(parsed as Record<string, unknown>) };
}

export interface CompileTaskForMcpOptions {
  taskId: string;
  specsTasksDir: string;
  specsDomainsDir: string;
  promptsGeneratedDir: string;
  cwd: string;
}

export function compileTaskForMcp(options: CompileTaskForMcpOptions): {
  output_path: string;
  content: string;
  path_ownership_warnings: ReturnType<typeof pathOwnershipWarningsForTask>;
  warning?: string;
} {
  const { taskId, specsTasksDir, specsDomainsDir, promptsGeneratedDir, cwd } = options;
  const { tasks, errors } = loadTasks(specsTasksDir, "all");
  if (errors.length > 0) {
    const message = errors
      .map((error) => `${relative(cwd, error.filePath)}: ${error.error}`)
      .join("; ");
    throw new Error(`Cannot load tasks: ${message}`);
  }

  const found = tasks.find((task) => task.spec.id === taskId);
  if (!found) throw new Error(`Task not found: ${taskId}`);

  const pathOwnershipWarnings = pathOwnershipWarningsForTask(found, tasks);

  if (!existsSync(promptsGeneratedDir)) {
    mkdirSync(promptsGeneratedDir, { recursive: true });
  }

  const domainContext = loadDomainContextForPaths(found.spec.domain, specsDomainsDir, cwd);
  const content = renderTemplate(getTemplate(found.spec.type), found.spec, domainContext.content);
  const outputPath = join(promptsGeneratedDir, `${found.spec.id}.md`);
  writeFileSync(outputPath, content, "utf-8");

  return {
    output_path: outputPath,
    content,
    path_ownership_warnings: pathOwnershipWarnings,
    ...(domainContext.warning ? { warning: domainContext.warning } : {}),
  };
}

export function registerHandoffTools(server: McpServer): void {
  server.registerTool(
    "manciple_compile",
    {
      title: "Compile Manciple Task",
      description: "Compile one Manciple task into a generated markdown prompt.",
      inputSchema: {
        ...repoInputSchema,
        task_id: z.string(),
      },
    },
    ({ repo, task_id }) =>
      toolResult(() => {
        const ctx = getRepoContext(repo);
        try {
          return jsonResult({
            ...compileTaskForMcp({
              taskId: task_id,
              specsTasksDir: ctx.paths.specsTasks,
              specsDomainsDir: ctx.paths.specsDomains,
              promptsGeneratedDir: ctx.paths.promptsGenerated,
              cwd: ctx.cwd,
            }),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === `Task not found: ${task_id}`) return errorResult(message);
          throw err;
        }
      }),
  );

  server.registerTool(
    "manciple_format_task",
    {
      title: "Format Manciple Task YAML",
      description: "Check or format one Manciple task YAML file by task id.",
      inputSchema: {
        ...repoInputSchema,
        task_id: z.string(),
        check_only: z.boolean().optional(),
      },
    },
    ({ repo, task_id, check_only }) =>
      toolResult(() => {
        const ctx = getRepoContext(repo);
        try {
          return jsonResult(
            formatTaskById(task_id, {
              specsTasksDir: ctx.paths.specsTasks,
              cwd: ctx.cwd,
              checkOnly: check_only ?? false,
            }),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({
            checked: false,
            changed: false,
            file: null,
            errors: [message],
          });
        }
      }),
  );

  server.registerTool(
    "manciple_get_task_packet",
    {
      title: "Get Manciple Task Packet",
      description: "Return a compact bounded worker packet for one task.",
      inputSchema: {
        ...repoInputSchema,
        task_id: z.string(),
      },
    },
    ({ repo, task_id }) =>
      toolResult(() => {
        const ctx = getRepoContext(repo);
        try {
          return jsonResult(
            buildTaskPacket({
              taskId: task_id,
              specsTasksDir: ctx.paths.specsTasks,
              cwd: ctx.cwd,
            }),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === `Task not found: ${task_id}`) return errorResult(message);
          throw err;
        }
      }),
  );

  server.registerTool(
    "manciple_get_compiled_prompt",
    {
      title: "Get Compiled Manciple Prompt",
      description: "Read an existing compiled prompt for one Manciple task.",
      inputSchema: {
        ...repoInputSchema,
        task_id: z.string(),
      },
    },
    ({ repo, task_id }) =>
      toolResult(() => {
        const ctx = getRepoContext(repo);
        const promptPath = join(ctx.paths.promptsGenerated, `${task_id}.md`);
        if (!existsSync(promptPath)) {
          return errorResult(`Compiled prompt not found for task: ${task_id}`);
        }

        return jsonResult({ content: readFileSync(promptPath, "utf-8") });
      }),
  );
}
