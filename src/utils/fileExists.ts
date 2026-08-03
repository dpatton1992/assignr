import { existsSync } from "node:fs";

export function fileExists(path: string): boolean {
  return existsSync(path);
}
