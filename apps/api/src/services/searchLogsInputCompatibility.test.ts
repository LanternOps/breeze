import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
// Keep this schema construction test off unrelated dispatch/database services.
vi.mock('./aiTools', () => ({
  executeTool: vi.fn(), aiTools: { get: () => ({ definition: { description: 'Schema fixture' } }) }, toolManagesDbContext: () => false,
  getAllRegisteredToolNames: () => [], getToolAlwaysLoad: () => false,
  getToolSearchHint: () => undefined,
}));
import { buildBreezeSdkTools } from './aiAgentSdkTools';
import { toolInputSchemas } from './aiToolSchemas';

const sdkTool = buildBreezeSdkTools(() => { throw new Error('No handler execution'); })
  .find((tool) => tool.name === 'search_logs')!;
const schemas = [toolInputSchemas.search_logs!, z.object(sdkTool.inputSchema)];

describe('search_logs input compatibility across dispatch paths', () => {
  it.each([
    {},
    { query: null, cursor: null, countMode: null },
    { countMode: 'normal' },
    { countMode: 'exact' },
    { countMode: 'estimated' },
    { countMode: 'none' },
  ])('accepts supported optional arguments %j in both schemas', (input) => {
    for (const schema of schemas) expect(schema.safeParse(input).success).toBe(true);
  });

  it.each([
    { countMode: 'invented' }, { countMode: 5 }, { query: 5 }, { cursor: false },
    { timeRange: {} }, { timeRange: { start: '', end: '' } },
    { limit: 0 }, { limit: 501 },
  ])('still rejects invalid arguments %j', (input) => {
    for (const schema of schemas) expect(schema.safeParse(input).success).toBe(false);
  });
});
