/**
 * Deployment-level kill switches for registered AI tools, for surfaces that
 * enumerate the tool registry directly rather than going through the chat
 * tool factories — Breeze's own MCP server (`routes/mcpServer.ts`) lists and
 * dispatches straight from `aiTools`, so a factory-only gate would leave a
 * disabled tool reachable there (Tool Catalog W03 quorum P3).
 *
 * A leaf module: env getters + a name list only, no registry import.
 */
import { flowsEnabled } from '../config/env';
import { FLOW_TOOL_NAMES } from './flows/toolNames';

const FLOW_TOOLS: ReadonlySet<string> = new Set<string>(FLOW_TOOL_NAMES);

/** True when `name` is a registered tool that this deployment has switched off. */
export function isToolEnvGatedOff(name: string): boolean {
  if (FLOW_TOOLS.has(name)) return !flowsEnabled();
  return false;
}
