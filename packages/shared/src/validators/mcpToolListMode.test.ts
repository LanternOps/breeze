import { describe, expect, it } from 'vitest';
import { MCP_TOOL_LIST_MODES } from '../types/aiToolDomains';
import { mcpToolListModeInputSchema } from './mcpDomains';

describe('mcpToolListModeInputSchema', () => {
  it.each([...MCP_TOOL_LIST_MODES, null])('accepts %s', (value) => {
    expect(mcpToolListModeInputSchema.parse(value)).toBe(value);
  });

  it.each(['Full', 'PROGRESSIVE', '', 'bulk', ' full', 1, true, [], ['full'], undefined])('refuses %j', (value) => {
    expect(mcpToolListModeInputSchema.safeParse(value).success).toBe(false);
  });

  it('knows exactly the two modes', () => {
    expect(MCP_TOOL_LIST_MODES).toEqual(['full', 'progressive']);
  });
});
