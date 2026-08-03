import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerHandoffTools } from "./mcp/handoffTools.js";
export { compileTaskForMcp } from "./mcp/handoffTools.js";
import { registerOverviewTools } from "./mcp/overviewTools.js";
import { registerReviewTools } from "./mcp/reviewTools.js";
import { registerRunLogTools } from "./mcp/runLogTools.js";
import { registerTaskSpecTools } from "./mcp/taskSpecTools.js";
import { registerWorktreeTools } from "./mcp/worktreeTools.js";

const mcpServerName = "manciple";

const server = new McpServer({
  name: mcpServerName,
  version: "0.1.0",
});

registerOverviewTools(server);
registerTaskSpecTools(server);
registerHandoffTools(server);
registerRunLogTools(server);
registerReviewTools(server);
registerWorktreeTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
