/**
 * ticket_links on BOTH org movers (#7900, feature #8592 W02, approved
 * decision 10: delete links touching the moved ticket, note it on the
 * surviving ticket).
 *
 * A link has two ticket legs sharing one org_id, enforced by two composite
 * (ticket_id, org_id) -> tickets(id, org_id) FKs, so a link cannot follow one
 * of its tickets into another org. Both movers therefore DELETE every link
 * touching a moved ticket, with both FKs deferred BY NAME — mandatory on the
 * device axis, where breeze_cascade_device_org_id() re-stamps tickets.org_id
 * inside the devices UPDATE, long before the mover's child tail runs. The
 * counterpart note is written AFTER the move commits (a comment re-stamps its
 * parent ticket's feed column, i.e. takes that ticket's row lock, which inside
 * the move would let two concurrent moves of linked tickets wait on each
 * other).
 *
 * Runs the REAL moveTicketOrg and the REAL moveDeviceOrgInTransaction.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { devices, ticketComments, ticketLinks, tickets } from '../../db/schema';
import { moveTicketOrg } from '../../services/ticketService';
import { moveDeviceOrgInTransaction } from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import { noteTicketLinksRemovedByOrgMove } from '../../services/ticketLinkMoveNotes';
import { lockOrgTicketLinks } from '../../services/ticketLinkLock';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

interface Fixture {
  partnerId: string;
  orgX: string;
  orgY: string;
  siteY: string;
  userId: string;
  deviceId: string;
  /** A and C are bound to the device; B is deviceless. All in org X. */
  A: { id: string; number: string };
  B: { id: string; number: string };
  C: { id: string; number: string };
}

async function seed(): Promise<Fixture> {
  return sys(async () => {
    const sfx = randomUUID().slice(0, 8);
    const partner = await createPartner();
    const orgX = await createOrganization({ partnerId: partner.id });
    const orgY = await createOrganization({ partnerId: partner.id });
    const siteX = await createSite({ orgId: orgX.id });
    const siteY = await createSite({ orgId: orgY.id });
    const user = await createUser({ partnerId: partner.id, orgId: null, email: `lnk-move-${sfx}@example.test` });
    const [device] = await db.insert(devices).values({
      orgId: orgX.id, siteId: siteX!.id, agentId: `lnk-${sfx}`, hostname: `lnk-${sfx}`,
      osType: 'windows', osVersion: '10.0', architecture: 'x64', agentVersion: '0.1.0',
    }).returning({ id: devices.id });
    const mk = async (n: string, deviceId: string | null) => {
      const internalNumber = `LM${n}-${sfx}`;
      const [t] = await db.insert(tickets).values({
        orgId: orgX.id, partnerId: partner.id, ticketNumber: `LNKMV-${n}-${sfx}`, internalNumber,
        subject: `link move ${n}`, source: 'manual', deviceId,
      }).returning({ id: tickets.id });
      return { id: t!.id, number: internalNumber };
    };
    return {
      partnerId: partner.id, orgX: orgX.id, orgY: orgY.id, siteY: siteY!.id, userId: user.id,
      deviceId: device!.id,
      A: await mk('A', device!.id), B: await mk('B', null), C: await mk('C', device!.id),
    };
  });
}

async function link(f: Fixture, source: string, target: string, linkType: 'caused_by' | 'resolves' | 'related' | 'duplicate_of') {
  const [s, t] = linkType === 'related' && source > target ? [target, source] : [source, target];
  await sys(() => db.insert(ticketLinks).values({ orgId: f.orgX, sourceTicketId: s, targetTicketId: t, linkType }));
}

async function linksTouching(ids: string[]) {
  return sys(() => db.select().from(ticketLinks)
    .where(or(inArray(ticketLinks.sourceTicketId, ids), inArray(ticketLinks.targetTicketId, ids))));
}

async function removalNotes(ticketId: string) {
  const rows = await sys(() => db.select({ content: ticketComments.content, isPublic: ticketComments.isPublic, commentType: ticketComments.commentType })
    .from(ticketComments)
    .where(and(eq(ticketComments.ticketId, ticketId), eq(ticketComments.commentType, 'system'))));
  return rows.filter((r) => r.content.startsWith('Removed link'));
}

async function orgOf(id: string) {
  const [t] = await sys(() => db.select({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.id, id)));
  return t!.orgId;
}

function moveDevice(f: Fixture) {
  return sys(() => db.transaction((tx) => moveDeviceOrgInTransaction(tx, {
    deviceId: f.deviceId, sourceOrgId: f.orgX, targetOrgId: f.orgY, targetSiteId: f.siteY,
    targetOrgName: 'target', deviceLinkGroupId: null, acceptCurrencyMismatch: false,
    actor: { userId: f.userId, allowedSiteIds: undefined }, stepUp: null, via: 'generic_move',
  })));
}

describe('ticket_links across org moves (real DB)', () => {
  it('ticket axis: moving a linked ticket deletes its links and notes each surviving counterpart after commit', async () => {
    const f = await seed();
    await link(f, f.A.id, f.B.id, 'caused_by');   // A caused_by B
    await link(f, f.C.id, f.A.id, 'related');     // A ~ C
    await link(f, f.C.id, f.B.id, 'resolves');    // untouched by A's move

    await sys(() => moveTicketOrg(f.A.id, f.orgY, { kind: 'user', userId: f.userId }));

    expect(await orgOf(f.A.id)).toBe(f.orgY);
    expect(await orgOf(f.B.id)).toBe(f.orgX);
    expect(await linksTouching([f.A.id])).toEqual([]);
    const survivors = await linksTouching([f.B.id, f.C.id]);
    expect(survivors.map((l) => [l.sourceTicketId, l.targetTicketId, l.linkType])).toEqual([[f.C.id, f.B.id, 'resolves']]);

    // B saw "B causes A"; C saw "C related A". Internal system notes, naming
    // the moved ticket by number only (never the target org). Written by the
    // commit-only deferred task, so wait for it rather than racing it.
    await vi.waitFor(async () => {
      expect(await removalNotes(f.B.id)).toHaveLength(1);
      expect(await removalNotes(f.C.id)).toHaveLength(1);
    }, { timeout: 10_000, interval: 100 });
    const bNotes = await removalNotes(f.B.id);
    expect(bNotes).toHaveLength(1);
    expect(bNotes[0]).toMatchObject({ isPublic: false, commentType: 'system' });
    expect(bNotes[0]!.content).toContain(f.A.number);
    expect(bNotes[0]!.content).toContain('causes');
    expect((await removalNotes(f.C.id))[0]!.content).toContain(f.A.number);
    // The moved ticket is not told about tickets left in another org.
    expect(await removalNotes(f.A.id)).toEqual([]);
  });

  it('device axis: the real mover deletes links of every moved ticket under deferred FKs; notes follow the survivor rule', async () => {
    const f = await seed();
    await link(f, f.A.id, f.B.id, 'caused_by');   // A moves, B stays
    await link(f, f.A.id, f.C.id, 'related');     // both move with the device
    await link(f, f.C.id, f.B.id, 'resolves');    // C moves, B stays

    const result = await moveDevice(f);
    expect(result.removedTicketLinks).toHaveLength(3);

    expect(await orgOf(f.A.id)).toBe(f.orgY);
    expect(await orgOf(f.C.id)).toBe(f.orgY);
    expect(await linksTouching([f.A.id, f.B.id, f.C.id])).toEqual([]);

    await noteTicketLinksRemovedByOrgMove(result.removedTicketLinks);
    // B lost two links to tickets that left; A and C each lost the link they
    // shared (both moved together, so both now sit in the same org).
    expect(await removalNotes(f.B.id)).toHaveLength(2);
    expect(await removalNotes(f.A.id)).toHaveLength(1);
    expect(await removalNotes(f.C.id)).toHaveLength(1);
    expect((await removalNotes(f.A.id))[0]!.content).toContain(f.C.number);
  });

  for (const axis of ['ticket', 'device'] as const) {
    it(`${axis} axis: a mover waits for an in-flight link write of its source org (shared vs exclusive advisory lock)`, async () => {
      // Without this serialization a mover (ticket row -> link row) and a
      // link writer (link row -> ticket rows via the comment feed trigger)
      // lock in opposite orders: 40P01.
      const f = await seed();
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let signalLocked!: () => void;
      const locked = new Promise<void>((r) => { signalLocked = r; });
      const writer = sys(() => db.transaction(async (tx) => {
        await lockOrgTicketLinks(tx, f.orgX, 'exclusive');
        signalLocked();
        await gate;
      }));
      await locked;
      let moved = false;
      const move = (axis === 'ticket'
        ? sys(() => moveTicketOrg(f.A.id, f.orgY, { kind: 'user', userId: f.userId }))
        : moveDevice(f)
      ).then(() => { moved = true; });
      await new Promise((r) => setTimeout(r, 750));
      expect(moved).toBe(false);
      release();
      await writer;
      await move;
      expect(moved).toBe(true);
      expect(await orgOf(f.A.id)).toBe(f.orgY);
    });
  }

  it('concurrent moves of the two ends of one link both complete (no 40P01, no 23503)', async () => {
    const f = await seed();
    await link(f, f.B.id, f.A.id, 'duplicate_of');
    const actor = { kind: 'user' as const, userId: f.userId };
    const results = await Promise.allSettled([
      sys(() => moveTicketOrg(f.A.id, f.orgY, actor)),
      sys(() => moveTicketOrg(f.B.id, f.orgY, actor)),
    ]);
    expect(results.map((r) => (r.status === 'rejected' ? String((r.reason as Error)?.message ?? r.reason) : 'ok'))).toEqual(['ok', 'ok']);
    expect(await orgOf(f.A.id)).toBe(f.orgY);
    expect(await orgOf(f.B.id)).toBe(f.orgY);
    expect(await linksTouching([f.A.id, f.B.id])).toEqual([]);
  });
});
