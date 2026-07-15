import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  servicePrincipals: { id: 'id', orgId: 'orgId', status: 'status', scopes: 'scopes' },
  apiKeys: {
    id: 'id',
    orgId: 'orgId',
    principalId: 'principalId',
    principalType: 'principalType',
    status: 'status',
    scopes: 'scopes',
  },
}));

vi.mock('./auditService', () => ({
  createAuditLogAsync: vi.fn(),
}));

import { db } from '../db';
import { createAuditLogAsync } from './auditService';
import {
  createServicePrincipal,
  rotateServicePrincipalKey,
  disableServicePrincipal,
  migrateHumanKeyToServicePrincipal,
  ServicePrincipalNotFoundError,
  ApiKeyNotFoundError,
} from './servicePrincipals';

const PRINCIPAL_ID = 'principal-1';
const ORG_ID = 'org-1';
const ACTOR_ID = 'actor-1';

function mockSelectOnce(result: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
      }),
    }),
  } as any);
}

function mockInsertOnce(result: unknown[]) {
  vi.mocked(db.insert).mockReturnValueOnce({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(result),
    }),
  } as any);
}

function mockUpdateOnce(result: unknown[]) {
  const whereMock = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue(result),
  });
  vi.mocked(db.update).mockReturnValueOnce({
    set: vi.fn().mockReturnValue({ where: whereMock }),
  } as any);
  return whereMock;
}

// The two "cascade revoke" writes (rotate, disable) don't call .returning() —
// they're plain update().set().where() awaited directly.
function mockBareUpdateOnce() {
  const whereMock = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.update).mockReturnValueOnce({
    set: vi.fn().mockReturnValue({ where: whereMock }),
  } as any);
  return whereMock;
}

describe('createServicePrincipal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts an active principal row and audits the creation', async () => {
    mockInsertOnce([
      { id: PRINCIPAL_ID, orgId: ORG_ID, name: 'CI bot', status: 'active', scopes: ['ai:read'], createdBy: ACTOR_ID },
    ]);

    const result = await createServicePrincipal({ orgId: ORG_ID, name: 'CI bot', scopes: ['ai:read'], createdBy: ACTOR_ID });

    expect(result).toMatchObject({ id: PRINCIPAL_ID, status: 'active' });
    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID, actorId: ACTOR_ID, action: 'service_principal.create', resourceId: PRINCIPAL_ID }),
    );
  });

  it('throws when the insert returns no row', async () => {
    mockInsertOnce([]);
    await expect(
      createServicePrincipal({ orgId: ORG_ID, name: 'CI bot', scopes: [], createdBy: ACTOR_ID }),
    ).rejects.toThrow('Failed to create service principal');
  });
});

describe('rotateServicePrincipalKey', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws ServicePrincipalNotFoundError when the principal does not exist', async () => {
    mockSelectOnce([]);
    await expect(rotateServicePrincipalKey(PRINCIPAL_ID, ACTOR_ID)).rejects.toThrow(ServicePrincipalNotFoundError);
  });

  it('revokes any prior active key for the principal, mints a new one, and returns the raw key once', async () => {
    mockSelectOnce([{ id: PRINCIPAL_ID, orgId: ORG_ID, name: 'CI bot', status: 'active', scopes: ['ai:read'] }]);
    const revokeWhere = mockBareUpdateOnce();
    mockInsertOnce([
      { id: 'key-new', orgId: ORG_ID, name: 'CI bot (service key)', keyPrefix: 'brz_abcdefgh', scopes: ['ai:read'], status: 'active' },
    ]);

    const result = await rotateServicePrincipalKey(PRINCIPAL_ID, ACTOR_ID);

    expect(revokeWhere).toHaveBeenCalled();
    expect(result.apiKeyId).toBe('key-new');
    expect(result.key).toMatch(/^brz_/);
    expect(result.keyPrefix).toBe('brz_abcdefgh');
    // NEVER audit the raw key or its hash.
    expect(createAuditLogAsync).toHaveBeenCalledTimes(1);
    const auditCall = vi.mocked(createAuditLogAsync).mock.calls[0]?.[0];
    expect(JSON.stringify(auditCall)).not.toContain(result.key);
  });
});

describe('disableServicePrincipal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws ServicePrincipalNotFoundError when the principal does not exist', async () => {
    mockUpdateOnce([]);
    await expect(disableServicePrincipal(PRINCIPAL_ID, ACTOR_ID)).rejects.toThrow(ServicePrincipalNotFoundError);
  });

  // Guard-bite (a) supporting coverage: disable cascades to revoke every
  // active key for the principal (the auth-time deny is proven separately
  // in apiKeyAuthorization.test.ts).
  it('sets status=disabled and cascades api_keys.status=revoked for the principal', async () => {
    mockUpdateOnce([{ id: PRINCIPAL_ID, orgId: ORG_ID, name: 'CI bot', status: 'disabled' }]);
    const cascadeWhere = mockBareUpdateOnce();

    const result = await disableServicePrincipal(PRINCIPAL_ID, ACTOR_ID);

    expect(result.status).toBe('disabled');
    expect(cascadeWhere).toHaveBeenCalled();
    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'service_principal.disable', resourceId: PRINCIPAL_ID }),
    );
  });
});

describe('migrateHumanKeyToServicePrincipal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws ServicePrincipalNotFoundError when the principal does not exist', async () => {
    mockSelectOnce([]);
    await expect(migrateHumanKeyToServicePrincipal('key-1', PRINCIPAL_ID, ACTOR_ID)).rejects.toThrow(
      ServicePrincipalNotFoundError,
    );
  });

  it('throws ApiKeyNotFoundError when the key does not exist', async () => {
    mockSelectOnce([{ id: PRINCIPAL_ID, orgId: ORG_ID, scopes: ['ai:read'] }]);
    mockSelectOnce([]);
    await expect(migrateHumanKeyToServicePrincipal('key-1', PRINCIPAL_ID, ACTOR_ID)).rejects.toThrow(
      ApiKeyNotFoundError,
    );
  });

  it('refuses to migrate a key belonging to a different org than the principal', async () => {
    mockSelectOnce([{ id: PRINCIPAL_ID, orgId: ORG_ID, scopes: ['ai:read'] }]);
    mockSelectOnce([{ id: 'key-1', orgId: 'org-other', principalType: 'human', scopes: ['ai:read'] }]);
    await expect(migrateHumanKeyToServicePrincipal('key-1', PRINCIPAL_ID, ACTOR_ID)).rejects.toThrow(
      /different organization/,
    );
  });

  // This is THE ONLY mutation that flips principal_type human -> service.
  // Route-level org-admin gating (403 for non-admin) is covered in
  // routes/servicePrincipals.test.ts.
  it('re-points the key to the principal, clamping scopes to the intersection', async () => {
    mockSelectOnce([{ id: PRINCIPAL_ID, orgId: ORG_ID, scopes: ['ai:read'] }]);
    mockSelectOnce([
      { id: 'key-1', orgId: ORG_ID, name: 'Old human key', principalType: 'human', scopes: ['ai:read', 'ai:execute_admin'] },
    ]);
    const updateWhere = mockUpdateOnce([
      { id: 'key-1', orgId: ORG_ID, name: 'Old human key', principalType: 'service', principalId: PRINCIPAL_ID, scopes: ['ai:read'] },
    ]);

    const result = await migrateHumanKeyToServicePrincipal('key-1', PRINCIPAL_ID, ACTOR_ID);

    expect(result.principalType).toBe('service');
    expect(result.principalId).toBe(PRINCIPAL_ID);
    expect(result.scopes).toEqual(['ai:read']);
    expect(updateWhere).toHaveBeenCalled();
    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'service_principal.migrate_key',
        details: expect.objectContaining({ previousPrincipalType: 'human', clampedScopes: ['ai:read'] }),
      }),
    );
  });
});
