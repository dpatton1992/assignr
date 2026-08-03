import { stringify } from "yaml";

export function formatYamlDocument(value: unknown): string {
  return `${stringify(value, { lineWidth: 88 }).trimEnd()}\n`;
}
