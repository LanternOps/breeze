import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'key-1' }]),
      }),
    }),
  },
}));

vi.mock('../db/schema', () => ({
  apiKeys: { id: 'apiKeys.id' },
}));

import { mintApiKey } from './apiKeys';
import { db } from '../db';

describe('mintApiKey', () => {
  it('returns a brz_-prefixed raw key and a row id', async () => {
    const r = await mintApiKey({
      partnerId: 'p1',
      defaultOrgId: 'o1',
      createdByUserId: 'u1',
      name: 'MCP Provisioning',
      scopes: ['ai:read'],
      source: 'mcp_provisioning',
    });
    expect(r.id).toBe('key-1');
    expect(r.rawKey).toMatch(/^brz_[0-9a-f]{48}$/);
    // brz_ + 48 hex chars = 52 chars total
    expect(r.rawKey.length).toBe(52);
  });

  it('hashes the raw key with sha256 (never stores plaintext) and forwards createdBy', async () => {
    const valuesMock = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'key-2' }]),
    });
    vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as any);

    const r = await mintApiKey({
      partnerId: 'p1',
      defaultOrgId: 'o1',
      createdByUserId: 'u1',
      name: 'MCP Provisioning',
      scopes: ['ai:read', 'ai:write'],
      source: 'mcp_provisioning',
    });

    expect(valuesMock).toHaveBeenCalledTimes(1);
    const args = valuesMock.mock.calls[0]![0];
    expect(args.keyHash).not.toBe(r.rawKey);
    expect(args.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(args.keyPrefix).toBe(r.rawKey.slice(0, 8));
    expect(args.orgId).toBe('o1');
    expect(args.createdBy).toBe('u1');
    expect(args.status).toBe('active');
    expect(args.scopes).toEqual(['ai:read', 'ai:write']);
    expect(args.source).toBe('mcp_provisioning');
  });

  it('persists source="manual" when caller requests manual provenance', async () => {
    const valuesMock = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'key-3' }]),
    });
    vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as any);

    await mintApiKey({
      partnerId: 'p1',
      defaultOrgId: 'o1',
      createdByUserId: 'u1',
      name: 'Manual',
      scopes: ['ai:read'],
      source: 'manual',
    });

    const args = valuesMock.mock.calls[0]![0];
    expect(args.source).toBe('manual');
  });
});
