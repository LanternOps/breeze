import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { encryptionRoutes } from './encryption';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const KEY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_KEY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

vi.mock('../../services', () => ({}));

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
const transactionMock = vi.fn();
let authState = {
  user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
  scope: 'organization' as const,
  partnerId: null,
  orgId: ORG_ID,
  token: { sub: 'user-123' },
};

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    transaction: (...args: unknown[]) => transactionMock(...(args as [])),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../../db/schema', () => ({
  storageEncryptionKeys: {
    id: 'storage_encryption_keys.id',
    orgId: 'storage_encryption_keys.org_id',
    name: 'storage_encryption_keys.name',
    keyType: 'storage_encryption_keys.key_type',
    keyHash: 'storage_encryption_keys.key_hash',
    isActive: 'storage_encryption_keys.is_active',
    publicKeyPem: 'storage_encryption_keys.public_key_pem',
    createdAt: 'storage_encryption_keys.created_at',
    rotatedAt: 'storage_encryption_keys.rotated_at',
    expiresAt: 'storage_encryption_keys.expires_at',
  },
}));

const writeRouteAuditMock = vi.fn();

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => writeRouteAuditMock(...(args as [])),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState);
    return next();
  }),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { authMiddleware } from '../../middleware/auth';

function makeKey(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    orgId: ORG_ID,
    name: 'Primary key',
    keyType: 'aes_256',
    keyHash: '1234567890abcdef1234567890abcdef',
    isActive: true,
    publicKeyPem: '-----BEGIN PUBLIC KEY-----',
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    rotatedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

describe('encryption routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authState = {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
    };
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
      return next();
    });
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/backup/encryption', encryptionRoutes);
  });

  it('returns an empty key list', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/backup/encryption/keys', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  it('creates an encryption key', async () => {
    insertMock.mockReturnValueOnce(chainMock([makeKey()]));

    const res = await app.request('/backup/encryption/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        name: 'Primary key',
        keyType: 'aes_256',
        keyHash: '1234567890abcdef1234567890abcdef',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe(KEY_ID);
    expect(body.publicKeyPem).toBeUndefined();
  });

  it('deactivates an encryption key', async () => {
    updateMock.mockReturnValueOnce(chainMock([makeKey({ isActive: false })]));

    const res = await app.request(`/backup/encryption/keys/${KEY_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deactivated: true });
  });

  it('rotates an encryption key', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeKey()]));
    transactionMock.mockImplementationOnce(async (fn: (tx: any) => Promise<any>) =>
      fn({
        update: (...args: unknown[]) => updateMock(...(args as [])),
        insert: (...args: unknown[]) => insertMock(...(args as [])),
      })
    );
    updateMock.mockReturnValueOnce(chainMock([]));
    insertMock.mockReturnValueOnce(chainMock([makeKey({
      id: NEW_KEY_ID,
      name: 'Primary key (rotated)',
      keyHash: 'fedcba0987654321fedcba0987654321',
    })]));

    const res = await app.request(`/backup/encryption/keys/${KEY_ID}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        newKeyHash: 'fedcba0987654321fedcba0987654321',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.previousKeyId).toBe(KEY_ID);
    expect(body.newKey.id).toBe(NEW_KEY_ID);
  });

  it('should get single key by id', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeKey()]));

    const res = await app.request(`/backup/encryption/keys/${KEY_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(KEY_ID);
    expect(body.name).toBe('Primary key');
    expect(body.keyType).toBe('aes_256');
    expect(body.isActive).toBe(true);
    // Verify private key material is NOT in the response
    expect(body.publicKeyPem).toBeUndefined();
    expect(body.encryptedPrivateKey).toBeUndefined();
  });

  it('should reject rotating inactive key', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeKey({ isActive: false })]));

    const res = await app.request(`/backup/encryption/keys/${KEY_ID}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        newKeyHash: 'fedcba0987654321fedcba0987654321',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Cannot rotate an inactive key');
  });

  it('enforces multi-tenant isolation', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request(`/backup/encryption/keys/${KEY_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });
});
