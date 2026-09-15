import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { ToolSourceRow } from '../../db/schema';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../partnerWideAccess';
import { resolveToolSourceOwner, toToolSourceDto } from './service';

function orgAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    scope: 'organization',
    orgId: 'org-A',
    partnerId: undefined,
    canAccessOrg: (id: string) => id === 'org-A',
    orgCondition: () => undefined,
    user: { id: 'user-1' },
    accessibleOrgIds: ['org-A'],
    ...overrides,
  } as unknown as AuthContext;
}

function partnerAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    scope: 'partner',
    orgId: undefined,
    partnerId: 'partner-1',
    partnerOrgAccess: 'all',
    canAccessOrg: (id: string) => ['org-A', 'org-B'].includes(id),
    orgCondition: () => undefined,
    user: { id: 'user-1' },
    accessibleOrgIds: ['org-A', 'org-B'],
    ...overrides,
  } as unknown as AuthContext;
}

describe('resolveToolSourceOwner', () => {
  it('resolves a partner-wide owner for a full-access partner admin', async () => {
    const result = await resolveToolSourceOwner(partnerAuth({ partnerOrgAccess: 'all' }), { ownerScope: 'partner' });
    expect(result).toEqual({ owner: { orgId: null, partnerId: 'partner-1' } });
  });

  it('403s a partner-wide request from a selected-access partner user', async () => {
    const result = await resolveToolSourceOwner(partnerAuth({ partnerOrgAccess: 'selected' }), { ownerScope: 'partner' });
    expect(result).toEqual({ status: 403, error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
  });

  it('403s a partner-wide request with no partner id at all', async () => {
    const result = await resolveToolSourceOwner(partnerAuth({ partnerId: undefined }), { ownerScope: 'partner' });
    expect('error' in result && result.status).toBe(403);
  });

  it('resolves an org-scope token to its own org', async () => {
    const result = await resolveToolSourceOwner(orgAuth(), {});
    expect(result).toEqual({ owner: { orgId: 'org-A', partnerId: null } });
  });

  it('400s an org-scope token requesting a different org', async () => {
    const result = await resolveToolSourceOwner(orgAuth(), { orgId: 'org-B' });
    expect('error' in result && result.status).toBe(400);
  });

  it('403s a partner-scope token requesting an org it cannot access', async () => {
    const result = await resolveToolSourceOwner(partnerAuth(), { orgId: 'org-Z' });
    expect('error' in result && result.status).toBe(403);
  });

  it('resolves a partner-scope token to an explicit accessible org', async () => {
    const result = await resolveToolSourceOwner(partnerAuth(), { orgId: 'org-B' });
    expect(result).toEqual({ owner: { orgId: 'org-B', partnerId: null } });
  });

  it('resolves a partner-scope token with a single accessible org and no explicit orgId', async () => {
    const result = await resolveToolSourceOwner(
      partnerAuth({ accessibleOrgIds: ['org-A'] }),
      {},
    );
    expect(result).toEqual({ owner: { orgId: 'org-A', partnerId: null } });
  });

  it('400s a partner-scope token with multiple accessible orgs and no explicit orgId', async () => {
    const result = await resolveToolSourceOwner(partnerAuth({ accessibleOrgIds: ['org-A', 'org-B'] }), {});
    expect('error' in result && result.status).toBe(400);
  });
});

describe('toToolSourceDto', () => {
  function makeRow(overrides: Partial<ToolSourceRow> = {}): ToolSourceRow {
    return {
      id: 'src-1',
      orgId: 'org-A',
      partnerId: null,
      slug: 'hudu',
      name: 'Hudu',
      kind: 'mcp',
      endpointUrl: 'https://hudu.example.com/mcp',
      credentialOrigin: 'https://hudu.example.com',
      authKind: 'bearer',
      authConfigEncrypted: 'ciphertext-blob',
      authFingerprint: 'fingerprint-abc',
      status: 'active',
      lastDiscoveredAt: null,
      lastError: null,
      rateLimitPerMinute: 120,
      createdByUserId: 'user-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    } as ToolSourceRow;
  }

  it('never includes authConfigEncrypted or authFingerprint', () => {
    const dto = toToolSourceDto(makeRow());
    expect(dto).not.toHaveProperty('authConfigEncrypted');
    expect(dto).not.toHaveProperty('authFingerprint');
    expect(JSON.stringify(dto)).not.toContain('ciphertext-blob');
    expect(JSON.stringify(dto)).not.toContain('fingerprint-abc');
  });

  it('reports hasCredential:true for a non-none authKind', () => {
    expect(toToolSourceDto(makeRow({ authKind: 'bearer' })).hasCredential).toBe(true);
  });

  it('reports hasCredential:false for authKind none', () => {
    expect(toToolSourceDto(makeRow({ authKind: 'none', authConfigEncrypted: null, authFingerprint: null })).hasCredential).toBe(false);
  });

  it('defaults toolCount/enabledToolCount to 0 when counts are omitted', () => {
    const dto = toToolSourceDto(makeRow());
    expect(dto.toolCount).toBe(0);
    expect(dto.enabledToolCount).toBe(0);
  });

  it('carries through supplied counts', () => {
    const dto = toToolSourceDto(makeRow(), { toolCount: 5, enabledToolCount: 2 });
    expect(dto.toolCount).toBe(5);
    expect(dto.enabledToolCount).toBe(2);
  });
});
