/**
 * Block hours W02 (#8181, Open Decision 11 A): org moves refuse block-drawn
 * time. Without the guard the composite (contract_line_id, org_id) FK fails the
 * move at commit with 23503; with it both movers answer a clean 409
 * HOUR_BLOCK_DRAWN_TIME and nothing moves. Time that is only HELD (not yet
 * drawn) still moves.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { devices, tickets, timeEntries } from '../../db/schema';
import { generateDueInvoice } from '../../services/contractService';
import { moveTicketOrg } from '../../services/ticketService';
import { moveDeviceOrgInTransaction } from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import { createOrganization, createSite } from './db-utils';
import { seedBlockFixture, seedEntry, type BlockFixture } from './hourBlockFixtures';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

async function seedTarget(f: BlockFixture) {
  return sys(async () => {
    const org = await createOrganization({ partnerId: f.partnerId });
    const site = await createSite({ orgId: org.id });
    return { orgId: org.id, siteId: site!.id };
  });
}

async function seedTicket(f: BlockFixture, deviceId: string | null = null) {
  const [t] = await sys(() => db.insert(tickets).values({
    orgId: f.orgId, partnerId: f.partnerId, ticketNumber: `HB-${randomUUID()}`,
    subject: 'Block hours move', source: 'portal', deviceId,
  }).returning({ id: tickets.id }));
  return t!.id;
}

async function seedDevice(f: BlockFixture) {
  return sys(async () => {
    const site = await createSite({ orgId: f.orgId });
    const sfx = randomUUID().slice(0, 8);
    const [d] = await db.insert(devices).values({
      orgId: f.orgId, siteId: site!.id, agentId: `hb-${sfx}`, hostname: `hb-${sfx}`,
      osType: 'windows', osVersion: '10.0', architecture: 'x64', agentVersion: '0.1.0',
    }).returning({ id: devices.id });
    return d!.id;
  });
}

async function drawFor(f: BlockFixture, entryId: string) {
  await sys(() => db.update(timeEntries).set({ billingStatus: 'contract', contractLineId: f.blockLineId })
    .where(eq(timeEntries.id, entryId)));
}

const actorOf = (f: BlockFixture) => ({ kind: 'user' as const, userId: f.userId });

async function orgOfTicket(id: string) {
  const [t] = await sys(() => db.select({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.id, id)));
  return t!.orgId;
}

async function entryRow(id: string) {
  const [r] = await sys(() => db.select({ orgId: timeEntries.orgId, s: timeEntries.billingStatus, l: timeEntries.contractLineId })
    .from(timeEntries).where(eq(timeEntries.id, id)));
  return r!;
}

function moveDevice(f: BlockFixture, deviceId: string, target: { orgId: string; siteId: string }) {
  return sys(() => db.transaction((tx) => moveDeviceOrgInTransaction(tx, {
    deviceId, sourceOrgId: f.orgId, targetOrgId: target.orgId, targetSiteId: target.siteId,
    targetOrgName: 'target', deviceLinkGroupId: null, acceptCurrencyMismatch: false,
    actor: { userId: f.userId, allowedSiteIds: undefined }, stepUp: null, via: 'generic_move',
  })));
}

describe('org moves and block-drawn time (real DB) #8181', () => {
  it('refuses a ticket move when the ticket carries block-drawn time; nothing moves', async () => {
    const f = await seedBlockFixture();
    const target = await seedTarget(f);
    const ticketId = await seedTicket(f);
    const e = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z', ticketId });
    await drawFor(f, e);
    await expect(sys(() => moveTicketOrg(ticketId, target.orgId, actorOf(f))))
      .rejects.toMatchObject({ status: 409, code: 'HOUR_BLOCK_DRAWN_TIME', details: { drawnTimeEntries: 1 } });
    expect(await orgOfTicket(ticketId)).toBe(f.orgId);
    expect(await entryRow(e)).toEqual({ orgId: f.orgId, s: 'contract', l: f.blockLineId });
  });

  it('still moves a ticket whose time is only held (not yet drawn)', async () => {
    const f = await seedBlockFixture();
    const target = await seedTarget(f);
    const ticketId = await seedTicket(f);
    const e = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z', ticketId });
    await sys(() => moveTicketOrg(ticketId, target.orgId, actorOf(f)));
    expect(await orgOfTicket(ticketId)).toBe(target.orgId);
    expect((await entryRow(e)).orgId).toBe(target.orgId);
  });

  it('refuses a device move when a ticket bound to the device carries block-drawn time', async () => {
    const f = await seedBlockFixture();
    const target = await seedTarget(f);
    const deviceId = await seedDevice(f);
    const ticketId = await seedTicket(f, deviceId);
    const e = await seedEntry(f, { minutes: 45, endedAt: '2026-07-10T12:00:00Z', ticketId });
    await drawFor(f, e);
    await expect(moveDevice(f, deviceId, target))
      .rejects.toMatchObject({ status: 409, code: 'HOUR_BLOCK_DRAWN_TIME', details: { drawnTimeEntries: 1 } });
    const [d] = await sys(() => db.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, deviceId)));
    expect(d!.orgId).toBe(f.orgId);
    expect(await entryRow(e)).toEqual({ orgId: f.orgId, s: 'contract', l: f.blockLineId });
  });

  it('ordered: a ticket move that commits first leaves the moved entry out of the source org\'s close', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    const target = await seedTarget(f);
    const ticketId = await seedTicket(f);
    const e = await seedEntry(f, { minutes: 60, endedAt: '2026-07-15T12:00:00Z', ticketId });
    await sys(() => moveTicketOrg(ticketId, target.orgId, actorOf(f)));
    const r = await sys(() => generateDueInvoice(f.contractId, new Date('2026-08-01T06:00:00Z')));
    expect(r.hourBlockCloses).toMatchObject([{ entryCount: 0, consumedHours: 0 }]);
    expect(await entryRow(e)).toEqual({ orgId: target.orgId, s: 'not_billed', l: null });
  });

  it('ordered: once a close drew the entry, the move is refused', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    const target = await seedTarget(f);
    const ticketId = await seedTicket(f);
    const e = await seedEntry(f, { minutes: 60, endedAt: '2026-07-15T12:00:00Z', ticketId });
    await sys(() => generateDueInvoice(f.contractId, new Date('2026-08-01T06:00:00Z')));
    await expect(sys(() => moveTicketOrg(ticketId, target.orgId, actorOf(f))))
      .rejects.toMatchObject({ status: 409, code: 'HOUR_BLOCK_DRAWN_TIME' });
    expect(await entryRow(e)).toEqual({ orgId: f.orgId, s: 'contract', l: f.blockLineId });
  });

  it('a ticket move racing a block close: a clean move or a clean 409, never 23503 / 40P01', async () => {
    for (let i = 0; i < 3; i++) {
      const f = await seedBlockFixture({ timing: 'arrears' });
      const target = await seedTarget(f);
      const ticketId = await seedTicket(f);
      const e = await seedEntry(f, { minutes: 60, endedAt: '2026-07-15T12:00:00Z', ticketId });
      const [move, close] = await Promise.allSettled([
        sys(() => moveTicketOrg(ticketId, target.orgId, actorOf(f))),
        sys(() => generateDueInvoice(f.contractId, new Date('2026-08-01T06:00:00Z'))),
      ]);
      expect(close.status, String((close as PromiseRejectedResult).reason)).toBe('fulfilled');
      const row = await entryRow(e);
      if (move.status === 'fulfilled') {
        // Moved first: the close re-evaluated org_id after the move and skipped it.
        expect(row).toEqual({ orgId: target.orgId, s: 'not_billed', l: null });
      } else {
        expect(move.reason).toMatchObject({ status: 409, code: 'HOUR_BLOCK_DRAWN_TIME' });
        expect(row).toEqual({ orgId: f.orgId, s: 'contract', l: f.blockLineId });
      }
    }
  });
});
