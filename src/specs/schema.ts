import { z } from "zod";
import { PRIORITIES, STATUSES, TASK_TYPES } from "../constants.js";

export const TaskSpecSchema = z.object({
  id: z.string().min(1, "id is required").regex(/^\S+$/, "id must not contain spaces"),
  title: z.string().min(1, "title is required"),
  status: z.enum(STATUSES),
  type: z.enum(TASK_TYPES),
  domain: z.string().min(1, "domain is required"),
  priority: z.enum(PRIORITIES).optional().default("medium"),
  depends_on: z.array(z.string()).optional().default([]),
  blocks: z.array(z.string()).optional().default([]),
  conflicts_with: z.array(z.string()).optional().default([]),
  can_run_independently: z.boolean().optional().default(false),
  allowed_paths: z.array(z.string()).optional().default([]),
  forbidden_paths: z.array(z.string()).optional().default([]),
  path_ownership: z
    .object({
      touched_paths: z.array(z.string()).optional().default([]),
      locked_paths: z.array(z.string()).optional().default([]),
      unsafe_parallel_areas: z.array(z.string()).optional().default([]),
    })
    .optional()
    .default({
      touched_paths: [],
      locked_paths: [],
      unsafe_parallel_areas: [],
    }),
  goal: z.string().min(1, "goal is required"),
  acceptance_criteria: z.array(z.string()).min(1, "acceptance_criteria must not be empty"),
  implementation_notes: z.array(z.string()).optional().default([]),
  verification: z.object({
    commands: z.array(z.string()).min(1, "verification.commands must not be empty"),
  }),
  outputs_required: z.array(z.string()).optional().default([]),
  notes: z.array(z.string()).optional().default([]),
});

type ParsedTaskSpec = z.infer<typeof TaskSpecSchema>;
export type TaskSpec = Omit<ParsedTaskSpec, "implementation_notes"> & {
  implementation_notes?: string[];
};

export interface LoadedTask {
  spec: TaskSpec;
  filePath: string;
}
