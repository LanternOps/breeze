import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

vi.mock('./aiTools', () => ({ executeTool: vi.fn() }));
vi.mock('../db', () => ({ withDbAccessContext: vi.fn(), runOutsideDbContext: vi.fn() }));

import { buildScriptBuilderTools } from './scriptBuilderTools';
import type { AuthContext } from '../middleware/auth';

/**
 * The MCP server answers `tools/list` by converting every tool's input shape
 * with Zod 4's `toJSONSchema` (`io: 'input'`, see `toJsonSchemaCompat` in
 * @modelcontextprotocol/sdk). One unrepresentable field throws for the WHOLE
 * list, so the model is handed zero tools and writes the code into the chat
 * instead of the editor — which is what a `z.undefined()` field in the shared
 * parameter-definition schema did once the Agent SDK moved to this converter.
 */
describe('script builder tool input schemas', () => {
  const tools = buildScriptBuilderTools(() => ({}) as AuthContext) as Array<{
    name: string;
    inputSchema: z.ZodRawShape;
  }>;

  it.each(tools.map((t) => [t.name, t.inputSchema] as const))(
    '%s converts to JSON Schema the way tools/list does',
    (_name, shape) => {
      expect(() => z.toJSONSchema(z.object(shape), { io: 'input' })).not.toThrow();
    },
  );
});
