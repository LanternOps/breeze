import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool Catalog W05 (#5220) Task A6 / Decision 5 — the execution org of a
 * webhook delivery. The SQL boundary is a fake that records each query's
 * bound values; the real-DB proof (another partner's link or org uuid, a
 * suspended or soft-deleted org, through the real ingestFlowWebhook) is the
 * "webhook org resolution through the real ingress" describe in
 * apps/api/src/__tests__/integration/flowWebhooksRls.integration.test.ts.
 */

const { selects, calls } = vi.hoisted(() => ({ selects: [] as unknown[][], calls: [] as unknown[] }));

vi.mock('../../../db', () => {
  const chain = (): unknown => {
    const rec: unknown[] = [];
    calls.push(rec);
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const value = selects.shift() ?? [];
          return (res: (v: unknown) => void) => Promise.resolve(value).then(res);
        }
        return (...args: unknown[]) => { rec.push(...args); return proxy; };
      },
    });
    return proxy;
  };
  return {
    db: { select: () => chain() },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    getCurrentDbAccessContext: () => undefined,
  };
});

import { resolveWebhookOrg } from './orgResolver';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '11111111-1111-4111-8111-222222222222';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const partnerFlow = { orgId: null, partnerId: PARTNER };
const orgFlow = { orgId: ORG, partnerId: PARTNER };

/** Every bound value in the recorded where clauses. */
function boundValues(): unknown[] {
  const out: unknown[] = [];
  const seen = new WeakSet<object>();
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object' || seen.has(v as object)) return;
    seen.add(v as object);
    if ((v as { constructor?: { name?: string } }).constructor?.name === 'Param') { out.push((v as { value: unknown }).value); return; }
    for (const child of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) walk(child);
  };
  walk(calls);
  return out;
}

beforeEach(() => {
  selects.length = 0;
  calls.length = 0;
});

describe('resolveWebhookOrg — partner-wide flows', () => {
  it('external id maps to its org', async () => {
    selects.push([{ orgId: ORG }]);
    const r = await resolveWebhookOrg(partnerFlow, { path: 'body.customer.id', system: 'halo' }, { customer: { id: 'C-77' } });
    expect(r).toEqual({ ok: true, orgId: ORG, value: 'C-77' });
    // The partner, the system and the external id are all predicates.
    expect(boundValues()).toEqual(expect.arrayContaining([PARTNER, 'halo', 'C-77']));
  });

  it('a numeric value is matched as its string form', async () => {
    selects.push([{ orgId: ORG }]);
    expect(await resolveWebhookOrg(partnerFlow, { path: 'body.n', system: 'halo' }, { n: 42 })).toEqual({ ok: true, orgId: ORG, value: '42' });
    expect(boundValues()).toContain('42');
  });

  it('external id of another partner is org_unresolved', async () => {
    selects.push([]); // the partner predicate matches no link
    expect(await resolveWebhookOrg(partnerFlow, { path: 'body.id', system: 'halo' }, { id: 'C-1' })).toEqual({ ok: false, value: 'C-1' });
  });

  it('suspended org is org_unresolved', async () => {
    selects.push([]); // the live-org predicate excludes it
    expect(await resolveWebhookOrg(partnerFlow, { path: 'body.id', system: 'halo' }, { id: 'C-1' })).toEqual({ ok: false, value: 'C-1' });
  });

  it('breeze_org_id of another partner is org_unresolved', async () => {
    selects.push([]);
    expect(await resolveWebhookOrg(partnerFlow, { path: 'body.org', kind: 'breeze_org_id' }, { org: OTHER_ORG })).toEqual({ ok: false, value: OTHER_ORG });
    expect(boundValues()).toEqual(expect.arrayContaining([OTHER_ORG, PARTNER]));
  });

  it('breeze_org_id of its partner resolves', async () => {
    selects.push([{ orgId: ORG }]);
    expect(await resolveWebhookOrg(partnerFlow, { path: 'body.org', kind: 'breeze_org_id' }, { org: ORG })).toEqual({ ok: true, orgId: ORG, value: ORG });
  });

  it('a breeze_org_id that is not a uuid never reaches the database', async () => {
    expect(await resolveWebhookOrg(partnerFlow, { path: 'body.org', kind: 'breeze_org_id' }, { org: 'acme' })).toEqual({ ok: false, value: 'acme' });
    expect(calls).toHaveLength(0);
  });

  it('inherited property path never resolves', async () => {
    const body = JSON.parse('{"a":{}}') as Record<string, unknown>;
    expect(await resolveWebhookOrg(partnerFlow, { path: 'body.__proto__.x', system: 'halo' }, body)).toEqual({ ok: false, value: null });
    expect(await resolveWebhookOrg(partnerFlow, { path: 'body.a.toString', system: 'halo' }, body)).toEqual({ ok: false, value: null });
    // Even an OWN "__proto__" key (JSON.parse defines one) is never walked.
    const own = JSON.parse('{"__proto__":{"x":"C-1"}}') as Record<string, unknown>;
    expect(await resolveWebhookOrg(partnerFlow, { path: 'body.__proto__.x', system: 'halo' }, own)).toEqual({ ok: false, value: null });
    expect(calls).toHaveLength(0);
  });

  it('257-char value is org_unresolved', async () => {
    const r = await resolveWebhookOrg(partnerFlow, { path: 'body.id', system: 'halo' }, { id: 'x'.repeat(257) });
    expect(r).toEqual({ ok: false, value: null });
    expect(calls).toHaveLength(0);
  });

  it('a non-scalar, empty or missing value is org_unresolved', async () => {
    for (const body of [{ id: { a: 1 } }, { id: ['C-1'] }, { id: true }, { id: null }, { id: '' }, {}]) {
      expect(await resolveWebhookOrg(partnerFlow, { path: 'body.id', system: 'halo' }, body as Record<string, unknown>)).toEqual({ ok: false, value: null });
    }
    expect(calls).toHaveLength(0);
  });

  it('a partner-wide flow without a resolver never resolves', async () => {
    expect(await resolveWebhookOrg(partnerFlow, undefined, { id: 'C-1' })).toEqual({ ok: false, value: null });
  });
});

describe('resolveWebhookOrg — org flows', () => {
  it('an org flow runs in its own live org', async () => {
    selects.push([{ orgId: ORG }]);
    expect(await resolveWebhookOrg(orgFlow, undefined, { anything: 1 })).toEqual({ ok: true, orgId: ORG, value: null });
    expect(boundValues()).toEqual(expect.arrayContaining([ORG, PARTNER]));
  });

  it('an org flow whose org is no longer live is unresolved', async () => {
    selects.push([]);
    expect(await resolveWebhookOrg(orgFlow, undefined, {})).toEqual({ ok: false, value: null });
  });

  it('an org flow carrying a resolver fails closed', async () => {
    expect(await resolveWebhookOrg(orgFlow, { path: 'body.id', system: 'halo' }, { id: 'C-1' })).toEqual({ ok: false, value: null });
    expect(calls).toHaveLength(0);
  });
});
