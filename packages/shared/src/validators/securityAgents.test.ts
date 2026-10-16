import { describe, it, expect } from 'vitest';
import {
  SECURITY_AGENT_VENDOR_KEYS,
  securityAgentsInlineSettingsSchema,
  securityAgentsEnabledVendorRequested,
} from './securityAgents';
import * as barrel from './index';

describe('securityAgentsInlineSettingsSchema (#6960)', () => {
  it('accepts an empty agent list (an explicit opt-out link)', () => {
    expect(securityAgentsInlineSettingsSchema.parse({ version: 1, agents: [] })).toEqual({ version: 1, agents: [] });
  });

  it('accepts every vendor key with optional platforms', () => {
    const parsed = securityAgentsInlineSettingsSchema.parse({
      version: 1,
      agents: [
        { vendor: 'huntress', enabled: false, platforms: ['windows', 'macos'] },
        { vendor: 'sentinelone', enabled: false },
        { vendor: 'controld', enabled: false },
        { vendor: 'nextdns', enabled: false, platforms: ['linux'] },
      ],
    });
    expect(parsed.agents.map((a) => a.vendor)).toEqual([...SECURITY_AGENT_VENDOR_KEYS]);
  });

  it('rejects an unknown top-level key, so a secret cannot ride along', () => {
    expect(securityAgentsInlineSettingsSchema.safeParse({ version: 1, agents: [], apiKey: '<acct-key>' }).success).toBe(false);
  });

  it('rejects an unknown key on an agent entry', () => {
    const r = securityAgentsInlineSettingsSchema.safeParse({
      version: 1,
      agents: [{ vendor: 'huntress', enabled: false, orgKey: '<org-key>' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects the same vendor twice', () => {
    const r = securityAgentsInlineSettingsSchema.safeParse({
      version: 1,
      agents: [{ vendor: 'huntress', enabled: false }, { vendor: 'huntress', enabled: false }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown vendor, a missing or wrong version, and a duplicate or unknown platform', () => {
    expect(securityAgentsInlineSettingsSchema.safeParse({ version: 1, agents: [{ vendor: 'acme', enabled: false }] }).success).toBe(false);
    expect(securityAgentsInlineSettingsSchema.safeParse({ agents: [] }).success).toBe(false);
    expect(securityAgentsInlineSettingsSchema.safeParse({ version: 2, agents: [] }).success).toBe(false);
    expect(securityAgentsInlineSettingsSchema.safeParse({ version: 1, agents: [{ vendor: 'huntress', enabled: false, platforms: ['windows', 'windows'] }] }).success).toBe(false);
    expect(securityAgentsInlineSettingsSchema.safeParse({ version: 1, agents: [{ vendor: 'huntress', enabled: false, platforms: ['solaris'] }] }).success).toBe(false);
  });

  it('is exported from the validators barrel', () => {
    expect(barrel.securityAgentsInlineSettingsSchema).toBe(securityAgentsInlineSettingsSchema);
  });
});

describe('securityAgentsEnabledVendorRequested', () => {
  it('reads enabled:true leniently, before any strict parse', () => {
    expect(securityAgentsEnabledVendorRequested({ version: 1, agents: [{ vendor: 'huntress', enabled: true }] })).toBe(true);
    // An otherwise-invalid payload still reports the arming request, so the
    // authorization check can run before validation.
    expect(securityAgentsEnabledVendorRequested({ agents: [{ vendor: 'acme', enabled: true, apiKey: 'x' }] })).toBe(true);
  });

  it('is false for disabled-only, empty and malformed payloads', () => {
    expect(securityAgentsEnabledVendorRequested({ version: 1, agents: [{ vendor: 'huntress', enabled: false }] })).toBe(false);
    expect(securityAgentsEnabledVendorRequested({ version: 1, agents: [] })).toBe(false);
    expect(securityAgentsEnabledVendorRequested(null)).toBe(false);
    expect(securityAgentsEnabledVendorRequested({ agents: 'huntress' })).toBe(false);
    expect(securityAgentsEnabledVendorRequested({ agents: [{ vendor: 'huntress', enabled: 'true' }] })).toBe(false);
  });
});
