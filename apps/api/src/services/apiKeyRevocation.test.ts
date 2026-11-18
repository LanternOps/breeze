import { describe, it, expect, vi, beforeEach } from 'vitest';

const KEY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACTOR_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
}));
vi.mock('../db/schema', () => ({
  apiKeys: {
    id: { col: 'api_keys.id' },
    orgId: { col: 'api_keys.org_id' },
    name: { col: 'api_keys.name' },
    keyPrefix: { col: 'api_keys.key_prefix' },
    status: { col: 'api_keys.status' },
    updatedAt: { col: 'api_keys.updated_at' },
  },
}));
vi.mock('./auditService', () => ({ createAuditLogAsync: vi.fn() }));

import { db } from '../db';
import { createAuditLogAsync } from './auditService';
import { revokeApiKey } from './apiKeyRevocation';

const selectReturning = (rows: unknown[]) =>
  ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) }) as any;
const updateReturning = (rows: unknown[]) =>
  ({ set: () => ({ where: () => ({ returning: () => Promise.resolve(rows) }) }) }) as any;

const row = { id: KEY_ID, orgId: ORG_ID, name: 'Primary Key', keyPrefix: 'brz_abc12345', status: 'active' };
const revokedRow = { id: KEY_ID, name: 'Primary Key', keyPrefix: 'brz_abc12345', status: 'revoked', updatedAt: new Date() };

describe('revokeApiKey', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(createAuditLogAsync).mockReset();
  });

  it('revokes an active key and writes one api_key.revoke audit', async () => {
    vi.mocked(db.select).mockReturnValue(selectReturning([row]));
    vi.mocked(db.update).mockReturnValue(updateReturning([revokedRow]));

    const result = await revokeApiKey(KEY_ID, ACTOR_ID, 'reported suspicious', {
      actorEmail: 'a@example.com',
      ipAddress: '203.0.113.9',
      userAgent: 'vitest',
    });

    expect(result.revoked).toBe(true);
    expect(result.apiKey).toEqual(revokedRow);
    expect(createAuditLogAsync).toHaveBeenCalledTimes(1);
    expect(createAuditLogAsync).toHaveBeenCalledWith({
      orgId: ORG_ID,
      actorId: ACTOR_ID,
      actorEmail: 'a@example.com',
      action: 'api_key.revoke',
      resourceType: 'api_key',
      resourceId: KEY_ID,
      resourceName: 'Primary Key',
      details: { keyPrefix: 'brz_abc12345', previousStatus: 'active' },
      ipAddress: '203.0.113.9',
      userAgent: 'vitest',
      result: 'success',
    });
  });

  it('records the reason in audit details only when the caller opts in', async () => {
    vi.mocked(db.select).mockReturnValue(selectReturning([row]));
    vi.mocked(db.update).mockReturnValue(updateReturning([revokedRow]));
    await revokeApiKey(KEY_ID, ACTOR_ID, 'reported suspicious', { includeReasonInAudit: true });
    const call = vi.mocked(createAuditLogAsync).mock.calls[0]![0];
    expect(call.details).toEqual({
      keyPrefix: 'brz_abc12345',
      previousStatus: 'active',
      reason: 'reported suspicious',
    });
  });

  it('uses a prefetched row without re-selecting', async () => {
    vi.mocked(db.update).mockReturnValue(updateReturning([revokedRow]));
    const result = await revokeApiKey(KEY_ID, ACTOR_ID, 'x', { existing: { orgId: ORG_ID, status: 'active' } });
    expect(result.revoked).toBe(true);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns revoked:false and no audit for an already-revoked key', async () => {
    vi.mocked(db.select).mockReturnValue(selectReturning([{ ...row, status: 'revoked' }]));
    const result = await revokeApiKey(KEY_ID, ACTOR_ID, 'again');
    expect(result).toEqual({ revoked: false });
    expect(db.update).not.toHaveBeenCalled();
    expect(createAuditLogAsync).not.toHaveBeenCalled();
  });

  it('returns revoked:false and no audit when a concurrent revoke wins the race', async () => {
    vi.mocked(db.select).mockReturnValue(selectReturning([row]));
    vi.mocked(db.update).mockReturnValue(updateReturning([]));
    const result = await revokeApiKey(KEY_ID, ACTOR_ID, 'race');
    expect(result).toEqual({ revoked: false });
    expect(createAuditLogAsync).not.toHaveBeenCalled();
  });

  it('returns revoked:false for a missing key', async () => {
    vi.mocked(db.select).mockReturnValue(selectReturning([]));
    const result = await revokeApiKey(KEY_ID, ACTOR_ID, 'gone');
    expect(result).toEqual({ revoked: false });
    expect(db.update).not.toHaveBeenCalled();
    expect(createAuditLogAsync).not.toHaveBeenCalled();
  });
});
