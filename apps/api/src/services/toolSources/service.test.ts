import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { ToolSourceRow } from '../../db/schema';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../partnerWideAccess';

const { insertMock, updateMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { insert: insertMock, update: updateMock, select: vi.fn(), delete: vi.fn() },
}));

vi.mock('../../db/schema', () => ({
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  toolSources: {
    id: 'toolSources.id',
    orgId: 'toolSources.orgId',
    partnerId: 'toolSources.partnerId',
    slug: 'toolSources.slug',
    name: 'toolSources.name',
    kind: 'toolSources.kind',
    endpointUrl: 'toolSources.endpointUrl',
    credentialOrigin: 'toolSources.credentialOrigin',
    authKind: 'toolSources.authKind',
    authConfigEncrypted: 'toolSources.authConfigEncrypted',
    authFingerprint: 'toolSources.authFingerprint',
    status: 'toolSources.status',
    lastDiscoveredAt: 'toolSources.lastDiscoveredAt',
    lastError: 'toolSources.lastError',
    rateLimitPerMinute: 'toolSources.rateLimitPerMinute',
    createdByUserId: 'toolSources.createdByUserId',
    createdAt: 'toolSources.createdAt',
    updatedAt: 'toolSources.updatedAt',
  },
  toolSourceTools: {
    id: 'toolSourceTools.id',
    sourceId: 'toolSourceTools.sourceId',
    orgId: 'toolSourceTools.orgId',
    partnerId: 'toolSourceTools.partnerId',
    name: 'toolSourceTools.name',
    qualifiedName: 'toolSourceTools.qualifiedName',
    enabled: 'toolSourceTools.enabled',
    removedAt: 'toolSourceTools.removedAt',
    tier: 'toolSourceTools.tier',
    reviewNeeded: 'toolSourceTools.reviewNeeded',
    lastError: 'toolSourceTools.lastError',
    updatedAt: 'toolSourceTools.updatedAt',
  },
}));

vi.mock('./secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secrets')>();
  return { ...actual, encryptToolSourceAuth: vi.fn() };
});

import { credentialOriginFor, encryptToolSourceAuth } from './secrets';
import { bulkToolsAction, createToolSourceRow, patchSourceTool, resolveToolSourceOwner, toToolSourceDto, updateToolSourceRow } from './service';

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

describe('createToolSourceRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives credentialOrigin from the endpoint and stores the encrypted auth config', async () => {
    vi.mocked(encryptToolSourceAuth).mockReturnValue({ encrypted: 'ciphertext-1', fingerprint: 'fp-1' });
    const returning = vi.fn().mockResolvedValue([{ id: 'src-new' }]);
    const values = vi.fn().mockReturnValue({ returning });
    insertMock.mockReturnValue({ values });

    const input = {
      slug: 'hudu',
      name: 'Hudu',
      kind: 'mcp',
      endpointUrl: 'https://hudu.example.com/mcp?x=1',
      authKind: 'bearer',
      authConfig: { token: 'tok_abc' },
      rateLimitPerMinute: 60,
    } as unknown as Parameters<typeof createToolSourceRow>[1];

    await createToolSourceRow({ orgId: 'org-A', partnerId: null }, input, 'user-1');

    expect(values).toHaveBeenCalledTimes(1);
    const row = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.credentialOrigin).toBe(credentialOriginFor(input.endpointUrl));
    expect(row.credentialOrigin).toBe('https://hudu.example.com');
    expect(row.authConfigEncrypted).toBe('ciphertext-1');
    expect(row.authFingerprint).toBe('fp-1');
    expect(encryptToolSourceAuth).toHaveBeenCalledWith(row.id, { authKind: 'bearer', token: 'tok_abc' });
  });
});

describe('updateToolSourceRow', () => {
  function makeExisting(overrides: Partial<ToolSourceRow> = {}): ToolSourceRow {
    return {
      id: 'src-1',
      orgId: 'org-A',
      partnerId: null,
      slug: 'hudu',
      name: 'Hudu',
      kind: 'mcp',
      endpointUrl: 'https://old.example.com/mcp',
      credentialOrigin: 'https://old.example.com',
      authKind: 'bearer',
      authConfigEncrypted: 'old-ciphertext',
      authFingerprint: 'old-fp',
      status: 'active',
      lastDiscoveredAt: null,
      lastError: null,
      rateLimitPerMinute: 60,
      createdByUserId: 'user-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    } as ToolSourceRow;
  }

  function mockUpdateChain(returnedRow: ToolSourceRow) {
    const returning = vi.fn().mockResolvedValue([returnedRow]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    updateMock.mockReturnValue({ set });
    return set;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-derives credentialOrigin from the new endpoint AND re-encrypts when both the endpoint and the credential change', async () => {
    vi.mocked(encryptToolSourceAuth).mockReturnValue({ encrypted: 'ciphertext-2', fingerprint: 'fp-2' });
    const existing = makeExisting();
    const set = mockUpdateChain({ ...existing, endpointUrl: 'https://new.example.com/mcp' });

    const outcome = await updateToolSourceRow(existing, {
      endpointUrl: 'https://new.example.com/mcp',
      authKind: 'bearer',
      authConfig: { token: 'tok_new' },
    } as unknown as Parameters<typeof updateToolSourceRow>[1]);

    if ('error' in outcome) throw new Error(`expected success, got: ${outcome.error}`);
    expect(set).toHaveBeenCalledTimes(1);
    const updates = set.mock.calls[0]![0] as Record<string, unknown>;
    expect(updates.endpointUrl).toBe('https://new.example.com/mcp');
    expect(updates.credentialOrigin).toBe(credentialOriginFor('https://new.example.com/mcp'));
    expect(updates.credentialOrigin).toBe('https://new.example.com');
    expect(updates.authConfigEncrypted).toBe('ciphertext-2');
    expect(updates.authFingerprint).toBe('fp-2');
    expect(encryptToolSourceAuth).toHaveBeenCalledWith(existing.id, { authKind: 'bearer', token: 'tok_new' });
    expect(outcome.discoveryTriggered).toBe(true);
  });

  it('re-derives credentialOrigin on a same-origin endpoint change without touching the encrypted auth config', async () => {
    const existing = makeExisting();
    const set = mockUpdateChain({ ...existing, endpointUrl: 'https://old.example.com/mcp2' });

    const outcome = await updateToolSourceRow(existing, {
      endpointUrl: 'https://old.example.com/mcp2',
    } as unknown as Parameters<typeof updateToolSourceRow>[1]);

    if ('error' in outcome) throw new Error(`expected success, got: ${outcome.error}`);
    const updates = set.mock.calls[0]![0] as Record<string, unknown>;
    expect(updates.credentialOrigin).toBe('https://old.example.com');
    expect(updates).not.toHaveProperty('authConfigEncrypted');
    expect(updates).not.toHaveProperty('authFingerprint');
    expect(encryptToolSourceAuth).not.toHaveBeenCalled();
    expect(outcome.discoveryTriggered).toBe(true);
  });

  // Same origin-binding contract as credentialOriginBinding.ts: a
  // stored credential must not silently follow an endpoint change to a new
  // origin.
  it('refuses an endpoint origin change that would carry the stored credential to the new origin', async () => {
    const existing = makeExisting();

    const outcome = await updateToolSourceRow(existing, {
      endpointUrl: 'https://other-origin.example.com/mcp',
    } as unknown as Parameters<typeof updateToolSourceRow>[1]);

    expect('error' in outcome).toBe(true);
    if (!('error' in outcome)) throw new Error('expected a refusal');
    expect(outcome.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('allows an endpoint origin change when a fresh credential is supplied in the same request', async () => {
    vi.mocked(encryptToolSourceAuth).mockReturnValue({ encrypted: 'ciphertext-2', fingerprint: 'fp-2' });
    const existing = makeExisting();
    const set = mockUpdateChain({ ...existing, endpointUrl: 'https://other-origin.example.com/mcp' });

    const outcome = await updateToolSourceRow(existing, {
      endpointUrl: 'https://other-origin.example.com/mcp',
      authKind: 'bearer',
      authConfig: { token: 'tok_fresh' },
    } as unknown as Parameters<typeof updateToolSourceRow>[1]);

    if ('error' in outcome) throw new Error(`expected success, got: ${outcome.error}`);
    const updates = set.mock.calls[0]![0] as Record<string, unknown>;
    expect(updates.endpointUrl).toBe('https://other-origin.example.com/mcp');
    expect(updates.credentialOrigin).toBe('https://other-origin.example.com');
  });

  it('allows an endpoint origin change when there is no stored credential to protect', async () => {
    const existing = makeExisting({ authKind: 'none', authConfigEncrypted: null, authFingerprint: null });
    const set = mockUpdateChain({ ...existing, endpointUrl: 'https://new.example.com/mcp' });

    const outcome = await updateToolSourceRow(existing, {
      endpointUrl: 'https://new.example.com/mcp',
    } as unknown as Parameters<typeof updateToolSourceRow>[1]);

    if ('error' in outcome) throw new Error(`expected success, got: ${outcome.error}`);
    const updates = set.mock.calls[0]![0] as Record<string, unknown>;
    expect(updates.endpointUrl).toBe('https://new.example.com/mcp');
  });

  it('leaves credentialOrigin and the encrypted auth config untouched when updating an unrelated field', async () => {
    const existing = makeExisting();
    const set = mockUpdateChain({ ...existing, name: 'Renamed Hudu' });

    const outcome = await updateToolSourceRow(existing, {
      name: 'Renamed Hudu',
    } as unknown as Parameters<typeof updateToolSourceRow>[1]);

    if ('error' in outcome) throw new Error(`expected success, got: ${outcome.error}`);
    expect(set).toHaveBeenCalledTimes(1);
    const updates = set.mock.calls[0]![0] as Record<string, unknown>;
    expect(updates.name).toBe('Renamed Hudu');
    expect(updates).not.toHaveProperty('credentialOrigin');
    expect(updates).not.toHaveProperty('endpointUrl');
    expect(updates).not.toHaveProperty('authKind');
    expect(updates).not.toHaveProperty('authConfigEncrypted');
    expect(updates).not.toHaveProperty('authFingerprint');
    expect(encryptToolSourceAuth).not.toHaveBeenCalled();
    expect(outcome.discoveryTriggered).toBe(false);
  });
});

describe('patchSourceTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeTool(overrides: Record<string, unknown> = {}) {
    return {
      id: 'tool-1',
      sourceId: 'source-1',
      removedAt: null,
      lastError: null,
      tier: 1,
      enabled: false,
      reviewNeeded: true,
      ...overrides,
    } as unknown as Parameters<typeof patchSourceTool>[0];
  }

  it('refuses a bare {enabled: true} patch on a tool still flagged reviewNeeded', async () => {
    const outcome = await patchSourceTool(makeTool(), { enabled: true });

    expect(outcome.ok).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('allows enabling a reviewNeeded tool when the same patch also sets a tier', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'tool-1', tier: 2, enabled: true, reviewNeeded: false }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    updateMock.mockReturnValue({ set });

    const outcome = await patchSourceTool(makeTool(), { enabled: true, tier: 2 });

    expect(outcome.ok).toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
    const updates = set.mock.calls[0]![0] as Record<string, unknown>;
    expect(updates.reviewNeeded).toBe(false);
  });

  it('still allows disabling a reviewNeeded tool (turning enabled off is never gated)', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'tool-1', tier: 1, enabled: false, reviewNeeded: true }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    updateMock.mockReturnValue({ set });

    const outcome = await patchSourceTool(makeTool({ enabled: true }), { enabled: false });

    expect(outcome.ok).toBe(true);
  });

  it('allows enabling a tool that no longer needs review', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'tool-1', tier: 1, enabled: true, reviewNeeded: false }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    updateMock.mockReturnValue({ set });

    const outcome = await patchSourceTool(makeTool({ reviewNeeded: false }), { enabled: true });

    expect(outcome.ok).toBe(true);
  });
});

describe('bulkToolsAction — enable_reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('excludes rows still flagged reviewNeeded from the enable-reads WHERE clause', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    updateMock.mockReturnValue({ set });

    await bulkToolsAction('source-1', 'enable_reads');

    expect(where).toHaveBeenCalledTimes(1);
    const cond = where.mock.calls[0]![0];
    const dialect = new PgDialect();
    const q = dialect.sqlToQuery(cond);
    expect(q.sql).toContain('is null');
    expect(q.params).toContain('toolSourceTools.reviewNeeded');
    // The value bound immediately after the reviewNeeded column reference
    // must be `false` — a row still pending human review is excluded.
    const idx = q.params.indexOf('toolSourceTools.reviewNeeded');
    expect(q.params[idx + 1]).toBe(false);
  });
});
