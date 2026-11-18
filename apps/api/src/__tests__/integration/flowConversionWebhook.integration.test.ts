/**
 * Tool Catalog W06 (#5221) Task B6 — legacy webhook forwarding on REAL
 * Postgres (as `breeze_app`, FORCE RLS) and REAL Redis, through the actual
 * legacy route `POST /api/v1/automations/webhooks/:id` with real HMACs.
 *
 * A switched Job's old URL forwards to its flow's ingest (the same raw bytes,
 * the legacy event id mapped to `X-Breeze-Delivery-Id`), and the flow's
 * `createFlowRun` claims both webhook aliases (`webhook:sig:<digest>`,
 * `webhook:dlv:<id>`) in its transaction. What only the database shows:
 *
 *  - a delivery legacy admitted before the switch (and claimed, B2) is a
 *    duplicate when it reaches the flow after it, whether the retry is
 *    re-signed with the same event id (the alias `webhook:dlv:`) or the
 *    identical signed bytes (the alias `webhook:sig:`, so both sides compute
 *    the same signature digest);
 *  - an unconverted row and a shadow row are untouched by forwarding.
 *
 * Mocked: only the BullMQ enqueues (legacy run, flow slice). All tenants are
 * synthetic.
 */
import './setup';
import { createHmac, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const enqueueAutomationRun = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../jobs/automationWorker', async (orig) => ({
  ...(await orig<typeof import('../../jobs/automationWorker')>()),
  enqueueAutomationRun,
}));
vi.mock('../../jobs/flowRunQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../jobs/flowRunQueue')>()),
  enqueueFlowRunSlice: vi.fn(async () => 'job'),
}));

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { automationOccurrenceClaims, automationRuns, automations, flowRuns, flowWebhookDeliveries, flows } from '../../db/schema';
import { automationWebhookRoutes } from '../../routes/automations';
import { encryptFlowWebhookSecret } from '../../services/flows/webhook/secret';
import { encryptSecret, hmacFingerprint } from '../../services/secretCrypto';
import { createOrganization, createPartner, createUser } from './db-utils';
import { seedEnabledFlow } from './helpers/flowSeed';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const ENV_KEYS = ['FLOWS_ENABLED'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.FLOWS_ENABLED = 'true';
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
beforeEach(() => {
  enqueueAutomationRun.mockClear();
});

const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

const PIN = { stepId: 'look', tool: 'list_devices', source: 'core', tier: 1, approvalScope: null } as const;
const STEP = { id: 'look', tool: 'list_devices', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 300 };
const WEBHOOK_DOC = { version: 1, name: 'Converted webhook job', trigger: { type: 'webhook', auth: 'hmac' }, inputs: [], steps: [STEP] };

type State = 'none' | 'shadow' | 'switched';

interface Fixture {
  automationId: string;
  flowId: string;
  conversionId: string | null;
  secret: string;
  orgId: string;
}

/**
 * A standalone webhook Job (legacy secret) and, unless `none`, its converted
 * flow carrying the SAME secret (what B3's switch does) and a generation in
 * `state` (B2's fixture shape). `switchNow` flips a shadow fixture to switched
 * the way the switch leaves it.
 */
async function fixture(state: State): Promise<Fixture & { switchNow: () => Promise<void> }> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const delegator = await createUser({ partnerId: partner.id, orgId: org.id, email: `b6-${randomUUID()}@forward.test` });
  const secret = `legacy-${randomUUID()}`;
  const [automation] = await system(() => db.insert(automations).values({
    orgId: org.id,
    name: `Webhook job ${randomUUID().slice(0, 6)}`,
    enabled: true,
    trigger: { type: 'webhook', secret: encryptSecret(secret) },
    conditions: {},
    actions: [{ type: 'execute_command', command: 'synthetic-forward' }],
    onFailure: 'stop',
  } as typeof automations.$inferInsert).returning({ id: automations.id }));
  const automationId = automation!.id;
  const base = { automationId, secret, orgId: org.id };
  if (state === 'none') return { ...base, flowId: '', conversionId: null, switchNow: async () => { throw new Error('no conversion'); } };

  const { flowId } = await seedEnabledFlow({ orgId: org.id, partnerId: partner.id, delegatorUserId: delegator.id, definition: WEBHOOK_DOC, pins: [PIN] });
  await system(() => db.update(flows).set({
    webhookSecretEncrypted: encryptFlowWebhookSecret(flowId, secret),
    webhookSecretFingerprint: hmacFingerprint(secret),
    webhookSecretRotatedAt: new Date(),
  }).where(eq(flows.id, flowId)));
  const conversionId = await system(async () => {
    const [row] = (await db.execute(sql`
      INSERT INTO flow_automation_conversions (org_id, automation_id, flow_id, fidelity, source_digest, source_snapshot, document_digest)
      VALUES (${org.id}, ${automationId}, ${flowId}, 'exact', ${'a'.repeat(64)}, '{}', ${'b'.repeat(64)})
      RETURNING id`)) as unknown as Array<{ id: string }>;
    return row!.id;
  });
  const switchNow = () => system(async () => {
    await db.execute(sql`UPDATE flow_automation_conversions
      SET state = 'switched', switch_at = now() + interval '60 seconds', switched_at = now() WHERE id = ${conversionId}`);
    await db.execute(sql`UPDATE automations SET enabled = false, retired_at = now(), retired_reason = 'converted_to_flow',
      converted_to_flow_id = ${flowId} WHERE id = ${automationId}`);
  });
  if (state === 'switched') await switchNow();
  return { ...base, flowId, conversionId, switchNow };
}

function app() {
  return new Hono().route('/api/v1/automations/webhooks', automationWebhookRoutes);
}

interface Signed {
  body: string;
  headers: Record<string, string>;
}

/** A request signed the way legacy senders sign today. */
function signed(secret: string, body: string, extra: Record<string, string> = {}, ts = String(Math.floor(Date.now() / 1000))): Signed {
  const signature = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  return {
    body,
    headers: { 'content-type': 'application/json', 'x-breeze-timestamp': ts, 'x-breeze-signature': signature, ...extra },
  };
}

const post = (automationId: string, r: Signed) =>
  app().request(`/api/v1/automations/webhooks/${automationId}`, { method: 'POST', headers: r.headers, body: r.body });

const claimsOf = (automationId: string) =>
  system(() => db.select().from(automationOccurrenceClaims).where(eq(automationOccurrenceClaims.automationId, automationId)));
const legacyRunsOf = (automationId: string) =>
  system(() => db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId)));
const flowRunsOf = (flowId: string) =>
  system(() => db.select().from(flowRuns).where(eq(flowRuns.flowId, flowId)));
const acceptedDeliveriesOf = (flowId: string) =>
  system(() => db.select().from(flowWebhookDeliveries)
    .where(and(eq(flowWebhookDeliveries.flowId, flowId), eq(flowWebhookDeliveries.status, 'accepted'))));

describe('legacy webhook forwarding across the switch (real Postgres + Redis, #5221 B6)', () => {
  runDb('re-signed retry with a stable delivery id is a duplicate', async () => {
    const f = await fixture('shadow');
    const eventId = `evt_${randomUUID()}`;
    // Accepted by legacy before the switch (a shadow row claims, B2).
    const first = await post(f.automationId, signed(f.secret, JSON.stringify({ n: 1 }), { 'x-breeze-event-id': eventId }));
    expect(first.status).toBe(202);
    const [legacyRun] = await legacyRunsOf(f.automationId);
    expect(legacyRun).toBeDefined();

    await f.switchNow();

    // The sender's retry: re-signed with a fresh timestamp, same event id, old URL.
    const later = String(Math.floor(Date.now() / 1000) + 1);
    const retry = await post(f.automationId, signed(f.secret, JSON.stringify({ n: 1 }), { 'x-breeze-event-id': eventId }, later));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ status: 'duplicate', legacyRunId: legacyRun!.id });
    expect(retry.headers.get('cache-control')).toBe('no-store');

    // Nothing admitted on either engine; the claims are legacy's two.
    expect(await flowRunsOf(f.flowId)).toEqual([]);
    expect(await acceptedDeliveriesOf(f.flowId)).toEqual([]);
    expect(await legacyRunsOf(f.automationId)).toHaveLength(1);
    const claims = await claimsOf(f.automationId);
    expect(claims.map((c) => c.engine)).toEqual(['legacy', 'legacy']);
    expect(claims.map((c) => c.occurrenceKey)).toEqual(expect.arrayContaining([`webhook:dlv:${eventId}`, expect.stringMatching(/^webhook:sig:[0-9a-f]{64}$/)]));
    for (const c of claims) expect(c.legacyRunId).toBe(legacyRun!.id);
  });

  runDb('identical signed redelivery of a legacy-admitted delivery is a duplicate', async () => {
    const f = await fixture('shadow');
    // No event id: only the signature alias can collide.
    const request = signed(f.secret, JSON.stringify({ n: 'identical' }));
    expect((await post(f.automationId, request)).status).toBe(202);
    const [legacyRun] = await legacyRunsOf(f.automationId);
    const legacyClaims = await claimsOf(f.automationId);
    expect(legacyClaims.map((c) => c.occurrenceKey)).toEqual([expect.stringMatching(/^webhook:sig:[0-9a-f]{64}$/)]);

    await f.switchNow();

    const again = await post(f.automationId, request);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: 'duplicate', legacyRunId: legacyRun!.id });
    expect(await flowRunsOf(f.flowId)).toEqual([]);
    // The flow computed the very digest legacy claimed (no second claim row).
    expect((await claimsOf(f.automationId)).map((c) => c.occurrenceKey)).toEqual(legacyClaims.map((c) => c.occurrenceKey));
  });

  runDb('forwarded delivery maps the legacy event id header', async () => {
    const f = await fixture('switched');
    const eventId = `evt_${randomUUID()}`;
    const body = '{ "ticket" : 42 }';
    const res = await post(f.automationId, signed(f.secret, body, { 'x-breeze-event-id': eventId }));
    expect(res.status).toBe(202);
    const out = await res.json() as { status: string; runId: string; deliveryId: string };
    expect(out).toMatchObject({ status: 'accepted' });

    // The flow admitted it (legacy did not), keyed by the mapped delivery id.
    expect(await legacyRunsOf(f.automationId)).toEqual([]);
    expect(enqueueAutomationRun).not.toHaveBeenCalled();
    const [run] = await flowRunsOf(f.flowId);
    expect(run).toMatchObject({ id: out.runId, orgId: f.orgId, triggerKind: 'webhook', dedupeKey: `webhook:${eventId}` });
    const [delivery] = await acceptedDeliveriesOf(f.flowId);
    expect(delivery).toMatchObject({ id: out.deliveryId, runId: out.runId, deliveryId: eventId, authMode: 'hmac' });

    // Both aliases, engine flow, naming the run, in its transaction.
    const claims = await claimsOf(f.automationId);
    expect(claims).toHaveLength(2);
    for (const c of claims) expect(c).toMatchObject({ engine: 'flow', flowRunId: out.runId, legacyRunId: null, conversionId: f.conversionId });
    expect(claims.map((c) => c.occurrenceKey).sort()).toEqual([`webhook:dlv:${eventId}`, `webhook:sig:${delivery!.signatureDigest}`].sort());

    // The nonce header is the fallback, as legacy reads it.
    const nonce = `nonce_${randomUUID()}`;
    const viaNonce = await post(f.automationId, signed(f.secret, JSON.stringify({ n: 2 }), { 'x-breeze-nonce': nonce }));
    expect(viaNonce.status).toBe(202);
    expect((await claimsOf(f.automationId)).map((c) => c.occurrenceKey)).toContain(`webhook:dlv:${nonce}`);
  });

  runDb('non-object body after the switch is 415', async () => {
    const f = await fixture('switched');
    // A body legacy took (any content type, parsed as JSON) is refused by the flow's JSON-object-only contract.
    const textual = signed(f.secret, JSON.stringify({ n: 1 }), { 'content-type': 'text/plain' });
    const res = await post(f.automationId, textual);
    expect(res.status).toBe(415);
    // A JSON body that is not an object: the flow's invalid_body (W05 ingest), never a run.
    const array = await post(f.automationId, signed(f.secret, '[1,2,3]'));
    expect(array.status).toBe(422);
    expect(await array.json()).toMatchObject({ status: 'invalid_body' });
    expect(await flowRunsOf(f.flowId)).toEqual([]);
    expect(await legacyRunsOf(f.automationId)).toEqual([]);
    expect(await claimsOf(f.automationId)).toEqual([]);
  });

  runDb('unconverted row falls through to legacy unchanged', async () => {
    const f = await fixture('none');
    const request = signed(f.secret, JSON.stringify({ n: 1 }), { 'x-breeze-event-id': `evt_${randomUUID()}` });
    const res = await post(f.automationId, request);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { accepted: boolean }).accepted).toBe(true);
    expect(await legacyRunsOf(f.automationId)).toHaveLength(1);
    expect(enqueueAutomationRun).toHaveBeenCalledTimes(1);
    expect(await claimsOf(f.automationId)).toEqual([]);
    // Legacy's own Redis replay guard answers the redelivery, as today.
    const again = await post(f.automationId, request);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'Duplicate webhook delivery' });
    // A disabled, unconverted row stays 404.
    await system(() => db.update(automations).set({ enabled: false }).where(eq(automations.id, f.automationId)));
    expect((await post(f.automationId, signed(f.secret, JSON.stringify({ n: 3 })))).status).toBe(404);
  });

  runDb('shadow row falls through to legacy and writes claims', async () => {
    const f = await fixture('shadow');
    const eventId = `evt_${randomUUID()}`;
    const res = await post(f.automationId, signed(f.secret, JSON.stringify({ n: 1 }), { 'x-breeze-event-id': eventId }));
    expect(res.status).toBe(202);
    const body = await res.json() as { accepted: boolean; run: { id: string } };
    expect(body.accepted).toBe(true);
    expect(await flowRunsOf(f.flowId)).toEqual([]);
    const claims = await claimsOf(f.automationId);
    expect(claims).toHaveLength(2);
    for (const c of claims) expect(c).toMatchObject({ engine: 'legacy', legacyRunId: body.run.id, conversionId: f.conversionId });
  });

  runDb('plain-secret header to a switched row is 401', async () => {
    const f = await fixture('switched');
    const prior = process.env.AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET;
    // Even with legacy's emergency plain-secret flag on, a switched row never takes that path.
    process.env.AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET = 'true';
    try {
      for (const header of ['x-webhook-secret', 'x-automation-secret']) {
        const res = await post(f.automationId, { body: JSON.stringify({ n: 1 }), headers: { 'content-type': 'application/json', [header]: f.secret } });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
      }
    } finally {
      if (prior === undefined) delete process.env.AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET;
      else process.env.AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET = prior;
    }
    expect(await flowRunsOf(f.flowId)).toEqual([]);
    expect(await legacyRunsOf(f.automationId)).toEqual([]);
    expect(await claimsOf(f.automationId)).toEqual([]);
  });
});
