import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';

/**
 * Tool Catalog W05 (#5220) Task A6 — the webhook ingress, end to end over
 * in-memory stand-ins: the delivery log (accepted rows unique per signature
 * digest and per delivery id, as the partial unique indexes are) and
 * createFlowRun (permanent per-dedupe-key runs; `onCreated` runs inside the
 * "transaction" and a throw rolls the run back). Real verification and
 * secret decryption. The real-DB run of the same path is
 * flowWebhooksRls.integration.test.ts.
 */

const h = vi.hoisted(() => {
  process.env.APP_ENCRYPTION_KEY = 'w5-webhook-ingest-test-key-material-0123456789';
  process.env.APP_ENCRYPTION_KEY_ID = 'w5ingest';
  return {
    flags: { flows: true },
    selects: [] as unknown[][],
    order: [] as string[],
    deliveries: [] as Array<Record<string, any>>,
    runs: new Map<string, string>(),
    createInputs: [] as Array<Record<string, any>>,
    nextCreate: null as null | ((i: Record<string, any>) => Promise<unknown>),
    rate: { allowed: true },
  };
});

vi.mock('../../../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../config/env')>()),
  flowsEnabled: () => h.flags.flows,
  flowWebhookRatePerMinute: () => 120,
}));
vi.mock('../../../db', () => {
  const chain = (): unknown => new Proxy(() => {}, {
    get(_t, prop) {
      if (prop === 'then') {
        h.order.push('db:select');
        const value = h.selects.shift() ?? [];
        return (res: (v: unknown) => void) => Promise.resolve(value).then(res);
      }
      return () => chain();
    },
  });
  return {
    db: { select: () => chain() },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    getCurrentDbAccessContext: () => undefined,
  };
});
vi.mock('../../redis', () => ({ getRedis: () => null }));
vi.mock('../../rate-limit', () => ({
  rateLimiter: vi.fn(async () => {
    h.order.push('rate');
    return { allowed: h.rate.allowed, remaining: 0, resetAt: new Date(Date.now() + 30_000) };
  }),
}));
vi.mock('../../tenantStatus', () => ({
  getActivePartner: vi.fn(async (id: string) => ({ id })),
  getActiveOrgTenant: vi.fn(async (orgId: string) => ({ orgId, partnerId: PARTNER })),
}));
vi.mock('./orgResolver', () => ({ resolveWebhookOrg: vi.fn() }));
vi.mock('../triggerScope', () => ({
  buildTriggerScope: vi.fn(async (i: { kind: string; orgId: string; webhook?: { body: unknown } }) => ({
    kind: i.kind, orgId: i.orgId, firedAt: '2027-03-01T10:00:00.000Z', ...(i.webhook ? { body: i.webhook.body } : {}),
  })),
}));
vi.mock('../runService', () => ({
  createFlowRun: vi.fn(async (i: Record<string, any>) => {
    h.createInputs.push(i);
    if (h.nextCreate) return h.nextCreate(i);
    const existing = h.runs.get(i.dedupeKey);
    if (existing) return { created: false, reason: 'duplicate', runId: existing, preApprovalsHonored: false };
    const runId = `run-${h.runs.size + 1}`;
    const snapshot = h.deliveries.length;
    try {
      await i.onCreated(runId);
    } catch (err) {
      h.deliveries.length = snapshot; // rolled back with the run
      throw err;
    }
    h.runs.set(i.dedupeKey, runId);
    return { created: true, runId, preApprovalsHonored: false };
  }),
}));
vi.mock('./deliveries', () => {
  const unique = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
  const accepted = () => h.deliveries.filter((d) => d.status === 'accepted');
  return {
    findAcceptedDelivery: vi.fn(async (k: { flowId: string; signatureDigest: string | null; deliveryId: string | null }) => {
      h.order.push('dedupe');
      const hit = accepted().find((d) => d.flowId === k.flowId
        && ((k.signatureDigest && d.signatureDigest === k.signatureDigest) || (k.deliveryId && d.deliveryId === k.deliveryId)));
      return hit ? { id: hit.id, runId: hit.runId } : null;
    }),
    bumpAcceptedDelivery: vi.fn(async (id: string) => {
      const d = h.deliveries.find((x) => x.id === id);
      if (d) d.attempts += 1;
    }),
    insertAcceptedDelivery: vi.fn(async (row: Record<string, any>) => {
      if (accepted().some((d) => d.flowId === row.flowId
        && ((row.signatureDigest && d.signatureDigest === row.signatureDigest) || (row.deliveryId && d.deliveryId === row.deliveryId)))) {
        throw unique;
      }
      const id = `d-${h.deliveries.length + 1}`;
      h.deliveries.push({ ...row, id, status: 'accepted', attempts: 1 });
      return id;
    }),
    recordNonAcceptedDelivery: vi.fn(async (row: Record<string, any>) => {
      const id = `d-${h.deliveries.length + 1}`;
      h.deliveries.push({ ...row, id, attempts: 1 });
      return id;
    }),
    markWebhookAuthFailure: vi.fn(async () => {}),
  };
});

import { getActiveOrgTenant, getActivePartner } from '../../tenantStatus';
import { resolveWebhookOrg } from './orgResolver';
import { markWebhookAuthFailure } from './deliveries';
import { encryptFlowWebhookSecret } from './secret';
import { ingestFlowWebhook } from './ingest';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const FLOW = '33333333-3333-4333-8333-333333333333';
const SECRET = 'bwh_' + 's'.repeat(43);
const ROTATED = new Date('2027-03-01T09:00:00.000Z');

const doc = (trigger: Record<string, unknown> = { type: 'webhook', auth: 'hmac' }) => ({
  version: 1, name: 'Inbound', trigger, inputs: [{ name: 'ticket', type: 'string', required: false }],
  steps: [{ id: 's', tool: 'wait', input: { minutes: 1 }, approval: 'default', onFailure: 'stop', timeoutSec: 300 }],
});
function flowRow(over: Record<string, unknown> = {}) {
  return {
    id: FLOW, orgId: ORG, partnerId: null, status: 'enabled', enabledPublicationSeq: 2,
    webhookSecretEncrypted: encryptFlowWebhookSecret(FLOW, SECRET), webhookSecretRotatedAt: ROTATED, ...over,
  };
}
/** The ingress's two reads: the flow, then its live publication. */
function queueFlow(flow: unknown = flowRow(), definition: unknown = doc()) {
  h.selects.push(flow ? [flow] : [], definition ? [{ definition }] : []);
}

const BODY = '{"customer":{"id":"C-77"},"note":"hello"}';
function signed(body = BODY, extra: Record<string, string> = {}, ts = String(Math.floor(Date.now() / 1000))) {
  const sig = `sha256=${createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}`;
  return new Headers({ 'content-type': 'application/json', 'x-breeze-timestamp': ts, 'x-breeze-signature': sig, ...extra });
}
const ingest = (headers: Headers, rawBody = BODY, flowId = FLOW) => ingestFlowWebhook({ flowId, rawBody, headers, receivedAt: new Date() });

beforeEach(() => {
  h.flags.flows = true;
  h.selects.length = 0;
  h.order.length = 0;
  h.deliveries.length = 0;
  h.runs.clear();
  h.createInputs.length = 0;
  h.nextCreate = null;
  h.rate.allowed = true;
  vi.mocked(markWebhookAuthFailure).mockClear();
  vi.mocked(getActivePartner).mockClear().mockImplementation(async (id: string) => ({ id }));
  vi.mocked(getActiveOrgTenant).mockClear().mockImplementation(async (orgId: string) => ({ orgId, partnerId: PARTNER }));
  vi.mocked(resolveWebhookOrg).mockReset().mockImplementation(async (flow) => (flow.orgId ? { ok: true, orgId: flow.orgId, value: null } : { ok: true, orgId: ORG, value: 'C-77' }));
});

describe('ingestFlowWebhook — gates', () => {
  it('flag off is 404', async () => {
    h.flags.flows = false;
    expect(await ingest(signed())).toMatchObject({ http: 404 });
    expect(h.order).toEqual([]);
  });

  it('a non-uuid flow id is 401', async () => {
    expect(await ingest(signed(), BODY, 'nope')).toMatchObject({ http: 401 });
    expect(h.order).toEqual([]);
  });

  it('rate limit is checked before the flow read', async () => {
    h.rate.allowed = false;
    const r = await ingest(signed());
    expect(r).toMatchObject({ http: 429, body: { status: 'refused', code: 'rate_limited' } });
    expect((r as { retryAfterSec: number }).retryAfterSec).toBeGreaterThan(0);
    expect(h.order).toEqual(['rate']);
  });

  it('unknown flow, disabled flow and draft-only webhook trigger all 401', async () => {
    queueFlow(null, null);
    const unknown = await ingest(signed());
    queueFlow(flowRow({ status: 'disabled', enabledPublicationSeq: null }), null);
    const disabled = await ingest(signed());
    // The draft says webhook, but the LIVE publication is a manual flow.
    queueFlow(flowRow(), doc({ type: 'manual' }));
    const draftOnly = await ingest(signed());
    for (const r of [unknown, disabled, draftOnly]) expect(r).toEqual({ http: 401, body: { error: 'Unauthorized' } });
    expect(markWebhookAuthFailure).not.toHaveBeenCalled();
    expect(h.deliveries).toHaveLength(0);
  });

  it('a flow without a secret is 401', async () => {
    queueFlow(flowRow({ webhookSecretEncrypted: null, webhookSecretRotatedAt: null }));
    expect(await ingest(signed())).toEqual({ http: 401, body: { error: 'Unauthorized' } });
  });

  it('bad signature 401 and marks the failure', async () => {
    queueFlow();
    const headers = signed();
    headers.set('x-breeze-signature', 'sha256=' + '0'.repeat(64));
    expect(await ingest(headers)).toEqual({ http: 401, body: { error: 'Unauthorized' } });
    expect(markWebhookAuthFailure).toHaveBeenCalledWith(FLOW, 'bad_signature');
    expect(h.deliveries).toHaveLength(0); // unauthenticated failures are never rows
  });

  it('suspended partner is 401 after a valid signature', async () => {
    queueFlow(flowRow({ orgId: null, partnerId: PARTNER }), doc({ type: 'webhook', auth: 'hmac', orgResolver: { path: 'body.customer.id', system: 'halo' } }));
    vi.mocked(getActivePartner).mockResolvedValueOnce(null);
    expect(await ingest(signed())).toEqual({ http: 401, body: { error: 'Unauthorized' } });
    expect(h.deliveries).toHaveLength(0);
    queueFlow();
    vi.mocked(getActiveOrgTenant).mockResolvedValueOnce(null);
    expect(await ingest(signed())).toEqual({ http: 401, body: { error: 'Unauthorized' } });
  });

  it('non-json body is 415 (after authentication)', async () => {
    queueFlow();
    const headers = signed();
    headers.set('content-type', 'text/plain');
    expect(await ingest(headers)).toMatchObject({ http: 415 });
    queueFlow();
    const unsigned = new Headers({ 'content-type': 'text/plain' });
    expect(await ingest(unsigned)).toMatchObject({ http: 401 });
  });

  it('json array body is invalid_body', async () => {
    queueFlow();
    const body = '[1,2]';
    const r = await ingest(signed(body), body);
    expect(r).toMatchObject({ http: 422, body: { status: 'invalid_body' } });
    expect(h.deliveries).toEqual([expect.objectContaining({ status: 'invalid_body', flowId: FLOW, orgId: ORG })]);
    queueFlow();
    const broken = '{"a":';
    expect(await ingest(signed(broken), broken)).toMatchObject({ http: 422, body: { status: 'invalid_body' } });
  });
});

describe('ingestFlowWebhook — runs and replay protection', () => {
  it('org flow run lands in its org, via webhook with the declared inputs null', async () => {
    queueFlow();
    const r = await ingest(signed(BODY, { 'x-breeze-delivery-id': 'evt_1' }));
    expect(r).toMatchObject({ http: 202, body: { status: 'accepted', runId: 'run-1' } });
    const call = h.createInputs[0]!;
    expect(call).toMatchObject({
      triggerKind: 'webhook', flowId: FLOW, orgId: ORG, inputs: { ticket: null }, dedupeKey: 'webhook:evt_1',
      expectedPublicationSeq: 2, expectedSecretRotatedAt: ROTATED,
    });
    expect(call.scope.body).toEqual({ customer: { id: 'C-77' }, note: 'hello' });
    expect(h.deliveries).toEqual([expect.objectContaining({ status: 'accepted', runId: 'run-1', orgId: ORG, deliveryId: 'evt_1', authMode: 'hmac' })]);
    // Never a body on the delivery row: only its hash and size.
    expect(h.deliveries[0]).toMatchObject({ bodySha256: createHash('sha256').update(BODY).digest('hex'), bodyBytes: Buffer.byteLength(BODY) });
    expect(JSON.stringify(h.deliveries[0])).not.toContain('hello');
  });

  it('partner-wide flow runs in the resolved org', async () => {
    const resolver = { path: 'body.customer.id', system: 'halo' };
    queueFlow(flowRow({ orgId: null, partnerId: PARTNER }), doc({ type: 'webhook', auth: 'hmac', orgResolver: resolver }));
    const r = await ingest(signed());
    expect(r).toMatchObject({ http: 202 });
    expect(resolveWebhookOrg).toHaveBeenCalledWith({ orgId: null, partnerId: PARTNER }, resolver, { customer: { id: 'C-77' }, note: 'hello' });
    expect(h.createInputs[0]).toMatchObject({ orgId: ORG });
    expect(h.deliveries[0]).toMatchObject({ partnerId: PARTNER, orgId: ORG, resolverValue: 'C-77' });
  });

  it('an unresolved org is 422 org_unresolved with an org-less row and no run', async () => {
    queueFlow(flowRow({ orgId: null, partnerId: PARTNER }), doc({ type: 'webhook', auth: 'hmac', orgResolver: { path: 'body.customer.id', system: 'halo' } }));
    vi.mocked(resolveWebhookOrg).mockResolvedValueOnce({ ok: false, value: 'C-77' });
    const r = await ingest(signed());
    expect(r).toMatchObject({ http: 422, body: { status: 'org_unresolved' } });
    expect(h.createInputs).toHaveLength(0);
    expect(h.deliveries).toEqual([expect.objectContaining({ status: 'org_unresolved', orgId: null, partnerId: PARTNER, resolverValue: 'C-77' })]);
  });

  it('fifty replays create one run', async () => {
    const headers = signed();
    const results = [];
    for (let i = 0; i < 50; i++) {
      queueFlow();
      results.push(await ingest(headers));
    }
    expect(results[0]).toMatchObject({ http: 202, body: { runId: 'run-1' } });
    for (const r of results.slice(1)) expect(r).toEqual({ http: 200, body: { status: 'duplicate', runId: 'run-1' } });
    expect(h.runs.size).toBe(1);
    expect(h.deliveries.filter((d) => d.status === 'accepted')).toHaveLength(1);
    expect(h.deliveries[0]!.attempts).toBe(50);
  });

  it('replay with a new delivery id collides on the signature', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    queueFlow();
    expect(await ingest(signed(BODY, { 'x-breeze-delivery-id': 'evt_1' }, ts))).toMatchObject({ http: 202 });
    queueFlow();
    // Same signed bytes, forged delivery id: the signature digest still collides.
    expect(await ingest(signed(BODY, { 'x-breeze-delivery-id': 'evt_forged' }, ts))).toEqual({ http: 200, body: { status: 'duplicate', runId: 'run-1' } });
    expect(h.runs.size).toBe(1);
  });

  it('re-signed retry with the same delivery id is duplicate', async () => {
    queueFlow();
    expect(await ingest(signed(BODY, { 'x-breeze-delivery-id': 'evt_9' }, String(Math.floor(Date.now() / 1000) - 5)))).toMatchObject({ http: 202 });
    queueFlow();
    expect(await ingest(signed(BODY, { 'x-breeze-delivery-id': 'evt_9' }))).toEqual({ http: 200, body: { status: 'duplicate', runId: 'run-1' } });
    expect(h.runs.size).toBe(1);
  });

  it('a race lost at the accepted-row insert answers duplicate and keeps no second run', async () => {
    queueFlow();
    h.nextCreate = async (i) => {
      // Another delivery with the same signature committed between our pre-check and our insert.
      h.deliveries.push({ id: 'd-winner', flowId: FLOW, status: 'accepted', signatureDigest: null, deliveryId: 'evt_7', runId: 'run-w', attempts: 1 });
      h.selects.push([]); // (unused)
      await i.onCreated('run-loser');
      return { created: true, runId: 'run-loser', preApprovalsHonored: false };
    };
    const r = await ingest(signed(BODY, { 'x-breeze-delivery-id': 'evt_7' }));
    expect(r).toEqual({ http: 200, body: { status: 'duplicate', runId: 'run-w' } });
  });

  it('accepted row and run commit together (fail the run insert ⇒ no row)', async () => {
    queueFlow();
    h.nextCreate = async () => { throw new Error('insert failed'); };
    await expect(ingest(signed())).rejects.toThrow('insert failed');
    expect(h.deliveries).toHaveLength(0);
  });

  it('webhook run never honours pre-approvals', async () => {
    queueFlow();
    await ingest(signed());
    // createFlowRun derives honoured=false for kind webhook; the ingress never passes the flag.
    expect(h.createInputs[0]).not.toHaveProperty('preApprovalsHonored');
    expect(h.createInputs[0]).not.toHaveProperty('triggeredVia');
  });

  it('refused delivery retried after the cap clears is accepted once', async () => {
    queueFlow();
    h.nextCreate = async () => ({ created: false, reason: 'flow_monthly_cap_reached' });
    const refused = await ingest(signed(BODY, { 'x-breeze-delivery-id': 'evt_c' }));
    expect(refused).toMatchObject({ http: 429, body: { status: 'refused', code: 'flow_monthly_cap_reached' } });
    expect((refused as { retryAfterSec: number }).retryAfterSec).toBeGreaterThan(0);
    expect(h.deliveries).toEqual([expect.objectContaining({ status: 'refused', refusalCode: 'flow_monthly_cap_reached', orgId: ORG })]);
    h.nextCreate = null;
    queueFlow();
    expect(await ingest(signed(BODY, { 'x-breeze-delivery-id': 'evt_c' }))).toMatchObject({ http: 202 });
    queueFlow();
    expect(await ingest(signed(BODY, { 'x-breeze-delivery-id': 'evt_c' }))).toMatchObject({ http: 200, body: { status: 'duplicate' } });
    expect(h.runs.size).toBe(1);
  });

  it('secret rotated or flow re-published between verify and insert refuses the delivery', async () => {
    queueFlow();
    h.nextCreate = async () => ({ created: false, reason: 'not_enabled' });
    expect(await ingest(signed())).toMatchObject({ http: 409, body: { status: 'refused', code: 'flow_changed' } });
    expect(h.deliveries).toHaveLength(0);
  });

  it('redacted envelope over the bound is 413 payload_too_large', async () => {
    // Under the 256 KB request bound, but the envelope (body + scope) is over it + 4 KB.
    const big = JSON.stringify({ blob: 'x'.repeat(262_144 - 40), more: 'y'.repeat(5000) });
    queueFlow();
    const r = await ingest(signed(big), big);
    expect(r).toMatchObject({ http: 413, body: { error: 'payload_too_large' } });
    expect(h.createInputs).toHaveLength(0);
    expect(h.deliveries).toEqual([expect.objectContaining({ status: 'refused', refusalCode: 'payload_too_large' })]);
  });

  it('token mode dedupes by delivery id only', async () => {
    queueFlow(flowRow(), doc({ type: 'webhook', auth: 'token' }));
    const headers = new Headers({ 'content-type': 'application/json', 'x-breeze-webhook-token': SECRET, 'x-breeze-delivery-id': 't-1' });
    expect(await ingest(headers)).toMatchObject({ http: 202 });
    expect(h.createInputs[0]).toMatchObject({ dedupeKey: 'webhook:t-1' });
    expect(h.deliveries[0]).toMatchObject({ authMode: 'token', signatureDigest: null });
    queueFlow(flowRow(), doc({ type: 'webhook', auth: 'token' }));
    expect(await ingest(headers)).toMatchObject({ http: 200, body: { status: 'duplicate' } });
  });

  it('an hmac delivery without an id dedupes on its signature digest', async () => {
    queueFlow();
    await ingest(signed());
    expect(h.createInputs[0]!.dedupeKey).toMatch(/^webhook:sig:[0-9a-f]{64}$/);
  });
});
