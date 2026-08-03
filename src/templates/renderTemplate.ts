import type { TaskSpec } from "../specs/schema.js";

function formatList(items: string[] | undefined, bullet = "-"): string {
  if (!items || items.length === 0) return "_None specified._";
  return items.map((i) => `${bullet} ${i}`).join("\n");
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    return formatList(value.map((item) => String(item)));
  }

  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, nestedValue]) => `- ${key}: ${String(nestedValue)}`)
      .join("\n");
  }

  return String(value ?? "");
}

function formatDomainKey(key: string): string {
  return key
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function renderDomainContext(domain: Record<string, unknown>): string {
  const preferredKeys = [
    "id",
    "title",
    "description",
    "key_files",
    "conventions",
    "verification_baseline",
  ];
  const keys = [
    ...preferredKeys.filter((key) => key in domain),
    ...Object.keys(domain).filter((key) => !preferredKeys.includes(key)),
  ];

  return keys
    .map((key) => `### ${formatDomainKey(key)}\n\n${formatValue(domain[key])}`)
    .join("\n\n");
}

export const IMPLEMENTATION_TEMPLATE = `# Agent Task: {{title}}

## Role

You are an implementation agent working inside this repo.

## Goal

{{goal}}

## Task Metadata

- ID: {{id}}
- Type: {{type}}
- Domain: {{domain}}
- Priority: {{priority}}
- Status: {{status}}

## Dependencies

{{depends_on}}

## Scope

### Allowed Paths

{{allowed_paths}}

### Forbidden Paths

{{forbidden_paths}}

## Acceptance Criteria

{{acceptance_criteria}}

## Implementation Notes

{{implementation_notes}}

## Verification Commands

{{verification_commands}}

## Required Output

When finished, report:

{{outputs_required}}

## Notes

{{notes}}

## Instructions

- Make the smallest safe change that satisfies the task.
- Follow existing repo conventions.
- Do not modify forbidden paths.
- Do not add dependencies unless necessary.
- Run the verification commands.
- If blocked, explain why and propose a follow-up task.
- If you discover required work outside scope, do not implement it. Create a follow-up recommendation.
`;

export const REVIEW_TEMPLATE = `# Review Task: {{title}}

You are reviewing an agent-produced change.

Evaluate whether the implementation satisfies the task without creating unnecessary risk.

## Task Metadata

- ID: {{id}}
- Domain: {{domain}}
- Status: {{status}}

## Goal

{{goal}}

## Acceptance Criteria

{{acceptance_criteria}}

## Implementation Notes

{{implementation_notes}}

## Verification Commands

{{verification_commands}}

## Allowed Paths

{{allowed_paths}}

## Forbidden Paths

{{forbidden_paths}}

## Review Readiness

- Check run log, changed files, verification, generated artifacts, and risk evidence before deciding.
- Missing readiness evidence should be called out without blocking prompt generation.

## Implementation Review

- [ ] Allowed paths: changed files are limited to the task's allowed paths or clearly justified.
- [ ] Forbidden paths: no forbidden paths were modified.
- [ ] Acceptance criteria evidence: each criterion has implementation evidence in the diff or run log.
- [ ] Product/design decisions: runner-made behavior, UX, schema, evidence, or compatibility decisions are present in acceptance criteria, implementation notes, domain context, or notes.
- [ ] Verification evidence: required commands were run and their results are recorded.
- [ ] Generated artifacts: generated prompts, run logs, or other artifacts are present and named as expected.
- [ ] Risk notes: risks are recorded, or explicitly marked as none.

## Integration Review

- [ ] The change fits existing architecture and command/template conventions.
- [ ] Dependencies and lifecycle status are consistent with the task.
- [ ] Test, typecheck, and build coverage are adequate for the blast radius.
- [ ] No unnecessary abstractions, excessive scope, or duplicated behavior were introduced.
- [ ] Follow-up tasks are identified for any work outside scope.

## Decision

- [ ] Approve
- [ ] Request changes
- [ ] Block

### Reviewer Notes

### Findings

### Required Changes

### Suggested Follow-Ups

### Risk Assessment
`;

export const TEST_TEMPLATE = `# Test Task: {{title}}

## Role

You are a test agent. Your job is to ensure the implementation for this task is thoroughly tested.

## Task Metadata

- ID: {{id}}
- Domain: {{domain}}
- Priority: {{priority}}

## Goal

{{goal}}

## Acceptance Criteria

{{acceptance_criteria}}

## Verification Commands

{{verification_commands}}

## Allowed Paths

{{allowed_paths}}

## Instructions

- Write unit and integration tests for the acceptance criteria above.
- Do not modify application source beyond test setup.
- Run the verification commands to confirm all tests pass.
- Report coverage gaps and suggested follow-up test tasks.
`;

export function renderVerificationCommands(commands: string[]): string {
  if (!commands || commands.length === 0) return "_None specified._";
  return commands.map((cmd) => `\`\`\`bash\n${cmd}\n\`\`\``).join("\n\n");
}

export function implementationPromptFilename(taskId: string): string {
  return `${taskId}.md`;
}

export function reviewPromptFilename(taskId: string): string {
  return `review-${taskId}.md`;
}

export function renderTemplate(template: string, spec: TaskSpec, domainContext?: string): string {
  const rendered = template
    .replace(/{{title}}/g, spec.title)
    .replace(/{{id}}/g, spec.id)
    .replace(/{{type}}/g, spec.type)
    .replace(/{{domain}}/g, spec.domain)
    .replace(/{{priority}}/g, spec.priority ?? "medium")
    .replace(/{{status}}/g, spec.status)
    .replace(/{{goal}}/g, spec.goal.trim())
    .replace(/{{depends_on}}/g, formatList(spec.depends_on?.length ? spec.depends_on : undefined))
    .replace(
      /{{allowed_paths}}/g,
      formatList(spec.allowed_paths?.length ? spec.allowed_paths : undefined),
    )
    .replace(
      /{{forbidden_paths}}/g,
      formatList(spec.forbidden_paths?.length ? spec.forbidden_paths : undefined),
    )
    .replace(/{{acceptance_criteria}}/g, formatList(spec.acceptance_criteria))
    .replace(
      /{{implementation_notes}}/g,
      formatList(spec.implementation_notes?.length ? spec.implementation_notes : undefined),
    )
    .replace(
      /{{verification_commands}}/g,
      renderVerificationCommands(spec.verification?.commands ?? []),
    )
    .replace(
      /{{outputs_required}}/g,
      formatList(spec.outputs_required?.length ? spec.outputs_required : undefined),
    )
    .replace(/{{notes}}/g, formatList(spec.notes?.length ? spec.notes : undefined));

  if (!domainContext) return rendered;
  return `## Domain Context\n\n${domainContext}\n\n${rendered}`;
}
