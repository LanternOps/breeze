/**
 * #5611 — the two SEC-150 follow-ups that live in this module.
 *
 * 1. `assertNoPendingRevocation` (the producer gate) must elect system scope the
 *    same way every other entry point here does: `runOutsideDbContext` FIRST,
 *    then `withSystemDbAccessContext`. A bare `withSystemDbAccessContext` inside
 *    a request short-circuits to the REQUEST's scope, which is harmless while the
 *    read is filtered by the invoice's own org but would silently leak the moment
 *    the read widens (a partner-axis join, a sibling-invoice check).
 * 2. `abandonInvoiceSessionRevocation` is the single audit writer for an abandon
 *    — the route no longer writes its own row — so it must write exactly one row
 *    per call, carrying the caller's request snapshot, even when nothing was
 *    left to abandon (the operator's decision is the auditable event).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  results: [] as unknown[][],
  order: [] as string[],
  writeAuditEventAsync: vi.fn(async () => undefined),
  mode: 'enforce' as 'enforce' | 'observe',
}));

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit', 'for', 'update', 'set', 'returning']) {
      chain[m] = vi.fn(() => chain);
    }
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(h.results.shift() ?? []).then(resolve);
    return chain;
  };
  return {
    db: makeChain(),
    runOutsideDbContext: <T>(fn: () => T): T => { h.order.push('outside'); return fn(); },
    withSystemDbAccessContext: <T>(fn: () => Promise<T>): Promise<T> => { h.order.push('system'); return fn(); },
  };
});
vi.mock('../config/env', () => ({ stripeSessionRevocationMode: () => h.mode }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./secretCrypto', () => ({ decryptSecret: vi.fn() }));
vi.mock('./stripeCredentialArchive', () => ({
  findLatestArchivedCredentialForAccount: vi.fn(),
  getLiveConnectionForRevocation: vi.fn(),
  getSupersededStripeCredential: vi.fn(),
  StripeCredentialUnavailableError: class extends Error {},
}));
vi.mock('./auditEvents', () => ({
  requestLikeFromSnapshot: (s: { ip?: string; userAgent?: string }) => ({ snapshot: s }),
  writeAuditEventAsync: h.writeAuditEventAsync,
}));

import { assertNoPendingRevocation, abandonInvoiceSessionRevocation } from './stripeSessionRevocation';

beforeEach(() => {
  h.results.length = 0;
  h.order.length = 0;
  h.mode = 'enforce';
  h.writeAuditEventAsync.mockClear();
});

describe('assertNoPendingRevocation — producer gate scope (#5611 item 1)', () => {
  it('escapes the ambient context BEFORE electing system scope', async () => {
    h.results.push([]);
    await assertNoPendingRevocation('inv-1');
    expect(h.order).toEqual(['outside', 'system']);
  });

  it('still refuses (409 STRIPE_REVOCATION_PENDING) when a revocation is in flight', async () => {
    h.results.push([{ id: 'map-1' }]);
    await expect(assertNoPendingRevocation('inv-1'))
      .rejects.toMatchObject({ status: 409, code: 'STRIPE_REVOCATION_PENDING' });
  });

  it('observe mode warns and lets the producer through', async () => {
    h.mode = 'observe';
    h.results.push([{ id: 'map-1' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(assertNoPendingRevocation('inv-1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('abandonInvoiceSessionRevocation — single audit writer (#5611 item 3)', () => {
  it('writes exactly one audit row carrying the request snapshot', async () => {
    h.results.push([{ id: 'map-1', orgId: 'org-1' }, { id: 'map-2', orgId: 'org-1' }]);
    const result = await abandonInvoiceSessionRevocation({
      invoiceId: 'inv-1', reason: 'Stripe account closed', actorUserId: 'u1',
      request: { ip: '203.0.113.9', userAgent: 'ua/1' },
    });
    expect(result).toEqual({ abandoned: 2, orgId: 'org-1' });
    expect(h.writeAuditEventAsync).toHaveBeenCalledTimes(1);
    expect(h.writeAuditEventAsync).toHaveBeenCalledWith(
      { snapshot: { ip: '203.0.113.9', userAgent: 'ua/1' } },
      expect.objectContaining({
        action: 'invoice.stripe_session_abandoned',
        orgId: 'org-1',
        resourceId: 'inv-1',
        actorType: 'user',
        actorId: 'u1',
        details: { reason: 'Stripe account closed', sessionCount: 2 },
      }),
    );
  });

  it('audits the operator decision even when nothing was left to abandon', async () => {
    h.results.push([]);
    h.results.push([{ orgId: 'org-1' }]); // invoice org lookup for the audit row
    const result = await abandonInvoiceSessionRevocation({
      invoiceId: 'inv-1', reason: 'nothing left but recording the decision', actorUserId: 'u1',
    });
    expect(result).toEqual({ abandoned: 0, orgId: 'org-1' });
    expect(h.writeAuditEventAsync).toHaveBeenCalledTimes(1);
    expect(h.writeAuditEventAsync).toHaveBeenCalledWith(
      { snapshot: {} },
      expect.objectContaining({ orgId: 'org-1', details: { reason: 'nothing left but recording the decision', sessionCount: 0 } }),
    );
  });
});
