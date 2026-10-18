import { describe, expect, it } from 'vitest';
import { AI_TOOL_DOMAINS } from '@breeze/shared';
import { buildWhoamiResult, MCP_WHOAMI_TOOL_DEFINITION, MCP_WHOAMI_TOOL_LIST_ENTRY, type WhoamiInput } from './mcpWhoami';
import { buildMcpToolPresentation } from './mcpToolPresentation';
import { parseStoredMcpDomains } from './mcpDomains';
import { getToolTier } from './aiTools';
import { MCP_WHOAMI_TOOL_NAME } from './aiToolNames';
import { extensionContributionRegistry } from '../extensions/contributionRegistry';

const base = (overrides: Partial<WhoamiInput> = {}): WhoamiInput => ({
  principal: { kind: 'api_key', id: 'key-1', name: 'CI key', clientId: null },
  tenant: { scope: 'organization', partnerId: 'partner-1', orgId: 'org-1' },
  scopes: ['ai:read'],
  domainGrant: parseStoredMcpDomains(null),
  approvalGate: { tier3RequiresWebApp: true, unattendedPrincipal: false },
  mfaGatedActionsUnavailable: false,
  ...overrides,
});

describe('MCP_WHOAMI_TOOL_DEFINITION', () => {
  it('is a no-argument tool with a short description', () => {
    expect(MCP_WHOAMI_TOOL_DEFINITION.name).toBe(MCP_WHOAMI_TOOL_NAME);
    expect(MCP_WHOAMI_TOOL_DEFINITION.input_schema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(MCP_WHOAMI_TOOL_DEFINITION.description.length).toBeLessThanOrEqual(200);
  });

  it('the static tools/list entry matches the shared presentation rules', () => {
    const { name, description, inputSchema, ...presentation } = MCP_WHOAMI_TOOL_LIST_ENTRY;
    expect(presentation).toEqual(buildMcpToolPresentation(MCP_WHOAMI_TOOL_DEFINITION, 1, 'core'));
    expect({ name, description, inputSchema }).toEqual({
      name: MCP_WHOAMI_TOOL_DEFINITION.name,
      description: MCP_WHOAMI_TOOL_DEFINITION.description,
      inputSchema: MCP_WHOAMI_TOOL_DEFINITION.input_schema,
    });
  });

  it('no registry tool is named whoami', () => {
    expect(getToolTier('whoami')).toBeUndefined();
  });

  it('an extension cannot register whoami', () => {
    // The shared registry is wired to hasCoreAiToolName by the aiToolNames leaf.
    expect(() => extensionContributionRegistry.activate({
      name: 'whoami-squatter',
      manifest: { routeNamespace: 'whoami-squatter' },
      aiTools: new Map([['whoami', {}]]),
    } as never)).toThrow(/reserved core tool name/);
  });
});

describe('buildWhoamiResult', () => {
  it('capability ladder', () => {
    expect(buildWhoamiResult(base({ scopes: ['ai:read'] })).capability).toBe('read');
    expect(buildWhoamiResult(base({ scopes: ['ai:read', 'ai:write'] })).capability).toBe('write');
    expect(buildWhoamiResult(base({ scopes: ['ai:read', 'ai:write', 'ai:execute'] })).capability).toBe('execute');
    expect(buildWhoamiResult(base({ scopes: ['ai:read', 'ai:execute'] })).capability).toBe('execute');
  });

  it('unrestricted grant reports all 14 domains', () => {
    const r = buildWhoamiResult(base());
    expect(r.domains).toEqual({ restricted: false, granted: [...AI_TOOL_DOMAINS], available: [...AI_TOOL_DOMAINS] });
  });

  it('restricted grant reports granted + core, available = 14', () => {
    const r = buildWhoamiResult(base({ domainGrant: parseStoredMcpDomains(['tickets', 'devices']) }));
    expect(r.domains).toEqual({ restricted: true, granted: ['core', 'devices', 'tickets'], available: [...AI_TOOL_DOMAINS] });
    expect(r.notes.join(' ')).toMatch(/areas you can ask to be granted/);
  });

  it('notes mention the web app when tier-3 is gated', () => {
    expect(buildWhoamiResult(base()).notes.join(' ')).toMatch(/Breeze web app/);
    const unattended = buildWhoamiResult(base({ approvalGate: { tier3RequiresWebApp: false, unattendedPrincipal: true } }));
    expect(unattended.notes.join(' ')).not.toMatch(/require interactive approval/);
    expect(buildWhoamiResult(base({ mfaGatedActionsUnavailable: true })).notes.join(' ')).toMatch(/multi-factor/);
  });

  it('carries principal and tenant through', () => {
    const r = buildWhoamiResult(base({
      principal: { kind: 'oauth', id: 'grant-1', name: 'OAuth bearer', clientId: 'client-1' },
      tenant: { scope: 'partner', partnerId: 'partner-1', orgId: null },
      scopes: ['ai:read', 'ai:write'],
    }));
    expect(r).toMatchObject({
      kind: 'oauth', id: 'grant-1', name: 'OAuth bearer', clientId: 'client-1',
      tenant: { scope: 'partner', partnerId: 'partner-1', orgId: null },
      scopes: ['ai:read', 'ai:write'],
    });
  });

  it('never contains secret-shaped fields', () => {
    const r = buildWhoamiResult(base({ domainGrant: parseStoredMcpDomains(['tickets']) }));
    const keys: string[] = [];
    JSON.stringify(r, (k, v) => { if (k) keys.push(k); return v; });
    for (const k of keys) expect(k).not.toMatch(/keyHash|key_hash|payload|refresh|jwt|token/i);
  });
});
