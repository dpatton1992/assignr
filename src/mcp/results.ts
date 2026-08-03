import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

export function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
  };
}

export async function toolResult(
  fn: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}
