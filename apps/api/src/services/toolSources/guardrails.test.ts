import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../rate-limit', () => ({ rateLimiter: vi.fn() }));
vi.mock('../redis', () => ({ getRedis: vi.fn() }));

import { rateLimiter } from '../rate-limit';
import { getRedis } from '../redis';
import {
  checkTenantToolRateLimit,
  guardrailCheckForTenantTool,
  tenantToolPermissionRequirement,
} from './guardrails';
import type { TenantToolDescriptor } from './resolver';

function makeDescriptor(overrides: Partial<TenantToolDescriptor> = {}): TenantToolDescriptor {
  return {
    id: 'tool-1',
    sourceId: 'source-1',
    sourceName: 'Hudu',
    sourceKind: 'mcp',
    ownerRef: { orgId: 'org-1', partnerId: null },
    qualifiedName: 'hudu__get_asset',
    name: 'get_asset',
    description: 'Get an asset',
    inputSchema: { type: 'object' },
    tier: 1,
    revision: 'rev-1',
    rateLimitPerMinute: 60,
    validate: () => ({ success: true }),
    definition: { name: 'hudu__get_asset', description: 'Get an asset', input_schema: { type: 'object' } },
    ...overrides,
  };
}

describe('guardrailCheckForTenantTool', () => {
  it('tier 1: allowed, read-only, no approval required — satisfies the GuardrailCheck type', () => {
    const check = guardrailCheckForTenantTool(makeDescriptor({ tier: 1 }));
    expect(check.tier).toBe(1);
    expect(check.allowed).toBe(true);
    expect(check.readOnly).toBe(true);
    expect(check.requiresApproval).toBe(false);
    expect(check.approvalScope).toBeUndefined();
  });

  it('tier 2: allowed, requires approval, not read-only, no approvalScope', () => {
    const check = guardrailCheckForTenantTool(makeDescriptor({ tier: 2 }));
    expect(check.tier).toBe(2);
    expect(check.allowed).toBe(true);
    expect(check.requiresApproval).toBe(true);
    expect(check.readOnly).toBe(false);
    expect(check.approvalScope).toBeUndefined();
  });

  it('tier 3: allowed, requires approval, approvalScope "supervised" (REQUIRED by the type)', () => {
    const check = guardrailCheckForTenantTool(makeDescriptor({ tier: 3 }));
    expect(check.tier).toBe(3);
    expect(check.allowed).toBe(true);
    expect(check.requiresApproval).toBe(true);
    expect(check.readOnly).toBe(false);
    // This is the field the discriminated union makes REQUIRED on tier 3 —
    // a compile-time guarantee as well as a runtime one.
    expect(check.approvalScope).toBe('supervised');
  });

  it('description names the source', () => {
    const check = guardrailCheckForTenantTool(makeDescriptor({ qualifiedName: 'hudu__get_asset', sourceName: 'Hudu' }));
    expect(check.description).toContain('hudu__get_asset');
    expect(check.description).toContain('Hudu');
  });
});

describe('tenantToolPermissionRequirement', () => {
  it('tier 1 maps to external_tools:use', () => {
    expect(tenantToolPermissionRequirement(1)).toEqual({ resource: 'external_tools', action: 'use' });
  });

  it('tier 2 and 3 map to external_tools:write', () => {
    expect(tenantToolPermissionRequirement(2)).toEqual({ resource: 'external_tools', action: 'write' });
    expect(tenantToolPermissionRequirement(3)).toEqual({ resource: 'external_tools', action: 'write' });
  });
});

describe('checkTenantToolRateLimit', () => {
  beforeEach(() => {
    vi.mocked(rateLimiter).mockReset();
    vi.mocked(getRedis).mockReset();
  });

  it('calls rateLimiter with the source+principal key, the source rate limit, and a 60s window', async () => {
    vi.mocked(getRedis).mockReturnValue('redis-handle' as never);
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true, remaining: 5, resetAt: new Date(0) });

    const result = await checkTenantToolRateLimit(makeDescriptor({ sourceId: 'source-42', rateLimitPerMinute: 30 }), 'user-9');

    expect(result).toBeNull();
    expect(rateLimiter).toHaveBeenCalledWith('redis-handle', 'ai:exttool:source-42:user-9', 30, 60);
  });

  it('returns a human-readable error string when throttled', async () => {
    vi.mocked(getRedis).mockReturnValue(null);
    const resetAt = new Date('2026-01-01T00:00:00.000Z');
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: false, remaining: 0, resetAt });

    const result = await checkTenantToolRateLimit(makeDescriptor({ qualifiedName: 'hudu__get_asset' }), 'user-9');

    expect(result).toContain('hudu__get_asset');
    expect(result).toContain(resetAt.toISOString());
  });
});
