/**
 * Endpoint live chat tables (#8743, W03 of #8740): RLS + tenant-consistency
 * contract. Migration: 2026-12-30-130100-endpoint-conversations.sql.
 *
 * Both tables are shape 5 (device-scoped, denormalized org_id, direct
 * breeze_has_org_access(org_id) policy). Runs through the real postgres.js
 * driver as `breeze_app`: a cross-tenant forge is refused by RLS (42501), and
 * an authorized caller naming another org's device or conversation is refused
 * by the composite tenant FKs (23503).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { endpointConversationMessages, endpointConversations } from '../../db/schema';
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

async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code;
  }
}

function conversationValues(orgId: string, deviceId: string, status: 'opening' | 'open' | 'closed' = 'open') {
  return { orgId, deviceId, status, allowUserReply: true };
}

function messageValues(orgId: string, deviceId: string, conversationId: string, direction: 'to_user' | 'from_user' = 'to_user') {
  return {
    conversationId,
    orgId,
    deviceId,
    direction,
    body: 'Hi, this is IT. Do you have a minute?',
    bodyLength: 37,
    clientNonce: randomUUID(),
  };
}

interface Fixture {
  partnerId: string;
  orgA: string;
  orgB: string;
  siteB: string;
  devA: string;
  devB: string;
  convA: string;
  convB: string;
  msgA: string;
  msgB: string;
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
    const [cA] = await db.insert(endpointConversations).values(conversationValues(orgA, devA)).returning({ id: endpointConversations.id });
    const [cB] = await db.insert(endpointConversations).values(conversationValues(orgB, devB)).returning({ id: endpointConversations.id });
    const [mA] = await db.insert(endpointConversationMessages).values(messageValues(orgA, devA, cA!.id)).returning({ id: endpointConversationMessages.id });
    const [mB] = await db.insert(endpointConversationMessages).values(messageValues(orgB, devB, cB!.id)).returning({ id: endpointConversationMessages.id });
    return { partnerId, orgA, orgB, siteB, devA, devB, convA: cA!.id, convB: cB!.id, msgA: mA!.id, msgB: mB!.id };
  });
}

describe('endpoint chat tables: RLS and tenant consistency', () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await seed();
  });

  it('org A cannot read org B conversations or messages', async () => {
    const seen = await asOrg(f.orgA, f.partnerId, async () => ({
      conversations: (await db.select({ id: endpointConversations.id }).from(endpointConversations)).map((r) => r.id),
      messages: (await db.select({ id: endpointConversationMessages.id }).from(endpointConversationMessages)).map((r) => r.id),
    }));
    expect(seen).toEqual({ conversations: [f.convA], messages: [f.msgA] });
  });

  it('breeze_app cannot insert a conversation or message stamped with another org (42501)', async () => {
    expect(await pgCode(asOrg(f.orgA, f.partnerId, () =>
      db.insert(endpointConversations).values(conversationValues(f.orgB, f.devB, 'closed'))))).toBe('42501');
    expect(await pgCode(asOrg(f.orgA, f.partnerId, () =>
      db.insert(endpointConversationMessages).values(messageValues(f.orgB, f.devB, f.convB))))).toBe('42501');
  });

  it('org A cannot update or delete org B rows (zero rows touched)', async () => {
    await asOrg(f.orgA, f.partnerId, async () => {
      await db.update(endpointConversations).set({ status: 'closed' }).where(eq(endpointConversations.id, f.convB));
      await db.delete(endpointConversationMessages).where(eq(endpointConversationMessages.id, f.msgB));
    });
    const [conv] = await sys(() => db.select({ status: endpointConversations.status }).from(endpointConversations).where(eq(endpointConversations.id, f.convB)));
    expect(conv?.status).toBe('open');
    const [msg] = await sys(() => db.select({ id: endpointConversationMessages.id }).from(endpointConversationMessages).where(eq(endpointConversationMessages.id, f.msgB)));
    expect(msg?.id).toBe(f.msgB);
  });

  it('an authorized org A caller cannot attach org B ids: the consistency FKs reject it (23503)', async () => {
    // Own org stamp, foreign device (checked at COMMIT: the FK is DEFERRED).
    expect(await pgCode(asOrg(f.orgA, f.partnerId, () =>
      db.insert(endpointConversations).values(conversationValues(f.orgA, f.devB, 'closed'))))).toBe('23503');
    // Own org stamp, foreign conversation.
    expect(await pgCode(asOrg(f.orgA, f.partnerId, () =>
      db.insert(endpointConversationMessages).values(messageValues(f.orgA, f.devA, f.convB))))).toBe('23503');
    // Own org stamp, own conversation, foreign device.
    expect(await pgCode(asOrg(f.orgA, f.partnerId, () =>
      db.insert(endpointConversationMessages).values(messageValues(f.orgA, f.devB, f.convA))))).toBe('23503');
  });

  it('dedupes a message on (conversation, client_nonce) and allows a second distinct reply', async () => {
    const nonce = randomUUID();
    const insert = () => sys(() => db.insert(endpointConversationMessages)
      .values({ ...messageValues(f.orgA, f.devA, f.convA, 'from_user'), clientNonce: nonce })
      .onConflictDoNothing()
      .returning({ id: endpointConversationMessages.id }));
    expect(await insert()).toHaveLength(1);
    expect(await insert()).toEqual([]);
    expect(await sys(() => db.insert(endpointConversationMessages)
      .values(messageValues(f.orgA, f.devA, f.convA, 'from_user'))
      .returning({ id: endpointConversationMessages.id }))).toHaveLength(1);
  });

  it('allows at most one opening/open conversation per device (23505), any number closed', async () => {
    expect(await pgCode(sys(() => db.insert(endpointConversations).values(conversationValues(f.orgA, f.devA, 'opening'))))).toBe('23505');
    await sys(() => db.insert(endpointConversations).values(conversationValues(f.orgA, f.devA, 'closed')));
    await sys(() => db.insert(endpointConversations).values(conversationValues(f.orgA, f.devA, 'closed')));
  });

  it('rejects an unknown status, direction or channel (23514) and a half-purged message', async () => {
    expect(await pgCode(sys(() => db.insert(endpointConversations).values({ ...conversationValues(f.orgA, f.devA), status: 'bogus' as 'open' })))).toBe('23514');
    expect(await pgCode(sys(() => db.insert(endpointConversationMessages).values({ ...messageValues(f.orgA, f.devA, f.convA), direction: 'sideways' as 'to_user' })))).toBe('23514');
    expect(await pgCode(sys(() => db.update(endpointConversationMessages).set({ body: null }).where(eq(endpointConversationMessages.id, f.msgA))))).toBe('23514');
    await sys(() => db.update(endpointConversationMessages).set({ body: null, bodyPurgedAt: new Date() }).where(eq(endpointConversationMessages.id, f.msgA)));
  });

  it('moving a device carries its chat history to the target org and ends an open conversation', async () => {
    const user = await createUser({ partnerId: f.partnerId, orgId: null, email: `move-${randomUUID()}@ec.test` });
    const closedBefore = await sys(async () => {
      const [c] = await db.insert(endpointConversations).values(conversationValues(f.orgA, f.devA, 'closed')).returning({ id: endpointConversations.id });
      return c!.id;
    });

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

    const [conv] = await sys(() => db.select().from(endpointConversations).where(eq(endpointConversations.id, f.convA)));
    expect(conv).toMatchObject({ orgId: f.orgB, status: 'closed', closeReason: 'device_moved' });
    expect(conv?.closedAt).toBeInstanceOf(Date);
    const [older] = await sys(() => db.select().from(endpointConversations).where(eq(endpointConversations.id, closedBefore)));
    expect(older).toMatchObject({ orgId: f.orgB, status: 'closed', closeReason: null });
    const [msg] = await sys(() => db.select().from(endpointConversationMessages).where(eq(endpointConversationMessages.id, f.msgA)));
    expect(msg).toMatchObject({ orgId: f.orgB, conversationId: f.convA });
    const sourceView = await asOrg(f.orgA, f.partnerId, async () =>
      (await db.select({ id: endpointConversations.id }).from(endpointConversations)).map((r) => r.id));
    expect(sourceView).toEqual([]);
  }, 120_000);

  it('deleting a conversation cascades its messages', async () => {
    await sys(() => db.delete(endpointConversations).where(eq(endpointConversations.id, f.convB)));
    const rows = await getTestDb().execute(sql`
      SELECT (SELECT count(*) FROM endpoint_conversation_messages WHERE id = ${f.msgB}::uuid)::int AS m`);
    expect((rows as unknown as Array<{ m: number }>)[0]).toEqual({ m: 0 });
  });
});
