/**
 * The JSON Schema an in-process SDK MCP tool advertises (#11395). The Agent
 * SDK's `createSdkMcpServer` answers `tools/list` by converting each tool's
 * Zod raw shape with zod v4 `toJSONSchema(z.object(shape), { target:
 * 'draft-7', io: 'input' })` (the bundled MCP server's `toJsonSchemaCompat`);
 * the CLI forwards that object unchanged as the Messages API `input_schema`.
 * Mirrored here so the offline prefix measurement and the no-loosening proof
 * read the same bytes the model is sent.
 */
import { z } from 'zod';
import type { SdkTool } from '../../aiAgents/outcomeTools';

export function advertisedInputSchema(tool: Pick<SdkTool, 'inputSchema'>): Record<string, unknown> {
  return z.toJSONSchema(z.object(tool.inputSchema as z.ZodRawShape), { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
}

/** The Messages API tool entry the CLI sends for an MCP tool. */
export function advertisedTool(serverName: string, tool: Pick<SdkTool, 'name' | 'description' | 'inputSchema'>): {
  name: string; description: string; input_schema: Record<string, unknown>;
} {
  return { name: `mcp__${serverName}__${tool.name}`, description: tool.description, input_schema: advertisedInputSchema(tool) };
}
