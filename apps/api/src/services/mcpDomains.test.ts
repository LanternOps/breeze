import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_TOOL_DOMAINS } from '@breeze/shared';
import {
  buildDomainNotGrantedError,
  isDomainGranted,
  MCP_TENANT_TOOL_DOMAIN,
  mcpResourceDomain,
  mcpToolDomain,
  parseStoredMcpDomains,
} from './mcpDomains';
import { getAllRegisteredToolNames } from './aiTools';
import { hasCoreAiToolName, MCP_WHOAMI_TOOL_NAME } from './aiToolNames';
import { DEPRECATED_TOOL_ALIASES, resolveDeprecatedToolAlias } from './aiToolAliases';

afterEach(() => vi.restoreAllMocks());

describe('parseStoredMcpDomains', () => {
  it('null is unrestricted; undefined and non-arrays fail closed to core-only', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseStoredMcpDomains(null)).toEqual({ restricted: false });

    const missing = parseStoredMcpDomains(undefined);
    expect(missing.restricted).toBe(true);
    expect(missing.restricted && missing.domains.size).toBe(0);
    expect(err).toHaveBeenCalledWith('[MCP] principal context missing mcpDomains');

    for (const bad of ['tickets', 42, { tickets: true }, true]) {
      const g = parseStoredMcpDomains(bad);
      expect(g.restricted).toBe(true);
      expect(g.restricted && g.domains.size).toBe(0);
    }
  });

  it('unknown stored values grant nothing and never widen', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mixed = parseStoredMcpDomains(['tickets', 'legacy_x']);
    expect(mixed.restricted).toBe(true);
    expect(mixed.restricted && [...mixed.domains]).toEqual(['tickets']);

    const onlyUnknown = parseStoredMcpDomains(['legacy_x']);
    expect(onlyUnknown).toEqual({ restricted: true, domains: new Set() });
    expect(isDomainGranted(onlyUnknown, 'tickets')).toBe(false);
    expect(isDomainGranted(onlyUnknown, undefined)).toBe(false);
    expect(isDomainGranted(onlyUnknown, 'core')).toBe(true);

    // A stored 'core' (the CHECK forbids it) or an empty array never widens either.
    expect(parseStoredMcpDomains(['core'])).toEqual({ restricted: true, domains: new Set() });
    expect(parseStoredMcpDomains([])).toEqual({ restricted: true, domains: new Set() });
    expect(parseStoredMcpDomains([null, 'devices'])).toEqual({ restricted: true, domains: new Set(['devices']) });
    // Dropped values are logged (support symptom: "my key lost its tools").
    expect(warn).toHaveBeenCalledWith('[MCP] ignored unknown stored mcpDomains values', { dropped: 1, kept: 1 });
  });

  it('a clean stored set logs nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseStoredMcpDomains(['tickets', 'devices']);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('isDomainGranted', () => {
  it('core is always granted', () => {
    expect(isDomainGranted(parseStoredMcpDomains(['tickets']), 'core')).toBe(true);
    expect(isDomainGranted(parseStoredMcpDomains(null), 'core')).toBe(true);
  });

  it('a restricted grant passes only its domains', () => {
    const g = parseStoredMcpDomains(['tickets']);
    expect(isDomainGranted(g, 'tickets')).toBe(true);
    expect(isDomainGranted(g, 'devices')).toBe(false);
  });

  it('unclassified passes only when unrestricted', () => {
    expect(isDomainGranted(parseStoredMcpDomains(null), undefined)).toBe(true);
    const everything = parseStoredMcpDomains(AI_TOOL_DOMAINS.filter((d) => d !== 'core'));
    expect(isDomainGranted(everything, undefined)).toBe(false);
  });

  it('an unrestricted grant passes every domain', () => {
    for (const d of AI_TOOL_DOMAINS) expect(isDomainGranted(parseStoredMcpDomains(null), d)).toBe(true);
  });
});

describe('mcpResourceDomain', () => {
  it('device detail resource is devices, device list is core', () => {
    expect(mcpResourceDomain('breeze://devices')).toBe('core');
    expect(mcpResourceDomain('breeze://devices/3f6c2a1e-1b2c-4d5e-8f90-123456789abc')).toBe('devices');
  });

  it('every MCP resource URI family has a domain', () => {
    const uris = [
      'breeze://devices',
      'breeze://devices/3f6c2a1e-1b2c-4d5e-8f90-123456789abc',
      'breeze://alerts',
      'breeze://scripts',
      'breeze://automations',
    ];
    for (const uri of uris) expect(mcpResourceDomain(uri), uri).toBeDefined();
    expect(mcpResourceDomain('breeze://alerts')).toBe('monitoring');
    expect(mcpResourceDomain('breeze://scripts')).toBe('scripts');
    expect(mcpResourceDomain('breeze://automations')).toBe('scripts');
  });

  it('unknown URI families have no domain', () => {
    expect(mcpResourceDomain('breeze://secrets')).toBeUndefined();
    expect(mcpResourceDomain('breeze://devices/../alerts')).toBeUndefined();
  });
});

describe('deprecated aliases (real table)', () => {
  it('every deprecated alias resolves to a registered tool with a domain', () => {
    const registered = new Set(getAllRegisteredToolNames());
    expect(DEPRECATED_TOOL_ALIASES.size).toBeGreaterThan(0);
    for (const [alias, canonical] of DEPRECATED_TOOL_ALIASES) {
      expect(resolveDeprecatedToolAlias(alias)).toBe(canonical);
      expect(registered.has(canonical), `${alias} -> ${canonical}`).toBe(true);
      expect(mcpToolDomain(canonical), canonical).toBeDefined();
    }
  });
});

describe('mcpToolDomain', () => {
  it('every registered core tool resolves a domain', () => {
    const missing = getAllRegisteredToolNames().filter((name) => mcpToolDomain(name) === undefined);
    expect(missing).toEqual([]);
  });

  it('whoami is core and its name is reserved against extensions', () => {
    expect(MCP_WHOAMI_TOOL_NAME).toBe('whoami');
    expect(mcpToolDomain('whoami')).toBe('core');
    expect(hasCoreAiToolName('whoami')).toBe(true);
  });

  it('tenant tools count as integrations; unknown names are unclassified', () => {
    expect(MCP_TENANT_TOOL_DOMAIN).toBe('integrations');
    expect(mcpToolDomain('definitely_not_a_tool')).toBeUndefined();
  });
});

describe('buildDomainNotGrantedError', () => {
  it('names the tool, domain and the way out', () => {
    const err = buildDomainNotGrantedError('run_script', 'scripts');
    expect(err.code).toBe(-32003);
    expect(err.data).toEqual({ reason: 'domain_not_granted', domain: 'scripts', hint: expect.any(String) });
    expect(err.message).toBe(
      'Tool "run_script" is in the "scripts" domain, which this connection was not granted. Call whoami to see granted domains; reconnect or edit the API key to add it.',
    );
  });

  it('reports an unclassified tool as unclassified', () => {
    expect(buildDomainNotGrantedError('ext_tool', undefined).data.domain).toBe('unclassified');
  });
});
