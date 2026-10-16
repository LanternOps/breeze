/**
 * Endpoint messaging persistence tables (#8742 W02): RLS + tenant-consistency
 * contract. Migration: 2026-12-29-160000-endpoint-messaging-tables.sql.
 *
 * - endpoint_messages: shape 1 (direct org_id).
 * - endpoint_message_deliveries / endpoint_message_receipts: shape 5 hot
 *   agent-write, denormalized org_id, direct breeze_has_org_access policy.
 *
 * Runs through the real postgres.js driver as `breeze_app`, so a cross-tenant
 * forge is refused by RLS (42501), and an authorized caller naming another
 * org's device/delivery/message is refused by the composite tenant FKs
 * (23503).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  endpointMessageDeliveries,
  endpointMessageReceipts,
  endpointMessages,
} from '../../db/schema';
import { moveDeviceOrgInTransaction } from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const asOrg = <T>(orgId: string, partnerId: string, fn: () => Promise<T>) =>
  withDbAccessContext(orgContext(orgId, partnerId), fn);

/** postgres.js errors carry `code`; drizzle may wrap them in `cause`. */
async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code;
  }
}

function messageValues(orgId: string) {
  return {
    orgId,
    batchId: randomUUID(),
    clientMessageId: randomUUID(),
    targetMode: 'devices',
    targetSpec: {},
    title: 'Maintenance tonight',
    body: 'Please save your work.',
    severity: 'info' as const,
    requiresAck: true,
    expiresAt: new Date(Date.now() + 86_400_000),
    branding: {},
    bodySha256: 'a'.repeat(64),
    bodyLength: 22,
  };
}

interface Fixture {
  partnerId: string;
  orgA: string;
  orgB: string;
  siteA: string;
  siteB: string;
  devA: string;
  devB: string;
  msgA: string;
  msgB: string;
  delA: string;
  delB: string;
  recA: string;
  recB: string;
}

async function seed(): Promise<Fixture> {
  const partnerId = (await createPartner()).id;
  const orgA = (await createOrganization({ partnerId })).id;
  const orgB = (await createOrganization({ partnerId })).id;
  const siteA = (await createSite({ orgId: orgA }))!.id;
  const siteB = (await createSite({ orgId: orgB }))!.id;
  const devA = (await createDevice({ orgId: orgA, siteId: siteA })).id;
  const devB = (await createDevice({ orgId: orgB, siteId: siteB })).id;
  return sys(async () => {
    const [mA] = await db.insert(endpointMessages).values(messageValues(orgA)).returning({ id: endpointMessages.id });
    const [mB] = await db.insert(endpointMessages).values(messageValues(orgB)).returning({ id: endpointMessages.id });
    const [dA] = await db.insert(endpointMessageDeliveries)
      .values({ endpointMessageId: mA!.id, orgId: orgA, deviceId: devA, status: 'queued' })
      .returning({ id: endpointMessageDeliveries.id });
    const [dB] = await db.insert(endpointMessageDeliveries)
      .values({ endpointMessageId: mB!.id, orgId: orgB, deviceId: devB, status: 'queued' })
      .returning({ id: endpointMessageDeliveries.id });
    const [rA] = await db.insert(endpointMessageReceipts)
      .values({ deliveryId: dA!.id, orgId: orgA, deviceId: devA, sessionKey: 'S-1', eventType: 'displayed', occurredAt: new Date() })
      .returning({ id: endpointMessageReceipts.id });
    const [rB] = await db.insert(endpointMessageReceipts)
      .values({ deliveryId: dB!.id, orgId: orgB, deviceId: devB, sessionKey: 'S-1', eventType: 'displayed', occurredAt: new Date() })
      .returning({ id: endpointMessageReceipts.id });
    return {
      partnerId, orgA, orgB, siteA, siteB, devA, devB,
      msgA: mA!.id, msgB: mB!.id, delA: dA!.id, delB: dB!.id, recA: rA!.id, recB: rB!.id,
    };
  });
}

describe('endpoint messaging tables: RLS and tenant consistency', () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await seed();
  });

  it('org A cannot read org B messages, deliveries or receipts', async () => {
    const seen = await asOrg(f.orgA, f.partnerId, async () => ({
      messages: (await db.select({ id: endpointMessages.id }).from(endpointMessages)).map((r) => r.id),
      deliveries: (await db.select({ id: endpointMessageDeliveries.id }).from(endpointMessageDeliveries)).map((r) => r.id),
      receipts: (await db.select({ id: endpointMessageReceipts.id }).from(endpointMessageReceipts)).map((r) => r.id),
    }));
    expect(seen).toEqual({ messages: [f.msgA], deliveries: [f.delA], receipts: [f.recA] });
  });

  it('breeze_app cannot insert a message, delivery or receipt stamped with another org (42501)', async () => {
    expect(await pgCode(asOrg(f.orgA, f.partnerId, () =>
      db.insert(endpointMessages).values(messageValues(f.orgB))))).toBe('42501');
    expect(await pgCode(asOrg(f.orgA, f.partnerId, () =>
      db.insert(endpointMessageDeliveries).values({ endpointMessageId: f.msgB, orgId: f.orgB, deviceId: f.devB, status: 'queued' })))).toBe('42501');
    expect(await pgCode(asOrg(f.orgA, f.partnerId, () =>
      db.insert(endpointMessageReceipts).values({ deliveryId: f.delB, orgId: f.orgB, deviceId: f.devB, sessionKey: 'x', eventType: 'acknowledged', occurredAt: new Date() })))).toBe('42501');
  });

  it('org A cannot update or delete org B rows (zero rows touched)', async () => {
    await asOrg(f.orgA, f.partnerId, async () => {
      await db.update(endpointMessageDeliveries).set({ status: 'retracted' }).where(eq(endpointMessageDeliveries.id, f.delB));
      await db.delete(endpointMessages).where(eq(endpointMessages.id, f.msgB));
    });
    const [row] = await sys(() => db.select({ status: endpointMessageDeliveries.status }).from(endpointMessageDeliveries).where(eq(endpointMessageDeliveries.id, f.delB)));
    expect(row?.status).toBe('queued');
    const [msg] = await sys(() => db.select({ id: endpointMessages.id }).from(endpointMessages).where(eq(endpointMessages.id, f.msgB)));
    expect(msg?.id).toBe(f.msgB);
  });

  it('an authorized org A caller cannot attach org B ids: the consistency FKs reject it (23503)', async () => {
    // Own org stamp, foreign device.
    expect(await pgCode(asOrg(f.orgA, f.partnerId, () =>
      db.insert(endpointMessageDeliveries).values({ endpointMessageId: f.msgA, orgId: f.orgA, deviceId: f.devB, status: 'queued' })))).toBe('23503');
    // Own org stamp, foreign message.
    expect(await pgCode(asOrg(f.orgA, f.partnerId, () =>
      db.insert(endpointMessageDeliveries).values({ endpointMessageId: f.msgB, orgId: f.orgA, deviceId: f.devA, status: 'queued' })))).toBe('23503');
    // Own org stamp, foreign delivery.
    expect(await pgCode(asOrg(f.orgA, f.partnerId, () =>
      db.insert(endpointMessageReceipts).values({ deliveryId: f.delB, orgId: f.orgA, deviceId: f.devA, sessionKey: 's', eventType: 'acknowledged', occurredAt: new Date() })))).toBe('23503');
    // Own org stamp, own delivery, foreign device.
    expect(await pgCode(asOrg(f.orgA, f.partnerId, () =>
      db.insert(endpointMessageReceipts).values({ deliveryId: f.delA, orgId: f.orgA, deviceId: f.devB, sessionKey: 's', eventType: 'acknowledged', occurredAt: new Date() })))).toBe('23503');
  });

  it('dedupes receipts on (delivery, session, event)', async () => {
    const insert = () => sys(() => db.insert(endpointMessageReceipts)
      .values({ deliveryId: f.delA, orgId: f.orgA, deviceId: f.devA, sessionKey: 'S-1', eventType: 'displayed', occurredAt: new Date() })
      .onConflictDoNothing()
      .returning({ id: endpointMessageReceipts.id }));
    expect(await insert()).toEqual([]);
  });

  it('a purged message keeps no title/body and the check constraint forbids a half-purged row', async () => {
    await sys(() => db.update(endpointMessages)
      .set({ title: null, body: null, bodyPurgedAt: new Date() })
      .where(eq(endpointMessages.id, f.msgA)));
    expect(await pgCode(sys(() => db.update(endpointMessages)
      .set({ body: null })
      .where(eq(endpointMessages.id, f.msgB))))).toBe('23514');
  });

  it('moving a device detaches its deliveries from the source message; history follows the device; erasing the source org leaves it', async () => {
    const user = await createUser({ partnerId: f.partnerId, orgId: null, email: `move-${randomUUID()}@em.test` });

    await sys(() => db.transaction((tx) => moveDeviceOrgInTransaction(tx, {
      deviceId: f.devA,
      sourceOrgId: f.orgA,
      targetOrgId: f.orgB,
      targetSiteId: f.siteB,
      targetOrgName: 'target',
      deviceLinkGroupId: null,
      acceptCurrencyMismatch: false,
      actor: { userId: user.id, allowedSiteIds: undefined },
      stepUp: null,
      via: 'generic_move',
    })));

    const [delivery] = await sys(() => db.select().from(endpointMessageDeliveries).where(eq(endpointMessageDeliveries.id, f.delA)));
    expect(delivery).toMatchObject({ orgId: f.orgB, endpointMessageId: null, status: 'queued' });
    const [receipt] = await sys(() => db.select().from(endpointMessageReceipts).where(eq(endpointMessageReceipts.id, f.recA)));
    expect(receipt).toMatchObject({ orgId: f.orgB, deliveryId: f.delA });
    // The message (and its body) stays with the source org.
    const [msg] = await sys(() => db.select({ orgId: endpointMessages.orgId }).from(endpointMessages).where(eq(endpointMessages.id, f.msgA)));
    expect(msg?.orgId).toBe(f.orgA);
    // The destination org sees the delivery history but never the source body.
    const destView = await asOrg(f.orgB, f.partnerId, async () => ({
      deliveries: (await db.select({ id: endpointMessageDeliveries.id }).from(endpointMessageDeliveries)).map((r) => r.id).sort(),
      messages: (await db.select({ id: endpointMessages.id }).from(endpointMessages)).map((r) => r.id),
    }));
    expect(destView.deliveries).toEqual([f.delA, f.delB].sort());
    expect(destView.messages).toEqual([f.msgB]);

    // Source-org erasure of its messages leaves the moved device's history.
    await sys(() => db.delete(endpointMessages).where(eq(endpointMessages.orgId, f.orgA)));
    const [still] = await sys(() => db.select({ id: endpointMessageDeliveries.id }).from(endpointMessageDeliveries).where(eq(endpointMessageDeliveries.id, f.delA)));
    expect(still?.id).toBe(f.delA);
  }, 120_000);

  it('deleting a message cascades its deliveries and receipts', async () => {
    await sys(() => db.delete(endpointMessages).where(eq(endpointMessages.id, f.msgB)));
    const rows = await getTestDb().execute(sql`
      SELECT (SELECT count(*) FROM endpoint_message_deliveries WHERE id = ${f.delB}::uuid)::int AS d,
             (SELECT count(*) FROM endpoint_message_receipts WHERE id = ${f.recB}::uuid)::int AS r`);
    expect((rows as unknown as Array<{ d: number; r: number }>)[0]).toEqual({ d: 0, r: 0 });
  });
});
