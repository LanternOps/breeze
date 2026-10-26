/**
 * Deployment-level kill switches for registered AI tools, for surfaces that
 * enumerate the tool registry directly rather than going through the chat
 * tool factories — Breeze's own MCP server (`routes/mcpServer.ts`) lists and
 * dispatches straight from `aiTools`, so a factory-only gate would leave a
 * disabled tool reachable there (Tool Catalog W03 quorum P3).
 *
 * A leaf module: env getters + a name list only, no registry import.
 */
import { flowsEnabled, wispEnabled } from '../config/env';
import { FLOW_TOOL_NAMES } from './flows/toolNames';

const FLOW_TOOLS: ReadonlySet<string> = new Set<string>(FLOW_TOOL_NAMES);

/** Wisp W03 memory tools (services/wisp/memoryTools.ts); dark unless wispEnabled(). */
export const WISP_MEMORY_TOOL_NAMES = ['recall', 'remember', 'confirm_memory', 'retract_memory'] as const;
const WISP_MEMORY_TOOLS: ReadonlySet<string> = new Set<string>(WISP_MEMORY_TOOL_NAMES);

/** Wisp W05a concern/watch tools (services/wisp/concernTools.ts); dark unless wispEnabled(). */
export const WISP_CONCERN_TOOL_NAMES = ['list_concerns', 'raise_concern', 'snooze_concern', 'resolve_concern', 'create_watch'] as const;
const WISP_CONCERN_TOOLS: ReadonlySet<string> = new Set<string>(WISP_CONCERN_TOOL_NAMES);

/** Wisp W08 thread-link chat tools (services/wisp/linkTools.ts); dark unless wispEnabled(). */
export const WISP_LINK_TOOL_NAMES = ['link_entity', 'list_links'] as const;
const WISP_LINK_TOOLS: ReadonlySet<string> = new Set<string>(WISP_LINK_TOOL_NAMES);

/** Wisp W07 specialist chat tool (services/aiToolsWisp.ts); dark unless wispEnabled(). The carrier is human-only and never listed. */
export const WISP_SPECIALIST_TOOL_NAMES = ['launch_specialist'] as const;
const WISP_SPECIALIST_TOOLS: ReadonlySet<string> = new Set<string>(WISP_SPECIALIST_TOOL_NAMES);

/** True when `name` is a registered tool that this deployment has switched off. */
export function isToolEnvGatedOff(name: string): boolean {
  if (FLOW_TOOLS.has(name)) return !flowsEnabled();
  if (WISP_MEMORY_TOOLS.has(name) || WISP_CONCERN_TOOLS.has(name) || WISP_SPECIALIST_TOOLS.has(name) || WISP_LINK_TOOLS.has(name)) return !wispEnabled();
  return false;
}
