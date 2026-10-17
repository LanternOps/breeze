import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const dbm = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('../../../db', () => ({ db: dbm }));

import { findLiveToken, hashAccessToken, mintAccessToken } from './tokens';

/** Thenable query-builder stand-in: every builder method returns itself; awaiting it yields `result`. */
function chain(result: unknown): unknown {
  const proxy: unknown = new Proxy(function () { /* target */ }, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
      return () => proxy;
    },
  });
  return proxy;
}

const NOW = new Date('2026-10-17T12:00:00.000Z');
const RAW = 'A'.repeat(24) + 'b_-9'.repeat(6);

function fakeTx() {
  const log: Array<{ op: string; values?: Record<string, unknown> }> = [];
  const tx = {
    update: () => ({ set: (v: Record<string, unknown>) => { log.push({ op: 'update', values: v }); return chain(undefined); } }),
    insert: () => ({ values: (v: Record<string, unknown>) => { log.push({ op: 'insert', values: v }); return chain(undefined); } }),
  };
  return { tx, log };
}

beforeEach(() => dbm.select.mockReset());

describe('hashAccessToken / mintAccessToken', () => {
  it('mints a 48-char raw token and stores only its 64-hex sha256', async () => {
    const { tx, log } = fakeTx();
    const raw = await mintAccessToken(tx as never, { requestId: 'r1', orgId: 'o1', purpose: 'verify_email', ttlMs: 3600_000, now: NOW });
    expect(raw).toMatch(/^[A-Za-z0-9_-]{48}$/);
    const hash = hashAccessToken(raw);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(raw, 'utf8').digest('hex'));
    const insert = log.find((e) => e.op === 'insert')!;
    expect(insert.values).toMatchObject({ requestId: 'r1', orgId: 'o1', purpose: 'verify_email', tokenHash: hash });
    expect(JSON.stringify(log)).not.toContain(raw);
    expect((insert.values!.expiresAt as Date).getTime()).toBe(NOW.getTime() + 3600_000);
  });

  it('minting a second token of the same purpose revokes the first (revoke runs before the insert)', async () => {
    const { tx, log } = fakeTx();
    await mintAccessToken(tx as never, { requestId: 'r1', orgId: 'o1', purpose: 'verify_email', ttlMs: 1000, now: NOW });
    await mintAccessToken(tx as never, { requestId: 'r1', orgId: 'o1', purpose: 'verify_email', ttlMs: 1000, now: NOW });
    expect(log.map((e) => e.op)).toEqual(['update', 'insert', 'update', 'insert']);
    expect(log[2]!.values).toEqual({ revokedAt: NOW });
  });

  it('two mints never return the same raw token', async () => {
    const { tx } = fakeTx();
    const a = await mintAccessToken(tx as never, { requestId: 'r1', orgId: 'o1', purpose: 'download', ttlMs: 1000, now: NOW });
    const b = await mintAccessToken(tx as never, { requestId: 'r1', orgId: 'o1', purpose: 'download', ttlMs: 1000, now: NOW });
    expect(a).not.toBe(b);
  });
});

describe('findLiveToken', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 't1', requestId: 'r1', orgId: 'o1', purpose: 'verify_email', tokenHash: hashAccessToken(RAW),
    expiresAt: new Date(NOW.getTime() + 60_000), consumedAt: null, revokedAt: null, createdAt: NOW, ...over,
  });

  it('returns the live row', async () => {
    dbm.select.mockReturnValueOnce(chain([row()]));
    await expect(findLiveToken(RAW, 'verify_email', NOW)).resolves.toMatchObject({ id: 't1' });
  });
  it('unknown → null', async () => {
    dbm.select.mockReturnValueOnce(chain([]));
    await expect(findLiveToken(RAW, 'verify_email', NOW)).resolves.toBeNull();
  });
  it('expired → null (expires_at exactly now counts as expired)', async () => {
    dbm.select.mockReturnValueOnce(chain([row({ expiresAt: NOW })]));
    await expect(findLiveToken(RAW, 'verify_email', NOW)).resolves.toBeNull();
  });
  it('revoked → null', async () => {
    dbm.select.mockReturnValueOnce(chain([row({ revokedAt: NOW })]));
    await expect(findLiveToken(RAW, 'verify_email', NOW)).resolves.toBeNull();
  });
  it('consumed verify token → null', async () => {
    dbm.select.mockReturnValueOnce(chain([row({ consumedAt: NOW })]));
    await expect(findLiveToken(RAW, 'verify_email', NOW)).resolves.toBeNull();
  });
  it('wrong purpose → null', async () => {
    dbm.select.mockReturnValueOnce(chain([row({ purpose: 'download' })]));
    await expect(findLiveToken(RAW, 'verify_email', NOW)).resolves.toBeNull();
  });
  it('a download token stays live across uses (consumed_at is not a download concept)', async () => {
    dbm.select.mockReturnValueOnce(chain([row({ purpose: 'download', consumedAt: NOW })]));
    await expect(findLiveToken(RAW, 'download', NOW)).resolves.toMatchObject({ id: 't1' });
  });
  it('a malformed token never reaches the database', async () => {
    await expect(findLiveToken('short', 'verify_email', NOW)).resolves.toBeNull();
    await expect(findLiveToken('x'.repeat(47) + '!', 'verify_email', NOW)).resolves.toBeNull();
    expect(dbm.select).not.toHaveBeenCalled();
  });
});
