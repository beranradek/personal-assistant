import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { TMUX_TOOLS } from "../tmux-agents/tools.js";
import type { TmuxAgentService } from "../tmux-agents/types.js";

/**
 * In-process SDK MCP server (name `tmuxagents`, tools `mcp__tmuxagents__agent_session_*`) for the Agent SDK backend.
 * Register it only when the tmux agent service exists (`tmuxAgents.enabled`).
 */
export function createTmuxAgentsServer(service: TmuxAgentService) {
  return createSdkMcpServer({
    name: "tmuxagents",
    version: "1.0.0",
    tools: TMUX_TOOLS.map((def) =>
      tool(def.name, def.description, def.shape, async (args) => def.run(service, args), { annotations: def.annotations }),
    ),
  });
}
