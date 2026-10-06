import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Tx } from './types';
const { encrypt } = vi.hoisted(() => ({ encrypt: vi.fn((v: string, o: { aad: string }) => `sealed:${o.aad}:${v}`) }));
vi.mock('../secretCrypto', () => ({ encryptSecret: encrypt }));
vi.mock('../portalUrl', () => ({ portalBase: () => 'https://portal.example.test/portal' }));
import { mintBillingLinkToken, resolveBillingLinkToken, revokeBillingLinkTokens, buildBillingLinkUrl, inspectBillingLinkToken } from './linkTokens';

function fakeDb(rows: unknown[] = []) {
  const writes: unknown[] = [];
  const chain: any = {};
  for (const name of ['from', 'where', 'limit', 'returning']) chain[name] = vi.fn(() => chain);
  chain.then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
  const api = {
    select: vi.fn(() => chain),
    insert: vi.fn(() => ({ values: vi.fn(async (v: unknown) => { writes.push(v); }) })),
    update: vi.fn(() => ({ set: vi.fn((v: unknown) => { writes.push(v); return chain; }) })),
  };
  return { tx: api as unknown as Tx, api, writes };
}
beforeEach(() => vi.clearAllMocks());
describe('billing links', () => {
  it('stores 32 random bytes as a hash and a row-bound ciphertext', async () => {
    const f = fakeDb();
    const input = { orgId: '11111111-1111-4111-8111-111111111111', purpose: 'enroll' as const, ttlDays: 7 };
    const a = await mintBillingLinkToken(f.tx, input);
    const b = await mintBillingLinkToken(f.tx, input);
    expect(Buffer.from(a.token, 'base64url')).toHaveLength(32);
    expect(a.token).not.toBe(b.token);
    expect(f.writes[0]).toMatchObject({ id: a.id, orgId: input.orgId,
      tokenHash: createHash('sha256').update(a.token).digest('hex'),
      tokenCt: `sealed:billing_link_tokens.token_ct:${a.id}:${a.token}` });
    expect(encrypt).toHaveBeenCalledWith(a.token, { aad: `billing_link_tokens.token_ct:${a.id}` });
  });
  it.each([0, -1, Infinity, NaN, 1.5])('rejects invalid TTL %s without writing', async ttlDays => {
    const f = fakeDb();
    await expect(mintBillingLinkToken(f.tx, { orgId: crypto.randomUUID(), purpose: 'enroll', ttlDays })).rejects.toThrow('ttlDays');
    expect(f.api.insert).not.toHaveBeenCalled();
  });
  it('rejects malformed token before querying', async () => {
    const f = fakeDb();
    expect(await resolveBillingLinkToken(f.tx, 'bad token', 'enroll')).toBeNull();
    expect(f.api.select).not.toHaveBeenCalled();
  });
  it.each([
    { expiresAt: new Date(0) }, { revokedAt: new Date() },
    { consumedAt: new Date() }, { purpose: 'confirm_payment' },
  ])('refuses expired/revoked/consumed/wrong-purpose rows: %j', async changes => {
    const row = { purpose: 'enroll', expiresAt: new Date(Date.now() + 100000), revokedAt: null, consumedAt: null, ...changes };
    expect(await resolveBillingLinkToken(fakeDb([row]).tx, 'A'.repeat(43), 'enroll')).toBeNull();
  });
  it('GET-style resolution performs no mutation, including repeated reads', async () => {
    const row = { purpose: 'enroll', expiresAt: new Date(Date.now() + 100000), revokedAt: null, consumedAt: null };
    const f = fakeDb([row]);
    expect(await resolveBillingLinkToken(f.tx, 'A'.repeat(43), 'enroll')).toEqual(row);
    expect(await resolveBillingLinkToken(f.tx, 'A'.repeat(43), 'enroll')).toEqual(row);
    expect(f.writes).toEqual([]);
  });
  it('returns zero on unknown token and counts revoked rows', async () => {
    expect(await resolveBillingLinkToken(fakeDb().tx, 'A'.repeat(43), 'enroll')).toBeNull();
    expect(await revokeBillingLinkTokens(fakeDb([{ id: '1' }, { id: '2' }]).tx,
      { orgId: crypto.randomUUID(), purpose: 'enroll' })).toBe(2);
  });
  it.each([
    ['enroll', ''], ['skip_invoice', '/skip'], ['stop_autopay', '/stop'], ['confirm_payment', '/confirm'],
  ] as const)('builds %s on the portal base', (purpose, suffix) => {
    expect(buildBillingLinkUrl(purpose, 'a/b')).toBe(`https://portal.example.test/portal/autopay/a%2Fb${suffix}`);
  });
});

describe('inspectBillingLinkToken says why a matched link is unusable', () => {
  const live = { purpose: 'enroll', expiresAt: new Date(Date.now() + 100000), revokedAt: null, consumedAt: null };
  it.each([
    ['ok', live, null],
    ['expired', { ...live, expiresAt: new Date(0) }, 'expired'],
    ['revoked', { ...live, revokedAt: new Date() }, 'revoked'],
    ['consumed', { ...live, consumedAt: new Date() }, 'consumed'],
  ] as const)('%s', async (_label, row, failure) => {
    expect(await inspectBillingLinkToken(fakeDb([row]).tx, 'A'.repeat(43), 'enroll')).toEqual({ row, failure });
  });
  it('a consumed stop or skip link is still usable (reusable by design)', async () => {
    const row = { ...live, purpose: 'stop_autopay', consumedAt: new Date() };
    expect(await inspectBillingLinkToken(fakeDb([row]).tx, 'A'.repeat(43), 'stop_autopay')).toEqual({ row, failure: null });
  });
  it('an unknown, malformed or wrong-purpose token matches nothing', async () => {
    expect(await inspectBillingLinkToken(fakeDb().tx, 'A'.repeat(43), 'enroll')).toEqual({ row: null, failure: 'invalid' });
    expect(await inspectBillingLinkToken(fakeDb([live]).tx, 'bad token', 'enroll')).toEqual({ row: null, failure: 'invalid' });
    expect(await inspectBillingLinkToken(fakeDb([{ ...live, purpose: 'skip_invoice' }]).tx, 'A'.repeat(43), 'enroll'))
      .toEqual({ row: null, failure: 'invalid' });
  });
});
