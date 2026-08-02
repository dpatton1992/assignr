import React from "react";
import { render } from "ink";
import type { ManciplePaths } from "../utils/paths.js";
import { createReviewService } from "./service.js";
import { createGraphService } from "./graphService.js";
import { ReviewTui } from "./app.js";
import type { ReviewTuiSession } from "./app.js";
import { openInPager } from "./pager.js";

export interface ReviewTuiRunOptions {
  env?: NodeJS.ProcessEnv;
}

/**
 * Launch the interactive review dashboard.
 *
 * Pager round-trip: the `d` and `r` keys open detailed diffs and long receipts
 * through the user's PAGER. Because a pager needs the real terminal, the Ink
 * instance is unmounted first (which restores the terminal), the pager runs,
 * and the app is re-rendered afterwards from the preserved session so the user
 * returns to the same task and view. The function resolves only when the user
 * actually quits (q / Escape / Ctrl-C).
 */
export async function runReviewTui(p: ManciplePaths, cwd: string, options: ReviewTuiRunOptions = {}): Promise<void> {
  const service = createReviewService(p, cwd);
  const graphService = createGraphService(p, cwd);
  const env = options.env ?? process.env;
  const session: ReviewTuiSession = { selectedTaskId: null, view: "list", scroll: 0 };
  let pendingPager: string | null = null;

  while (true) {
    let app: ReturnType<typeof render> | null = null;
    app = render(
      React.createElement(ReviewTui, {
        service,
        graphService,
        cwd,
        session,
        onOpenPager: (content: string) => {
          pendingPager = content;
          // Restore the terminal so the pager owns the screen.
          app?.unmount();
        },
      }),
      { exitOnCtrlC: false }
    );
    await app.waitUntilExit();

    if (pendingPager === null) {
      break; // real exit via q / Escape / Ctrl-C
    }

    const content = pendingPager;
    pendingPager = null;
    await openInPager(content, { env });
    // Loop re-renders the TUI from the preserved session.
  }
}
