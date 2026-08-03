import { createRequire } from "module";

// Single source of truth for the Manciple package version. The loader resolves
// package.json relative to this module, so it works both from source execution
// (tsx, `src/`) and from the built dist entry points (`dist/`). The CLI and the
// MCP server must both report this same value.
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export const packageVersion = version;
