import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool Catalog W05 (#5220) Task A6 — the delivery log helpers. Branch logic
 * over a fake SQL boundary; the RLS reach (an org token sees only its org's
 * rows, never a partner-level one) is proven on a real database in
 * flowWebhooksRls.integration.test.ts.
 */

const h = vi.hoisted(() => ({
  results: [] as unknown[][],
  calls: [] as Array<{ kind: string; ops: Array<{ op: string; args: unknown[] }> }>,
  scope: undefined as string | undefined,
  systemEntered: 0,
}));

vi.mock('../../../db', () => {
  const chain = (kind: string) => {
    const rec = { kind, ops: [] as Array<{ op: string; args: unknown[] }> };
    h.calls.push(rec);
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const value = h.results.shift() ?? [];
          return (res: (v: unknown) => void) => Promise.resolve(value).then(res);
        }
        return (...args: unknown[]) => { rec.ops.push({ op: String(prop), args }); return proxy; };
      },
    });
    return proxy;
  };
  return {
    db: { select: () => chain('select'), insert: () => chain('insert'), update: () => chain('update'), execute: async () => [] },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => unknown) => { h.systemEntered += 1; const prev = h.scope; h.scope = 'system'; try { return await fn(); } finally { h.scope = prev; } },
    getCurrentDbAccessContext: () => (h.scope ? { scope: h.scope } : undefined),
  };
});

import { findAcceptedDelivery, insertAcceptedDelivery, listWebhookDeliveries, recordNonAcceptedDelivery } from './deliveries';

const FLOW = '33333333-3333-4333-8333-333333333333';
const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const facts = {
  flowId: FLOW, partnerId: PARTNER, authMode: 'hmac' as const, deliveryId: 'evt_1', signatureDigest: 'a'.repeat(64),
  bodySha256: 'b'.repeat(64), bodyBytes: 10, receivedAt: new Date('2027-03-01T10:00:00Z'),
};

beforeEach(() => {
  h.results.length = 0;
  h.calls.length = 0;
  h.scope = undefined;
  h.systemEntered = 0;
});

describe('flow webhook delivery log', () => {
  it('org caller sees only its org\'s rows: the list runs in the caller context, never system', async () => {
    h.scope = 'organization';
    h.results.push([{
      id: 'd1', receivedAt: new Date('2027-03-01T10:00:00Z'), status: 'accepted', refusalCode: null, orgId: ORG, runId: 'r1',
      deliveryId: 'evt_1', authMode: 'hmac', bodyBytes: 10, attempts: 2, resolverValue: null, signatureDigest: 'x', bodySha256: 'y',
    }]);
    const rows = await listWebhookDeliveries({} as never, FLOW, { limit: 500 });
    expect(h.systemEntered).toBe(0);
    expect(rows).toEqual([{
      id: 'd1', receivedAt: '2027-03-01T10:00:00.000Z', status: 'accepted', refusalCode: null, orgId: ORG, runId: 'r1',
      deliveryId: 'evt_1', authMode: 'hmac', bodyBytes: 10, attempts: 2, resolverValue: null,
    }]);
    // Never the digests (a dto field list, not the row).
    expect(Object.keys(rows[0]!)).not.toContain('signatureDigest');
    // The limit is capped at 100.
    expect(h.calls[0]!.ops.find((o) => o.op === 'limit')!.args[0]).toBe(100);
  });

  it('a replay lookup with neither key never queries', async () => {
    expect(await findAcceptedDelivery({ flowId: FLOW, signatureDigest: null, deliveryId: null })).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  it('the accepted row refuses to be written outside the run transaction', async () => {
    await expect(insertAcceptedDelivery({ ...facts, orgId: ORG, runId: 'r1', resolverValue: null })).rejects.toThrow(/run-creation system transaction/);
    h.scope = 'system';
    h.results.push([{ id: 'd9' }]);
    await expect(insertAcceptedDelivery({ ...facts, orgId: ORG, runId: 'r1', resolverValue: null })).resolves.toBe('d9');
  });

  it('a repeat of a refused delivery within a minute coalesces instead of adding a row', async () => {
    h.results.push([{ id: 'd-existing' }]);
    expect(await recordNonAcceptedDelivery({ ...facts, orgId: ORG, status: 'refused', refusalCode: 'flow_monthly_cap_reached', resolverValue: null })).toBe('d-existing');
    expect(h.calls.map((c) => c.kind)).toEqual(['update']);
    h.calls.length = 0;
    h.results.push([], [{ id: 'd-new' }]);
    expect(await recordNonAcceptedDelivery({ ...facts, orgId: null, status: 'org_unresolved', refusalCode: null, resolverValue: 'C-1' })).toBe('d-new');
    expect(h.calls.map((c) => c.kind)).toEqual(['update', 'insert']);
    const values = h.calls[1]!.ops.find((o) => o.op === 'values')!.args[0] as Record<string, unknown>;
    expect(values).toMatchObject({ status: 'org_unresolved', orgId: null, partnerId: PARTNER, resolverValue: 'C-1' });
    expect(values).not.toHaveProperty('runId');
  });
});
