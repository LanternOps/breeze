/**
 * Tool Catalog W05 (#5220), plan Task A8 — the flow webhook delivery log against
 * REAL Postgres as breeze_app under FORCE RLS: the conditional policy
 * (org rows by org access, partner-level rows by partner access), the
 * composite (org_id, partner_id) FK, the owner-guard trigger, the partial
 * unique replay keys, the immutability trigger, the real-DB ingress
 * (`ingestFlowWebhook`: signed request -> run -> accepted delivery -> replay)
 * and the row-bound AAD of the webhook secret through key rotation.
 * migrations/2027-01-06-160000-flow-webhooks-tools-budgets.sql
 *
 * The branch logic of the ingress, verifier and resolver is unit-tested
 * (webhook/*.test.ts); the cap and counter races live in
 * flowBudgets.integration.test.ts.
 */
import './setup';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

vi.mock('../../jobs/flowRunQueue', () => ({ enqueueFlowRunSlice: vi.fn(async () => 'job') }));

import { flowUsagePeriodKey } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { flowRuns, flowUsageCounters, flowWebhookDeliveries, flows } from '../../db/schema';
import { encryptedColumnRegistry, reencryptRegisteredSecrets } from '../../services/encryptedColumnRegistry';
import { ingestFlowWebhook } from '../../services/flows/webhook/ingest';
import { decryptFlowWebhookSecret, encryptFlowWebhookSecret } from '../../services/flows/webhook/secret';
import { getEncryptedSecretKeyId, hmacFingerprint } from '../../services/secretCrypto';
import { pgErrorConstraint } from '../../utils/pgErrors';
import { createOrganization, createPartner, createUser } from './db-utils';
import { seedEnabledFlow } from './helpers/flowSeed';
import { expectSqlState, orgContext, partnerContext } from './helpers/flowRls';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const PIN = { stepId: 'look', tool: 'list_devices', source: 'core', tier: 1, approvalScope: null } as const;
const STEP = { id: 'look', tool: 'list_devices', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 300 };
const WEBHOOK_DOC = {
  version: 1, name: 'On webhook', trigger: { type: 'webhook', auth: 'hmac' }, inputs: [], steps: [STEP],
};

const hex64 = () => randomBytes(32).toString('hex');

interface Tenant {
  partnerId: string;
  orgA: string;
  orgB: string;
  delegatorId: string;
}

async function tenant(): Promise<Tenant> {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const delegator = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `delegator-${randomUUID()}@flowwebhooks.test` });
  return { partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, delegatorId: delegator.id };
}

function seedFlow(t: Tenant, owner: 'org' | 'partner' = 'org', orgId = t.orgA) {
  return seedEnabledFlow({
    partnerId: t.partnerId, orgId, owner, delegatorUserId: t.delegatorId, definition: WEBHOOK_DOC, pins: [PIN],
  });
}

/** A refused/org_unresolved delivery needs no run; every NOT NULL column and CHECK is respected. */
function deliveryValues(flowId: string, partnerId: string, orgId: string | null, over: Partial<typeof flowWebhookDeliveries.$inferInsert> = {}) {
  return {
    partnerId,
    orgId,
    flowId,
    authMode: 'hmac' as const,
    deliveryId: null,
    signatureDigest: hex64(),
    bodySha256: hex64(),
    bodyBytes: 12,
    status: (orgId === null ? 'org_unresolved' : 'refused') as 'org_unresolved' | 'refused',
    refusalCode: orgId === null ? null : 'flow_queue_full',
    ...over,
  };
}

async function insertDelivery(values: ReturnType<typeof deliveryValues>): Promise<string> {
  const [row] = await withSystemDbAccessContext(() => db.insert(flowWebhookDeliveries).values(values).returning({ id: flowWebhookDeliveries.id }));
  return row!.id;
}

async function insertWebhookRun(s: { flowId: string; publicationId: string }, orgId: string): Promise<string> {
  const [row] = await withSystemDbAccessContext(() => db.insert(flowRuns).values({
    orgId,
    flowId: s.flowId,
    flowVersionId: s.publicationId,
    definitionVersion: 1,
    triggerKind: 'webhook',
    triggeredVia: 'webhook',
    triggerPayload: {},
    inputs: {},
    status: 'queued',
    preApprovalsHonored: false,
    dedupeKey: `webhook:${randomUUID()}`,
  }).returning({ id: flowRuns.id }));
  return row!.id;
}

const visibleDeliveryIds = (ctx: Parameters<typeof withDbAccessContext>[0], ids: string[]) =>
  withDbAccessContext(ctx, async () =>
    (await db.select({ id: flowWebhookDeliveries.id }).from(flowWebhookDeliveries).where(inArray(flowWebhookDeliveries.id, ids))).map((r) => r.id).sort());

const readDelivery = (id: string) =>
  withSystemDbAccessContext(async () => (await db.select().from(flowWebhookDeliveries).where(eq(flowWebhookDeliveries.id, id)))[0]!);

// ───────────────────────────────────────────────────────────────────────────
// RLS + constraints + triggers
// ───────────────────────────────────────────────────────────────────────────

describe('flow_webhook_deliveries RLS + constraints (real Postgres)', () => {
  runDb("org B inserting a delivery with org A's org_id for org A's flow is rejected (42501); its own org's flow is admitted", async () => {
    const t = await tenant();
    const flowA = await seedFlow(t, 'org', t.orgA);
    const flowB = await seedFlow(t, 'org', t.orgB);
    await expectSqlState(
      () => withDbAccessContext(orgContext(t.orgB, t.partnerId), () =>
        db.insert(flowWebhookDeliveries).values(deliveryValues(flowA.flowId, t.partnerId, t.orgA))),
      '42501',
    );
    // Control: the identical shape in its OWN org, for its own flow, is admitted - the refusal above is the org axis.
    const [own] = await withDbAccessContext(orgContext(t.orgB, t.partnerId), () =>
      db.insert(flowWebhookDeliveries).values(deliveryValues(flowB.flowId, t.partnerId, t.orgB)).returning({ id: flowWebhookDeliveries.id }));
    expect(own?.id).toBeDefined();
  });

  runDb('a delivery whose org_id is not under its partner_id is rejected by the composite FK (23503)', async () => {
    const t = await tenant();
    const other = await tenant();
    // A partner-wide flow: the owner guard admits any org_id under the flow's partner_id, so the FK is what refuses.
    const pw = await seedFlow(t, 'partner');
    await expectSqlState(
      () => withSystemDbAccessContext(() => db.insert(flowWebhookDeliveries).values(deliveryValues(pw.flowId, t.partnerId, other.orgA))),
      '23503',
    );
    // Control: an org of the flow's own partner is admitted.
    expect(await insertDelivery(deliveryValues(pw.flowId, t.partnerId, t.orgB))).toBeDefined();
  });

  runDb('owner guard: a delivery that does not match its flow raises 23514 flow_webhook_deliveries_owner_chk, even in system scope', async () => {
    const t = await tenant();
    const other = await tenant();
    const orgFlow = await seedFlow(t, 'org', t.orgA);
    const pwFlow = await seedFlow(t, 'partner');

    // An org flow's delivery in a SIBLING org of the same partner.
    const sibling = await expectSqlState(
      () => withSystemDbAccessContext(() => db.insert(flowWebhookDeliveries).values(deliveryValues(orgFlow.flowId, t.partnerId, t.orgB))),
      '23514',
    );
    expect(pgErrorConstraint(sibling)).toBe('flow_webhook_deliveries_owner_chk');

    // An org flow's delivery under ANOTHER partner.
    const wrongPartner = await expectSqlState(
      () => withSystemDbAccessContext(() => db.insert(flowWebhookDeliveries).values(deliveryValues(orgFlow.flowId, other.partnerId, t.orgA))),
      '23514',
    );
    expect(pgErrorConstraint(wrongPartner)).toBe('flow_webhook_deliveries_owner_chk');

    // A partner-wide flow's delivery under ANOTHER partner (org-less, so the FK is not what refuses it).
    const pwWrong = await expectSqlState(
      () => withSystemDbAccessContext(() => db.insert(flowWebhookDeliveries).values(deliveryValues(pwFlow.flowId, other.partnerId, null))),
      '23514',
    );
    expect(pgErrorConstraint(pwWrong)).toBe('flow_webhook_deliveries_owner_chk');

    // Controls: the matching owner is admitted for both flow kinds.
    expect(await insertDelivery(deliveryValues(orgFlow.flowId, t.partnerId, t.orgA))).toBeDefined();
    expect(await insertDelivery(deliveryValues(pwFlow.flowId, t.partnerId, null))).toBeDefined();
  });

  runDb('an org token reads its own org\'s deliveries, never a sibling org\'s, and cannot read a partner-level (org_unresolved, org_id NULL) delivery', async () => {
    const t = await tenant();
    const pw = await seedFlow(t, 'partner');
    const inA = await insertDelivery(deliveryValues(pw.flowId, t.partnerId, t.orgA));
    const inB = await insertDelivery(deliveryValues(pw.flowId, t.partnerId, t.orgB));
    const partnerLevel = await insertDelivery(deliveryValues(pw.flowId, t.partnerId, null));
    const all = [inA, inB, partnerLevel];

    expect((await readDelivery(partnerLevel))).toMatchObject({ status: 'org_unresolved', orgId: null });
    // Org A: its own row only (own row visible is the positive control for the two refusals).
    expect(await visibleDeliveryIds(orgContext(t.orgA, t.partnerId), all)).toEqual([inA]);
    expect(await visibleDeliveryIds(orgContext(t.orgB, t.partnerId), all)).toEqual([inB]);
  });

  runDb('a partner token with selected org access sees only those orgs\' rows plus the partner-level rows', async () => {
    const t = await tenant();
    const orgC = await createOrganization({ partnerId: t.partnerId });
    const pw = await seedFlow(t, 'partner');
    const inA = await insertDelivery(deliveryValues(pw.flowId, t.partnerId, t.orgA));
    const inB = await insertDelivery(deliveryValues(pw.flowId, t.partnerId, t.orgB));
    const inC = await insertDelivery(deliveryValues(pw.flowId, t.partnerId, orgC.id));
    const partnerLevel = await insertDelivery(deliveryValues(pw.flowId, t.partnerId, null));
    const all = [inA, inB, inC, partnerLevel];

    expect(await visibleDeliveryIds(partnerContext(t.partnerId, [t.orgA, t.orgB]), all)).toEqual([inA, inB, partnerLevel].sort());
    expect(await visibleDeliveryIds(partnerContext(t.partnerId, [t.orgA]), all)).toEqual([inA, partnerLevel].sort());
    // Another partner's token sees none of them.
    const other = await tenant();
    expect(await visibleDeliveryIds(partnerContext(other.partnerId, [other.orgA]), all)).toEqual([]);
  });

  runDb('two ACCEPTED rows with one signature digest for one flow raise 23505; a refused and an accepted row with that digest coexist', async () => {
    const t = await tenant();
    const flow = await seedFlow(t);
    const digest = hex64();
    const run1 = await insertWebhookRun(flow, t.orgA);
    const run2 = await insertWebhookRun(flow, t.orgA);
    const accepted = (runId: string, over: Partial<typeof flowWebhookDeliveries.$inferInsert> = {}) =>
      deliveryValues(flow.flowId, t.partnerId, t.orgA, { status: 'accepted', refusalCode: null, runId, signatureDigest: digest, ...over });

    // A refused delivery first, then the accepted retry of the same signature: both rows exist.
    await insertDelivery(deliveryValues(flow.flowId, t.partnerId, t.orgA, { signatureDigest: digest }));
    await insertDelivery(accepted(run1));
    const raised = await expectSqlState(
      () => withSystemDbAccessContext(() => db.insert(flowWebhookDeliveries).values(accepted(run2))),
      '23505',
    );
    expect(pgErrorConstraint(raised)).toBe('flow_webhook_deliveries_sig_uq');
    const rows = await withSystemDbAccessContext(() =>
      db.select({ status: flowWebhookDeliveries.status }).from(flowWebhookDeliveries).where(eq(flowWebhookDeliveries.flowId, flow.flowId)));
    expect(rows.map((r) => r.status).sort()).toEqual(['accepted', 'refused']);

    // The same digest on ANOTHER flow is not a replay.
    const otherFlow = await seedFlow(t);
    const run3 = await insertWebhookRun(otherFlow, t.orgA);
    expect(await insertDelivery(deliveryValues(otherFlow.flowId, t.partnerId, t.orgA, { status: 'accepted', refusalCode: null, runId: run3, signatureDigest: digest }))).toBeDefined();
  });

  runDb('the immutability trigger refuses changing status / run_id / org_id; attempts, last_attempt_at and refusal_code may change', async () => {
    const t = await tenant();
    const flow = await seedFlow(t);
    const id = await insertDelivery(deliveryValues(flow.flowId, t.partnerId, t.orgA));
    const runId = await insertWebhookRun(flow, t.orgA);
    const update = (set: Partial<typeof flowWebhookDeliveries.$inferInsert>) =>
      () => withSystemDbAccessContext(() => db.update(flowWebhookDeliveries).set(set).where(eq(flowWebhookDeliveries.id, id)));

    // SQLSTATE 23000 = integrity_constraint_violation (the trigger's ERRCODE).
    await expectSqlState(update({ status: 'invalid_body' }), '23000');
    await expectSqlState(update({ runId }), '23000');
    await expectSqlState(update({ orgId: t.orgB }), '23000');
    expect(await readDelivery(id)).toMatchObject({ status: 'refused', runId: null, orgId: t.orgA });

    const later = new Date(Date.now() + 5_000);
    await update({ attempts: 2, lastAttemptAt: later, refusalCode: 'owner_monthly_cap_reached' })();
    expect(await readDelivery(id)).toMatchObject({ attempts: 2, refusalCode: 'owner_monthly_cap_reached' });
    expect((await readDelivery(id)).lastAttemptAt.getTime()).toBe(later.getTime());
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ingestFlowWebhook end to end
// ───────────────────────────────────────────────────────────────────────────

const ENV_KEYS = ['FLOWS_ENABLED', 'APP_ENCRYPTION_KEY_ID', 'APP_ENCRYPTION_KEYRING'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEY_OLD = 'flowwh-old';
const KEY_NEW = 'flowwh-new';

beforeAll(() => {
  process.env.FLOWS_ENABLED = 'true';
});
beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY_ID = KEY_OLD;
  process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ [KEY_OLD]: 'flowwh-old-key-material-0123456789', [KEY_NEW]: 'flowwh-new-key-material-0123456789' });
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  process.env.FLOWS_ENABLED = 'true';
});
afterAll(() => {
  if (savedEnv.FLOWS_ENABLED === undefined) delete process.env.FLOWS_ENABLED;
  else process.env.FLOWS_ENABLED = savedEnv.FLOWS_ENABLED;
});

async function setSecret(flowId: string, secret: string): Promise<void> {
  await withSystemDbAccessContext(() => db.update(flows).set({
    webhookSecretEncrypted: encryptFlowWebhookSecret(flowId, secret),
    webhookSecretFingerprint: hmacFingerprint(secret),
    webhookSecretRotatedAt: new Date(),
  }).where(eq(flows.id, flowId)));
}

function signedRequest(flowId: string, secret: string, body: string, deliveryId?: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  const headers = new Headers({
    'content-type': 'application/json',
    'x-breeze-timestamp': ts,
    'x-breeze-signature': signature,
    ...(deliveryId ? { 'x-breeze-delivery-id': deliveryId } : {}),
  });
  return { flowId, rawBody: body, headers, receivedAt: new Date(), clientIp: '198.51.100.7' };
}

describe('ingestFlowWebhook against real Postgres', () => {
  runDb('a signed delivery starts one webhook run and writes one accepted delivery and the counters; the identical replay is a 200 duplicate of the same run', async () => {
    const t = await tenant();
    const { flowId } = await seedFlow(t);
    const secret = `bwh_${randomBytes(32).toString('base64url')}`;
    await setSecret(flowId, secret);
    const body = JSON.stringify({ event: 'ticket.created', id: 42 });

    const req = signedRequest(flowId, secret, body);
    const first = await ingestFlowWebhook(req);
    expect(first).toMatchObject({ http: 202, body: { status: 'accepted' } });
    const runId = (first.body as { runId: string }).runId;

    const runs = await withSystemDbAccessContext(() => db.select().from(flowRuns).where(eq(flowRuns.flowId, flowId)));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: runId, orgId: t.orgA, triggerKind: 'webhook', triggeredVia: 'webhook', preApprovalsHonored: false });

    const deliveries = await withSystemDbAccessContext(() => db.select().from(flowWebhookDeliveries).where(eq(flowWebhookDeliveries.flowId, flowId)));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ status: 'accepted', runId, orgId: t.orgA, partnerId: t.partnerId, attempts: 1, authMode: 'hmac' });
    expect(deliveries[0]!.id).toBe((first.body as { deliveryId: string }).deliveryId);

    const period = flowUsagePeriodKey(new Date());
    const counters = await withSystemDbAccessContext(() => db.select().from(flowUsageCounters).where(eq(flowUsageCounters.partnerId, t.partnerId)));
    const flowRow = counters.find((c) => c.flowId === flowId);
    const ownerRow = counters.find((c) => c.flowId === null);
    expect(flowRow).toMatchObject({ orgId: t.orgA, periodKey: period, runs: 1 });
    expect(ownerRow).toMatchObject({ orgId: t.orgA, periodKey: period, runs: 1 });

    // Replay of the identical signed request: same signature, so the accepted row is the replay key.
    const replay = await ingestFlowWebhook({ ...req, receivedAt: new Date() });
    expect(replay).toEqual({ http: 200, body: { status: 'duplicate', runId } });
    expect(await withSystemDbAccessContext(() => db.select().from(flowRuns).where(eq(flowRuns.flowId, flowId)))).toHaveLength(1);
    const after = await withSystemDbAccessContext(() => db.select().from(flowWebhookDeliveries).where(eq(flowWebhookDeliveries.flowId, flowId)));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: 'accepted', runId, attempts: 2 });
    // A duplicate never charges.
    const recount = await withSystemDbAccessContext(() => db.select().from(flowUsageCounters).where(eq(flowUsageCounters.partnerId, t.partnerId)));
    expect(recount.map((c) => c.runs).sort()).toEqual([1, 1]);
  });

  runDb('a bad signature is a 401 with no run and no delivery row', async () => {
    const t = await tenant();
    const { flowId } = await seedFlow(t);
    await setSecret(flowId, `bwh_${randomBytes(32).toString('base64url')}`);
    const res = await ingestFlowWebhook(signedRequest(flowId, 'bwh_not-the-secret', JSON.stringify({ a: 1 })));
    expect(res.http).toBe(401);
    expect(await withSystemDbAccessContext(() => db.select().from(flowRuns).where(eq(flowRuns.flowId, flowId)))).toHaveLength(0);
    expect(await withSystemDbAccessContext(() => db.select().from(flowWebhookDeliveries).where(eq(flowWebhookDeliveries.flowId, flowId)))).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Secret AAD through key rotation
// ───────────────────────────────────────────────────────────────────────────

describe('flows.webhook_secret_encrypted (real Postgres)', () => {
  runDb('secret encrypted under row AAD round-trips through reencryptRegisteredSecrets', async () => {
    const t = await tenant();
    const { flowId } = await seedFlow(t);
    const other = await seedFlow(t);
    const secret = `bwh_${randomBytes(32).toString('base64url')}`;
    await setSecret(flowId, secret); // sealed under KEY_OLD (v3, row-bound AAD)
    const sealedOld = (await withSystemDbAccessContext(() => db.select({ s: flows.webhookSecretEncrypted }).from(flows).where(eq(flows.id, flowId))))[0]!.s!;
    expect(getEncryptedSecretKeyId(sealedOld)).toBe(KEY_OLD);

    // Rotate the active key; the old one stays in the keyring so it still decrypts.
    process.env.APP_ENCRYPTION_KEY_ID = KEY_NEW;
    const spec = encryptedColumnRegistry.find((e) => e.table === 'flows' && e.column === 'webhook_secret_encrypted');
    expect(spec).toBeDefined();
    const errors: string[] = [];
    const stats = await reencryptRegisteredSecrets({
      dryRun: false,
      registry: [spec!],
      logger: { log: () => {}, warn: () => {}, error: (m: string) => errors.push(m) },
    });
    expect(errors).toEqual([]);
    expect(stats.errors).toEqual([]);
    expect(stats.updated).toBe(1);

    const [row] = await withSystemDbAccessContext(() => db.select({ id: flows.id, webhookSecretEncrypted: flows.webhookSecretEncrypted }).from(flows).where(eq(flows.id, flowId)));
    expect(getEncryptedSecretKeyId(row!.webhookSecretEncrypted!)).toBe(KEY_NEW);
    // Still bound to ITS row: it decrypts for this flow...
    expect(decryptFlowWebhookSecret(row!)).toBe(secret);
    // ...and a copy pasted onto another flow does not.
    expect(() => decryptFlowWebhookSecret({ id: other.flowId, webhookSecretEncrypted: row!.webhookSecretEncrypted })).toThrow();
  });
});
