import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rows: [] as unknown[][], updates: [] as unknown[], audit: vi.fn() }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'from', 'innerJoin', 'where', 'limit', 'orderBy', 'update']) chain[name] = vi.fn(() => chain);
  chain.set = (value: unknown) => { h.updates.push(value); return chain; };
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(h.rows.shift() ?? []).then(resolve);
  return { db: chain };
});
vi.mock('./auditEvents', () => ({ writeAuditEventAsync: h.audit, requestLikeFromSnapshot: () => ({}) }));
import { eraseExpiredStripeCredentials } from './stripeCredentialArchive';
const now = new Date('2026-10-01T00:00:00Z');
const expired = { id: 'credential', partnerId: 'partner', stripeAccountId: 'acct_original', generation: 1, eraseHardCapAt: new Date('2025-01-01T00:00:00Z') };
beforeEach(() => { vi.clearAllMocks(); h.rows.length = 0; h.updates.length = 0; });
describe('credential retention for active collection', () => {
  it('an active attempt overrides even the historical 400-day erase cap', async () => {
    h.rows.push([expired], [{ id: 'active-attempt' }]);
    expect(await eraseExpiredStripeCredentials(now)).toBe(0);
    expect(h.updates).toHaveLength(0);
  });
  it('erases after the hard cap once no active attempt remains', async () => {
    h.rows.push([expired], [], []);
    expect(await eraseExpiredStripeCredentials(now)).toBe(1);
    expect(h.updates).toContainEqual({ apiKey: null, erasedAt: now, updatedAt: now });
  });
});
