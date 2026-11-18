/** Real-DB proof of partner pins and bounded, filtered neighbours. Run in CI. */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { alerts, contracts, invoices, quotes, tickets } from '../../db/schema';
import { neighbourRefs, relatedRefs } from '../../services/wisp/entityRelations';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });
  const rows = await withSystemDbAccessContext(async () => {
    const [ticket] = await db.insert(tickets).values({ orgId: org.id, partnerId: partner.id, deviceId: device.id,
      ticketNumber: `REL-${randomUUID()}`, subject: 'Test ticket', status: 'open' }).returning();
    const [alert] = await db.insert(alerts).values({ orgId: org.id, deviceId: device.id, title: 'Test alert', severity: 'high' }).returning();
    const common = { partnerId: partner.id, orgId: org.id, currencyCode: 'USD' };
    const [quote] = await db.insert(quotes).values({ ...common, siteId: site.id }).returning();
    const [invoice] = await db.insert(invoices).values({ ...common, siteId: site.id }).returning();
    const [contract] = await db.insert(contracts).values({ ...common, name: 'Test contract', intervalMonths: 1, startDate: '2026-01-01' }).returning();
    return { ticket: ticket!, alert: alert!, quote: quote!, invoice: invoice!, contract: contract! };
  });
  return { partner, org, site, device, ...rows };
}

describe('Wisp one-hop relations (real Postgres)', () => {
  it('reads upward pointers for each kind and returns nothing for another partner', async () => {
    const env = await seed();
    const foreign = await createPartner();
    const org = { kind: 'organization', id: env.org.id };
    const device = { kind: 'device', id: env.device.id };
    const site = { kind: 'site', id: env.site.id };
    const cases = [
      [{ kind: 'ticket', id: env.ticket.id }, [device, org]],
      [{ kind: 'device', id: env.device.id }, [site, org]],
      [{ kind: 'alert', id: env.alert.id }, [device, org]],
      [{ kind: 'quote', id: env.quote.id }, [org, site]],
      [{ kind: 'invoice', id: env.invoice.id }, [org, site]],
      [{ kind: 'contract', id: env.contract.id }, [org]],
      [{ kind: 'site', id: env.site.id }, [org]],
    ] as const;
    for (const [ref, expected] of cases) {
      expect(await relatedRefs(env.partner.id, ref)).toEqual(expected);
      expect(await relatedRefs(foreign.id, ref)).toEqual([]);
    }
    expect(await neighbourRefs(foreign.id, { kind: 'device', id: env.device.id })).toEqual([]);
  });

  it('ticket without a device relates only to its org; deleted tickets have no relations', async () => {
    const env = await seed();
    await withSystemDbAccessContext(() => db.update(tickets).set({ deviceId: null }).where(eq(tickets.id, env.ticket.id)));
    expect(await relatedRefs(env.partner.id, { kind: 'ticket', id: env.ticket.id })).toEqual([{ kind: 'organization', id: env.org.id }]);
    await withSystemDbAccessContext(() => db.update(tickets).set({ deletedAt: new Date() }).where(eq(tickets.id, env.ticket.id)));
    expect(await relatedRefs(env.partner.id, { kind: 'ticket', id: env.ticket.id })).toEqual([]);
  });

  it('device neighbours cap eligible children at three each and exclude terminal/deleted children', async () => {
    const env = await seed();
    const eligibleTickets = [env.ticket.id], eligibleAlerts = [env.alert.id];
    await withSystemDbAccessContext(async () => {
      for (let i = 0; i < 4; i++) {
        const [ticket] = await db.insert(tickets).values({ orgId: env.org.id, partnerId: env.partner.id, deviceId: env.device.id,
          ticketNumber: `REL-${randomUUID()}`, subject: 'Open child', status: 'pending' }).returning();
        const [alert] = await db.insert(alerts).values({ orgId: env.org.id, deviceId: env.device.id, title: 'Active child', severity: 'high' }).returning();
        eligibleTickets.push(ticket!.id); eligibleAlerts.push(alert!.id);
      }
      for (const status of ['resolved', 'closed'] as const) {
        await db.insert(tickets).values({ orgId: env.org.id, partnerId: env.partner.id, deviceId: env.device.id,
          ticketNumber: `REL-${randomUUID()}`, subject: 'Terminal child', status });
      }
      await db.insert(tickets).values({ orgId: env.org.id, partnerId: env.partner.id, deviceId: env.device.id,
        ticketNumber: `REL-${randomUUID()}`, subject: 'Deleted child', status: 'open', deletedAt: new Date() });
      for (const status of ['acknowledged', 'resolved', 'suppressed', 'dismissed'] as const) {
        await db.insert(alerts).values({ orgId: env.org.id, deviceId: env.device.id, title: 'Inactive child', severity: 'high', status });
      }
    });
    const ref = { kind: 'device' as const, id: env.device.id };
    const neighbours = await neighbourRefs(env.partner.id, ref);
    expect(neighbours).toHaveLength(8);
    expect(neighbours.filter((r) => r.kind === 'ticket').map((r) => r.id)).toEqual(eligibleTickets.sort().slice(0, 3));
    expect(neighbours.filter((r) => r.kind === 'alert').map((r) => r.id)).toEqual(eligibleAlerts.sort().slice(0, 3));
    // Removing eligible rows makes any status/deletion guard omission observable,
    // even when the deterministic cap happened to choose eligible rows before.
    await withSystemDbAccessContext(async () => {
      for (const id of eligibleTickets) await db.delete(tickets).where(eq(tickets.id, id));
      for (const id of eligibleAlerts) await db.delete(alerts).where(eq(alerts.id, id));
    });
    expect(await neighbourRefs(env.partner.id, ref)).toEqual(await relatedRefs(env.partner.id, ref));
  });
});
