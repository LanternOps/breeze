/**
 * Endpoint messaging W02 (#8742) against real Postgres: persistence commit
 * ordering, the notify_user result handler, receipts, retract, history reads
 * and the retention job. The unit suites mock these services; this file is
 * what proves the SQL.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { deviceCommands, endpointMessageDeliveries, endpointMessageReceipts, endpointMessages } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { attachDeliveryCommand, persistSend } from '../../services/endpointMessaging/persistence';
import { handleNotifyUserResult, handleRetractMessageResult } from '../../services/endpointMessaging/commandResults';
import { recordDeliveryEvent } from '../../services/endpointMessaging/receipts';
import { retractEndpointMessage } from '../../services/endpointMessaging/retract';
import { getEndpointMessageDetail, listEndpointMessages, resendTargets } from '../../services/endpointMessaging/history';
import { runEndpointMessageRetentionOnce } from '../../jobs/endpointMessageRetention';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { terminalPayloadErasureSet } from '../../services/sensitiveCommandPayload';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

function orgCtx(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: partnerId };
}
const asOrg = <T>(orgId: string, partnerId: string, fn: () => Promise<T>) =>
  runOutsideDbContext(() => withDbAccessContext(orgCtx(orgId, partnerId), fn));

function fakeAuth(userId: string, orgId: string): AuthContext {
  return {
    user: { id: userId, email: 'tech@example.test' },
    scope: 'organization',
    orgId,
    partnerId: null,
    accessibleOrgIds: [orgId],
    orgCondition: (col: PgColumn): SQL | undefined => eq(col, orgId),
    canAccessOrg: (id: string) => id === orgId,
  } as unknown as AuthContext;
}

interface Fixture {
  partnerId: string;
  orgA: string;
  orgB: string;
  siteA: string;
  devA1: string;
  devA2: string;
  devB: string;
  userId: string;
}

async function seed(): Promise<Fixture> {
  const partnerId = (await createPartner()).id;
  const orgA = (await createOrganization({ partnerId })).id;
  const orgB = (await createOrganization({ partnerId })).id;
  const siteA = (await createSite({ orgId: orgA }))!.id;
  const siteB = (await createSite({ orgId: orgB }))!.id;
  const devA1 = (await createDevice({ orgId: orgA, siteId: siteA })).id;
  const devA2 = (await createDevice({ orgId: orgA, siteId: siteA })).id;
  const devB = (await createDevice({ orgId: orgB, siteId: siteB })).id;
  const user = await createUser({ partnerId, orgId: null, email: `em-${randomUUID()}@em.test` });
  return { partnerId, orgA, orgB, siteA, devA1, devA2, devB, userId: user.id };
}

function sendInput(f: Fixture, over: Partial<Parameters<typeof persistSend>[0]> = {}): Parameters<typeof persistSend>[0] {
  return {
    batchId: randomUUID(),
    clientMessageId: randomUUID(),
    actorId: f.userId,
    targetMode: 'devices',
    targetSpec: { deviceIds: [f.devA1, f.devA2] },
    title: 'Reboot tonight',
    body: 'Please save your work.',
    bodySha256: 'b'.repeat(64),
    severity: 'warning',
    requiresAck: true,
    expiresAt: new Date(Date.now() + 3_600_000),
    orgGroups: [{ orgId: f.orgA, branding: { companyName: 'Acme' } }],
    devices: [
      { deviceId: f.devA1, orgId: f.orgA, status: 'queued' },
      { deviceId: f.devA2, orgId: f.orgA, status: 'failed', errorCode: 'agent_unsupported' },
    ],
    ...over,
  };
}

async function insertCommand(deviceId: string, payload: Record<string, unknown>, status = 'pending', type = 'notify_user'): Promise<string> {
  const [row] = await sys(() => db.insert(deviceCommands).values({ deviceId, type, payload, status }).returning({ id: deviceCommands.id }));
  return row!.id;
}

async function delivery(id: string) {
  const [row] = await sys(() => db.select().from(endpointMessageDeliveries).where(eq(endpointMessageDeliveries.id, id)));
  return row!;
}

describe('endpoint messaging W02 flow (real Postgres)', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await seed();
  });

  it('persistSend commits on its own: rows are visible to another connection while the caller transaction is still open', async () => {
    let seenFromOutside = -1;
    await asOrg(f.orgA, f.partnerId, async () => {
      const input = sendInput(f);
      const map = await persistSend(input);
      expect(map.size).toBe(2);
      // A different connection (system scope) sees them before this org
      // transaction ends: what a fast agent result needs.
      const rows = await getTestDb().execute(sql`SELECT count(*)::int AS n FROM endpoint_message_deliveries WHERE id IN (${sql.join([...map.values()].map((v) => sql`${v}::uuid`), sql`, `)})`);
      seenFromOutside = (rows as unknown as Array<{ n: number }>)[0]!.n;
    });
    expect(seenFromOutside).toBe(2);
  });

  it('notify_user result: delivered via the batch ids even before the command id was attached; failures map to a code', async () => {
    const input = sendInput(f);
    const map = await persistSend(input);
    const d1 = map.get(f.devA1)!;
    const payload = { source: 'endpoint_message', batchId: input.batchId, messageId: input.clientMessageId };
    const cmdId = await insertCommand(f.devA1, payload, 'completed');
    const command = (await sys(() => db.select().from(deviceCommands).where(eq(deviceCommands.id, cmdId))))[0]!;

    await asOrg(f.orgA, f.partnerId, () => handleNotifyUserResult({
      agentId: 'a', command, commandId: cmdId, resolvedDeviceId: f.devA1,
      result: { status: 'completed' } as never, stdout: JSON.stringify({ delivered: true, surface: 'assist' }),
    }));
    expect(await delivery(d1)).toMatchObject({ status: 'delivered', surface: 'assist', commandId: cmdId });

    // A second (other device) message fails with no helper.
    const input2 = sendInput(f, { devices: [{ deviceId: f.devA1, orgId: f.orgA, status: 'queued' }] });
    const map2 = await persistSend(input2);
    const cmd2 = await insertCommand(f.devA1, { source: 'endpoint_message', batchId: input2.batchId, messageId: input2.clientMessageId }, 'failed');
    const command2 = (await sys(() => db.select().from(deviceCommands).where(eq(deviceCommands.id, cmd2))))[0]!;
    await asOrg(f.orgA, f.partnerId, () => handleNotifyUserResult({
      agentId: 'a', command: command2, commandId: cmd2, resolvedDeviceId: f.devA1,
      result: { status: 'failed', error: 'no user helper connected' } as never, stdout: undefined,
    }));
    expect(await delivery(map2.get(f.devA1)!)).toMatchObject({ status: 'failed', errorCode: 'no_helper' });
  });

  it('a result from another device never touches this delivery', async () => {
    const input = sendInput(f);
    const map = await persistSend(input);
    const payload = { source: 'endpoint_message', batchId: input.batchId, messageId: input.clientMessageId };
    const cmdId = await insertCommand(f.devB, payload, 'completed');
    const command = (await sys(() => db.select().from(deviceCommands).where(eq(deviceCommands.id, cmdId))))[0]!;
    await sys(() => handleNotifyUserResult({
      agentId: 'b', command, commandId: cmdId, resolvedDeviceId: f.devB,
      result: { status: 'completed' } as never, stdout: '{}',
    }));
    expect((await delivery(map.get(f.devA1)!)).status).toBe('queued');
  });

  it('receipts: dedupe on (delivery, session, event), aggregate to acknowledged, no regression, foreign device not found', async () => {
    const input = sendInput(f);
    const map = await persistSend(input);
    const d1 = map.get(f.devA1)!;
    const cmdId = await insertCommand(f.devA1, { source: 'endpoint_message', batchId: input.batchId, messageId: input.clientMessageId }, 'sent');
    const ev = (eventType: 'displayed' | 'acknowledged' | 'dismissed', sessionKey = 'S-1') => asOrg(f.orgA, f.partnerId, () => recordDeliveryEvent({
      deviceId: f.devA1, commandId: cmdId, batchId: input.batchId, messageId: input.clientMessageId,
      sessionKey, sessionUsername: 'alice', eventType, occurredAt: new Date(),
    }));

    expect(await ev('displayed')).toEqual({ found: true, inserted: true });
    expect(await ev('displayed')).toEqual({ found: true, inserted: false });
    expect((await delivery(d1)).status).toBe('displayed');
    expect(await ev('acknowledged')).toEqual({ found: true, inserted: true });
    expect(await ev('acknowledged', 'S-2')).toEqual({ found: true, inserted: true });
    // A later dismiss from another session is a receipt only; the aggregate stays.
    expect(await ev('dismissed', 'S-3')).toEqual({ found: true, inserted: true });
    const row = await delivery(d1);
    expect(row.status).toBe('acknowledged');
    expect(row.acknowledgedAt).not.toBeNull();
    const receipts = await sys(() => db.select().from(endpointMessageReceipts).where(eq(endpointMessageReceipts.deliveryId, d1)));
    expect(receipts).toHaveLength(4);

    // Device B naming device A's message finds nothing.
    const foreign = await asOrg(f.orgB, f.partnerId, () => recordDeliveryEvent({
      deviceId: f.devB, commandId: cmdId, batchId: input.batchId, messageId: input.clientMessageId,
      sessionKey: 'S-9', sessionUsername: 'mallory', eventType: 'acknowledged', occurredAt: new Date(),
    }));
    expect(foreign).toEqual({ found: false });
  });

  it('retract: a pending command is cancelled and its payload erased; an old agent is agent_unsupported; repeat is idempotent', async () => {
    const input = sendInput(f, {
      devices: [
        { deviceId: f.devA1, orgId: f.orgA, status: 'queued' },
        { deviceId: f.devA2, orgId: f.orgA, status: 'queued' },
      ],
    });
    const map = await persistSend(input);
    const pending = await insertCommand(f.devA1, { source: 'endpoint_message', title: 'T', body: 'secret body', batchId: input.batchId, messageId: input.clientMessageId }, 'pending');
    const sent = await insertCommand(f.devA2, { source: 'endpoint_message', batchId: input.batchId, messageId: input.clientMessageId }, 'sent');
    await sys(() => db.update(endpointMessageDeliveries).set({ commandId: pending }).where(eq(endpointMessageDeliveries.id, map.get(f.devA1)!)));
    await sys(() => db.update(endpointMessageDeliveries).set({ commandId: sent, status: 'delivered' }).where(eq(endpointMessageDeliveries.id, map.get(f.devA2)!)));
    const [msg] = await sys(() => db.select({ id: endpointMessages.id }).from(endpointMessages).where(eq(endpointMessages.batchId, input.batchId)));

    const auth = fakeAuth(f.userId, f.orgA);
    const first = await asOrg(f.orgA, f.partnerId, () => retractEndpointMessage({ auth, messageRowId: msg!.id }));
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.alreadyRetracted).toBe(false);
    expect(first.results).toEqual(expect.arrayContaining([
      { deviceId: f.devA1, status: 'retracted', via: 'cancelled' },
      { deviceId: f.devA2, status: 'failed', errorCode: 'agent_unsupported' },
    ]));
    expect((await delivery(map.get(f.devA1)!)).status).toBe('retracted');
    expect((await delivery(map.get(f.devA2)!)).status).toBe('delivered');
    const [cmdRow] = await sys(() => db.select().from(deviceCommands).where(eq(deviceCommands.id, pending)));
    expect(cmdRow!.status).toBe('cancelled');
    expect(JSON.stringify(cmdRow!.payload)).not.toContain('secret body');

    const again = await asOrg(f.orgA, f.partnerId, () => retractEndpointMessage({ auth, messageRowId: msg!.id }));
    expect(again).toMatchObject({ kind: 'ok', alreadyRetracted: true });

    // Another org's caller cannot see it.
    const foreign = await asOrg(f.orgB, f.partnerId, () => retractEndpointMessage({ auth: fakeAuth(f.userId, f.orgB), messageRowId: msg!.id }));
    expect(foreign).toEqual({ kind: 'not_found' });
  });

  it('retract queues retract_message for a capable agent whose card may be on screen', async () => {
    await sys(() => db.execute(sql`UPDATE devices SET agent_version = '999.0.0' WHERE id = ${f.devA1}::uuid`));
    const input = sendInput(f, { devices: [{ deviceId: f.devA1, orgId: f.orgA, status: 'queued' }] });
    const map = await persistSend(input);
    const sent = await insertCommand(f.devA1, { source: 'endpoint_message', batchId: input.batchId, messageId: input.clientMessageId }, 'sent');
    await sys(() => db.update(endpointMessageDeliveries).set({ commandId: sent, status: 'displayed' }).where(eq(endpointMessageDeliveries.id, map.get(f.devA1)!)));
    const [msg] = await sys(() => db.select({ id: endpointMessages.id }).from(endpointMessages).where(eq(endpointMessages.batchId, input.batchId)));

    const out = await asOrg(f.orgA, f.partnerId, () => retractEndpointMessage({ auth: fakeAuth(f.userId, f.orgA), messageRowId: msg!.id }));
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.results[0]).toMatchObject({ deviceId: f.devA1, status: 'retracted', via: 'command' });
    const row = await delivery(map.get(f.devA1)!);
    expect(row.status).toBe('retracted');
    const [retractCmd] = await sys(() => db.select().from(deviceCommands).where(eq(deviceCommands.id, row.retractCommandId!)));
    expect(retractCmd).toMatchObject({ type: 'retract_message', deviceId: f.devA1 });
    expect(retractCmd!.payload).toEqual({ messageId: input.clientMessageId });
  });

  it('review fixes: a queued delivery with no command yet is retracted without a command, and the send then refuses to attach', async () => {
    const input = sendInput(f, { devices: [{ deviceId: f.devA1, orgId: f.orgA, status: 'queued' }] });
    const map = await persistSend(input);
    const d1 = map.get(f.devA1)!;
    const [msg] = await sys(() => db.select({ id: endpointMessages.id }).from(endpointMessages).where(eq(endpointMessages.batchId, input.batchId)));
    const out = await asOrg(f.orgA, f.partnerId, () => retractEndpointMessage({ auth: fakeAuth(f.userId, f.orgA), messageRowId: msg!.id }));
    expect(out).toMatchObject({ kind: 'ok', results: [{ deviceId: f.devA1, status: 'retracted', via: 'not_sent' }] });
    // The in-flight send now queues its command: attach reports the retraction.
    const cmd = await insertCommand(f.devA1, { source: 'endpoint_message', batchId: input.batchId, messageId: input.clientMessageId }, 'pending');
    expect(await attachDeliveryCommand(d1, cmd)).toBe('retracted');
    expect((await delivery(d1)).status).toBe('retracted');
  });

  it('review fixes: a site-restricted caller cannot retract a message reaching devices outside their sites', async () => {
    const input = sendInput(f);
    await persistSend(input);
    const [msg] = await sys(() => db.select().from(endpointMessages).where(eq(endpointMessages.batchId, input.batchId)));
    const out = await asOrg(f.orgA, f.partnerId, () => retractEndpointMessage({
      auth: fakeAuth(f.userId, f.orgA), permissions: { allowedSiteIds: [randomUUID()] }, messageRowId: msg!.id,
    }));
    expect(out).toEqual({ kind: 'forbidden' });
    const [after] = await sys(() => db.select().from(endpointMessages).where(eq(endpointMessages.id, msg!.id)));
    expect(after!.retractedAt).toBeNull();
  });

  it('review fixes: resend targets exclude devices that saw the card or were already resent', async () => {
    const input = sendInput(f, {
      devices: [
        { deviceId: f.devA1, orgId: f.orgA, status: 'failed', errorCode: 'no_helper' },
        { deviceId: f.devA2, orgId: f.orgA, status: 'queued' },
      ],
    });
    const map = await persistSend(input);
    // devA2 was displayed, then expired: the user saw it.
    await sys(() => db.update(endpointMessageDeliveries).set({ status: 'expired', displayedAt: new Date() }).where(eq(endpointMessageDeliveries.id, map.get(f.devA2)!)));
    const [msg] = await sys(() => db.select({ id: endpointMessages.id }).from(endpointMessages).where(eq(endpointMessages.batchId, input.batchId)));
    expect(await asOrg(f.orgA, f.partnerId, () => resendTargets(msg!.id))).toEqual([f.devA1]);
    // Once devA1 is covered by a resend, a second resend reaches nobody.
    await persistSend(sendInput(f, { resendOfId: msg!.id, devices: [{ deviceId: f.devA1, orgId: f.orgA, status: 'queued' }] }));
    expect(await asOrg(f.orgA, f.partnerId, () => resendTargets(msg!.id))).toEqual([]);
  });

  it('review fixes: a failed retract_message result is recorded on the delivery', async () => {
    const input = sendInput(f, { devices: [{ deviceId: f.devA1, orgId: f.orgA, status: 'queued' }] });
    const map = await persistSend(input);
    const retractCmd = await insertCommand(f.devA1, { messageId: input.clientMessageId }, 'failed', 'retract_message');
    await sys(() => db.update(endpointMessageDeliveries).set({ status: 'retracted', retractCommandId: retractCmd }).where(eq(endpointMessageDeliveries.id, map.get(f.devA1)!)));
    const command = (await sys(() => db.select().from(deviceCommands).where(eq(deviceCommands.id, retractCmd))))[0]!;
    await asOrg(f.orgA, f.partnerId, () => handleRetractMessageResult({
      agentId: 'a', command, commandId: retractCmd, resolvedDeviceId: f.devA1,
      result: { status: 'failed', error: 'could not reach the assist helper to retract the message' } as never, stdout: undefined,
    }));
    expect((await delivery(map.get(f.devA1)!)).errorCode).toBe('retract_failed');
  });

  it('history: list counts statuses per batch for the caller org only; detail carries deliveries and receipts', async () => {
    const input = sendInput(f);
    await persistSend(input);
    await persistSend(sendInput(f, {
      orgGroups: [{ orgId: f.orgB, branding: {} }],
      devices: [{ deviceId: f.devB, orgId: f.orgB, status: 'queued' }],
    }));
    const auth = fakeAuth(f.userId, f.orgA);
    const page = await asOrg(f.orgA, f.partnerId, () => listEndpointMessages({ auth, limit: 10 }));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ orgId: f.orgA, deviceCount: 2, statusCounts: { queued: 1, failed: 1 }, title: 'Reboot tonight' });

    const detail = await asOrg(f.orgA, f.partnerId, () => getEndpointMessageDetail({ auth, messageRowId: page.items[0]!.id }));
    expect(detail?.deliveries.map((d) => d.deviceId).sort()).toEqual([f.devA1, f.devA2].sort());
    expect(detail?.body).toBe('Please save your work.');

    // A site-restricted caller with no matching site sees no deliveries.
    const restricted = await asOrg(f.orgA, f.partnerId, () => getEndpointMessageDetail({
      auth, permissions: { allowedSiteIds: [randomUUID()] }, messageRowId: page.items[0]!.id,
    }));
    expect(restricted?.deliveries).toEqual([]);
  });

  it('a queued (non-terminal) notify_user keeps its body through claim-for-delivery; terminal erasure strips it', async () => {
    const cmdId = await insertCommand(f.devA1, {
      source: 'endpoint_message', title: 'Reboot tonight', body: 'Body still needed for delivery', messageId: randomUUID(), batchId: randomUUID(),
    }, 'pending');
    await sys(() => db.execute(sql`UPDATE device_commands SET submitted_org_id = ${f.orgA}::uuid WHERE id = ${cmdId}::uuid`));
    const claimed = await sys(() => claimPendingCommandsForDevice(f.devA1));
    const mine = claimed.find((c) => c.id === cmdId);
    expect(mine, 'the pending message must be claimable').toBeDefined();
    expect((mine!.payload as Record<string, unknown>).body).toBe('Body still needed for delivery');
    const [stored] = await sys(() => db.select().from(deviceCommands).where(eq(deviceCommands.id, cmdId)));
    expect(stored!.status).toBe('sent');
    expect((stored!.payload as Record<string, unknown>).body).toBe('Body still needed for delivery');

    await sys(() => db.update(deviceCommands)
      .set({ status: 'completed', completedAt: new Date(), ...terminalPayloadErasureSet() })
      .where(eq(deviceCommands.id, cmdId)));
    const [done] = await sys(() => db.select().from(deviceCommands).where(eq(deviceCommands.id, cmdId)));
    expect(done!.payload).not.toHaveProperty('body');
    expect(done!.payload).not.toHaveProperty('title');
    expect(done!.payload).toHaveProperty('messageId');
  });

  it('retention: purges bodies after 90 days, expires past-expiry live deliveries, deletes 13-month history, leaves recent rows', async () => {
    const old = sendInput(f);
    const oldMap = await persistSend(old);
    const recent = sendInput(f, { expiresAt: new Date(Date.now() - 60_000) });
    const recentMap = await persistSend(recent);
    const ancient = sendInput(f);
    await persistSend(ancient);
    await sys(() => db.execute(sql`UPDATE endpoint_messages SET created_at = now() - interval '91 days' WHERE batch_id = ${old.batchId}::uuid`));
    await sys(() => db.execute(sql`UPDATE endpoint_messages SET created_at = now() - interval '14 months' WHERE batch_id = ${ancient.batchId}::uuid`));

    const result = await runEndpointMessageRetentionOnce();
    expect(result.bodiesPurged).toBeGreaterThanOrEqual(1);
    expect(result.deliveriesExpired).toBeGreaterThanOrEqual(1);
    expect(result.messagesDeleted).toBe(1);

    const [oldMsg] = await sys(() => db.select().from(endpointMessages).where(eq(endpointMessages.batchId, old.batchId)));
    expect(oldMsg).toMatchObject({ title: null, body: null });
    expect(oldMsg!.bodyPurgedAt).not.toBeNull();
    expect(oldMsg!.bodySha256).toBe('b'.repeat(64));
    expect(await sys(() => db.select().from(endpointMessages).where(eq(endpointMessages.batchId, ancient.batchId)))).toEqual([]);
    expect((await delivery(recentMap.get(f.devA1)!)).status).toBe('expired');
    // Terminal rows are not touched by the expiry pass.
    expect((await delivery(recentMap.get(f.devA2)!)).status).toBe('failed');
    // The 91-day-old message's deliveries (not past their own expiry) are kept.
    expect((await delivery(oldMap.get(f.devA1)!)).status).toBe('queued');

    const second = await runEndpointMessageRetentionOnce();
    expect(second).toEqual({ bodiesPurged: 0, deliveriesExpired: 0, messagesDeleted: 0, detachedDeliveriesDeleted: 0 });
    void and;
  });
});
