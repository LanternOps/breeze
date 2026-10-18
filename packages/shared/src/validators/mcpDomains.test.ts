import { describe, expect, it } from 'vitest';
import { AI_TOOL_DOMAINS, MCP_GRANTABLE_DOMAINS } from '../types/aiToolDomains';
import { mcpDomainsInputSchema, normalizeMcpDomainsInput } from './mcpDomains';

describe('MCP grantable domains (#6156)', () => {
  it('grantable domains are the 13 non-core domains', () => {
    expect(MCP_GRANTABLE_DOMAINS).toHaveLength(13);
    expect(MCP_GRANTABLE_DOMAINS).not.toContain('core');
    expect([...MCP_GRANTABLE_DOMAINS]).toEqual(AI_TOOL_DOMAINS.filter((d) => d !== 'core'));
  });

  it('accepts null and a non-empty grantable list', () => {
    expect(mcpDomainsInputSchema.parse(null)).toBeNull();
    expect(mcpDomainsInputSchema.parse(['tickets'])).toEqual(['tickets']);
  });

  it('rejects [], core, unknown values and over-long input', () => {
    expect(mcpDomainsInputSchema.safeParse([]).success).toBe(false);
    expect(mcpDomainsInputSchema.safeParse(['core']).success).toBe(false);
    expect(mcpDomainsInputSchema.safeParse(['psa']).success).toBe(false);
    expect(mcpDomainsInputSchema.safeParse([null]).success).toBe(false);
    expect(mcpDomainsInputSchema.safeParse('tickets').success).toBe(false);
    expect(mcpDomainsInputSchema.safeParse(Array(14).fill('tickets')).success).toBe(false);
  });

  it('normalizes order and duplicates; every-domain collapses to null', () => {
    expect(normalizeMcpDomainsInput(['tickets', 'devices', 'tickets'])).toEqual(['devices', 'tickets']);
    expect(normalizeMcpDomainsInput([...MCP_GRANTABLE_DOMAINS])).toBeNull();
    expect(normalizeMcpDomainsInput([...MCP_GRANTABLE_DOMAINS].reverse())).toBeNull();
    expect(normalizeMcpDomainsInput(null)).toBeNull();
  });
});
