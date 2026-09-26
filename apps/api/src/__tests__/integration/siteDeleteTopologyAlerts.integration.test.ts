import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray, sql } from 'drizzle-orm';
import { orgRoutes } from '../../routes/orgs';
import {
  alertCorrelations,
  alertNotifications,
  alerts,
  devices,
  notificationChannels,
  sites,
  ticketAlertLinks,
  tickets,
} from '../../db/schema';
import { createIntegrationTestClient, createSite } from './db-utils';
import { getTestDb } from './setup';

/**
 * PR #7117 review T3. A site-owned topology policy alert (M3-D6) references
 * its site through alerts_topology_site_fk (NO ACTION), so DELETE
 * /orgs/sites/:id used to abort with 23503 → 500. The site's topology state
 * cascades away with it, and so do the alerts it owns — together with every
 * NO-ACTION alert child — while other sites' alerts and the org's
 * device-bound alerts are untouched. Real JWT, breeze_app, RLS on.
 */
const app = new Hono().route('/orgs', orgRoutes);

describe('DELETE /orgs/sites/:id with site-owned topology alerts (T3)', () => {
  it('deletes the site, its owned alerts and their dependents; nothing else', async () => {
    const client = await createIntegrationTestClient(app, {
      scope: 'organization',
      rolePermissions: [{ resource: 'sites', action: 'read' }, { resource: 'sites', action: 'write' }],
    });
    const { organization: org, site: keptSite, partner } = client.env;
    const doomed = await createSite({ orgId: org.id });
    const seed = getTestDb() as any;
    // The origin device lives in the KEPT site (a device in the doomed site
    // would block the delete on its own FK, which is out of scope here).
    const [device] = await seed.insert(devices).values({
      orgId: org.id, siteId: keptSite.id, agentId: crypto.randomUUID(), hostname: 'collector',
      osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1',
    }).returning();
    const base = { orgId: org.id, deviceId: device.id, severity: 'high' as const, status: 'active' as const };
    const [owned, keptOwned, plain] = await seed.insert(alerts).values([
      { ...base, title: 'owned by doomed', topologySiteId: doomed.id, topologySourceKey: `topology:${'1'.repeat(64)}` },
      { ...base, title: 'owned by kept', topologySiteId: keptSite.id, topologySourceKey: `topology:${'2'.repeat(64)}` },
      { ...base, title: 'device alert' },
    ]).returning();
    const [channel] = await seed.insert(notificationChannels).values({ orgId: org.id, name: 'mail', type: 'email', config: { recipients: ['ops@example.test'] } }).returning();
    await seed.insert(alertNotifications).values({ alertId: owned.id, channelId: channel.id, status: 'sent' });
    await seed.insert(alertCorrelations).values({ parentAlertId: plain.id, childAlertId: owned.id, correlationType: 'topology' });
    const [ticket] = await seed.insert(tickets).values({
      orgId: org.id, partnerId: partner.id, ticketNumber: `SITE-DEL-${owned.id.slice(0, 8)}`, subject: 'owned', source: 'manual', priority: 'normal',
    }).returning();
    await seed.insert(ticketAlertLinks).values({ ticketId: ticket.id, orgId: org.id, alertId: owned.id });

    const res = await client.delete(`/orgs/sites/${doomed.id}`);
    expect(res.status, await res.clone().text()).toBe(200);

    expect(await seed.select().from(sites).where(eq(sites.id, doomed.id))).toHaveLength(0);
    const remaining = await seed.select({ id: alerts.id }).from(alerts).where(inArray(alerts.id, [owned.id, keptOwned.id, plain.id]));
    expect(remaining.map((r: { id: string }) => r.id).sort()).toEqual([keptOwned.id, plain.id].sort());
    expect(await seed.select().from(alertNotifications).where(eq(alertNotifications.alertId, owned.id))).toHaveLength(0);
    expect(await seed.select().from(alertCorrelations).where(eq(alertCorrelations.childAlertId, owned.id))).toHaveLength(0);
    expect(await seed.select().from(ticketAlertLinks).where(eq(ticketAlertLinks.alertId, owned.id))).toHaveLength(0);
    // The ticket itself is a business record and survives.
    expect(await seed.select().from(tickets).where(eq(tickets.id, ticket.id))).toHaveLength(1);
  });

  it('handles every NO ACTION foreign key into alerts (a new one must be added to siteOwnedAlerts.ts)', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT conrelid::regclass::text AS tbl FROM pg_constraint
      WHERE confrelid = 'public.alerts'::regclass AND contype = 'f' AND confdeltype = 'a'
        AND conrelid <> 'public.alerts'::regclass`) as unknown as Array<{ tbl: string }>;
    expect([...new Set(rows.map((r) => r.tbl))].sort()).toEqual([
      'alert_correlations', 'alert_notifications', 'log_correlations', 'network_change_events', 'psa_ticket_mappings',
    ]);
  });
});
