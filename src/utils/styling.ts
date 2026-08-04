import picocolors from "picocolors";

export interface StylingOptions {
  /** When true, skip ANSI color codes in string output. */
  noColor?: boolean;
}

/**
 * Return a picocolors chained color function for the given task status.
 * Returns plain picocolors.white for unknown statuses.
 */
export function colorForStatus(status: string): (text: string) => string {
  switch (status) {
    case "complete":
      return picocolors.green;
    case "in_progress":
      return picocolors.blue;
    case "needs_review":
      return picocolors.yellow;
    case "blocked":
      return picocolors.red;
    case "failed":
      return picocolors.red;
    case "partial":
      return picocolors.magenta;
    case "pending":
      return picocolors.dim;
    case "archived":
      return picocolors.gray;
    default:
      return picocolors.white;
  }
}

/**
 * Return a picocolors chained color function for the given priority.
 * Returns plain picocolors.white for unknown priorities.
 */
export function colorForPriority(priority: string): (text: string) => string {
  switch (priority) {
    case "critical":
      return picocolors.red;
    case "high":
      return picocolors.yellow;
    case "medium":
      return picocolors.blue;
    case "low":
      return picocolors.dim;
    default:
      return picocolors.white;
  }
}

/**
 * Map a task status to a compact unicode symbol.
 */
export function statusSymbol(status: string): string {
  const symbols: Record<string, string> = {
    pending: "○",
    in_progress: "▶",
    needs_review: "◆",
    complete: "✓",
    blocked: "⊘",
    failed: "✕",
    partial: "◐",
    archived: "◻",
  };
  return symbols[status] ?? "?";
}

/**
 * Return a colored priority badge string.
 * Maps: critical=[CRIT], high=[HIGH], medium=[MED], low=[LOW].
 */
export function priorityBadge(priority: string, options?: StylingOptions): string {
  const badges: Record<string, string> = {
    critical: "[CRIT]",
    high: "[HIGH]",
    medium: "[MED]",
    low: "[LOW]",
  };
  const badge = badges[priority] ?? "[?]";
  if (options?.noColor) return badge;
  const color = colorForPriority(priority);
  return color(badge);
}

/**
 * Render the branded "Manciple — A repo-native workflow layer" header banner.
 * When NO_COLOR is set (or noColor option is true), ANSI codes are skipped.
 */
export function headerBanner(options?: StylingOptions): string {
  const text = "Manciple — A repo-native workflow layer";
  if (options?.noColor) {
    return `${text}\n`;
  }
  // picocolors respects NO_COLOR internally, so when the env var is set,
  // bold/cyan will return plain text automatically
  return `${picocolors.bold(picocolors.cyan(text))}\n`;
}

/**
 * Pad and optionally color a cell value for table output.
 * Used by list and coordinator tables.
 */
export function styleCell(
  value: string,
  color: ((s: string) => string) | undefined,
  width: number,
  options?: StylingOptions,
): string {
  const padded = value.padEnd(width);
  if (options?.noColor || !color) return padded;
  return color(padded);
}

/**
 * Wrap a section header string in bold+underline formatting.
 * Used to colorize help output section headings (Commands, Options, etc.).
 */
export function styleHelpSection(header: string, options?: StylingOptions): string {
  if (options?.noColor) return header;
  // picocolors respects NO_COLOR internally
  return picocolors.bold(picocolors.underline(header));
}
