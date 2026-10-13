/**
 * time_entries.site_id follows an org move on BOTH axes (#8356).
 *
 * `time_entries.site_id` is a PLAIN single-column FK to `sites(id)` (#4186) —
 * there is no (site_id, org_id) tenant FK — so nothing in the database stops a
 * row from naming a site in another org. Before #8356 both org movers
 * re-stamped `time_entries.org_id` and left `site_id` alone, so a moved entry
 * kept pointing at a SOURCE-org site: wrong site-scoped reporting, and a
 * cross-tenant reference a site-restricted reader in the old org could match.
 *
 * The fix rewrites site_id in the SAME statement as org_id:
 *   - device axis (`POST /devices/:id/move-org`): → the device's target site,
 *     but only where the entry already had a site (no link is invented);
 *   - ticket axis (`moveTicketOrg`): → NULL (tickets carry no site).
 *
 * The mocked suites (moveOrg.test.ts, ticketService.test.ts) pin the SQL text;
 * this proves Postgres ends up with no time_entries.site_id in another org.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { devices, tickets, timeEntries } from '../../db/schema';
import { createOrganization, createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { createAccessToken } from '../../services/jwt';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';
import { moveTicketOrg } from '../../services/ticketService';
import { withMoveOrgStepUpGrant } from './moveOrgStepUpFixture';

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seed() {
  const adminDb = getTestDb() as any;
  const sfx = uid();

  const { partner, organization: sourceOrg, site: sourceSite, user, role } = await setupTestEnvironment({
    scope: 'partner',
  });
  const targetOrg = await createOrganization({ partnerId: partner.id });
  const targetSite = await createSite({ orgId: targetOrg.id });

  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId: sourceOrg.id,
      siteId: sourceSite.id,
      agentId: `te-site-agent-${sfx}`,
      hostname: `te-site-host-${sfx}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
    })
    .returning({ id: devices.id });

  // Bound to the moving device, so the device axis carries it (and its time).
  const [deviceTicket] = await adminDb
    .insert(tickets)
    .values({
      orgId: sourceOrg.id,
      partnerId: partner.id,
      deviceId: device!.id,
      ticketNumber: `TES-DEV-${sfx}`,
      subject: `device-bound ticket ${sfx}`,
      source: 'manual',
    })
    .returning({ id: tickets.id });

  // Negative control: same org, no device — must never be touched by a move
  // of the device or of the device-bound ticket.
  const [siblingTicket] = await adminDb
    .insert(tickets)
    .values({
      orgId: sourceOrg.id,
      partnerId: partner.id,
      ticketNumber: `TES-SIB-${sfx}`,
      subject: `sibling ticket ${sfx}`,
      source: 'manual',
    })
    .returning({ id: tickets.id });

  const entry = async (ticketId: string, siteId: string | null) => {
    const [row] = await adminDb
      .insert(timeEntries)
      .values({
        partnerId: partner.id,
        orgId: sourceOrg.id,
        userId: user.id,
        ticketId,
        siteId,
        startedAt: new Date(Date.now() - 120_000),
        endedAt: new Date(Date.now() - 60_000),
        durationMinutes: 1,
        // time_entries_currency_required_when_org_chk; no hourly rate, so the
        // move's currency guard has nothing to compare.
        currencyCode: 'USD',
      })
      .returning({ id: timeEntries.id });
    return row!.id as string;
  };

  const sitedEntry = await entry(deviceTicket!.id, sourceSite.id);
  const unsitedEntry = await entry(deviceTicket!.id, null);
  const siblingEntry = await entry(siblingTicket!.id, sourceSite.id);

  const token = await createAccessToken({
    sub: user.id,
    email: user.email,
    roleId: role.id,
    orgId: null,
    partnerId: partner.id,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: 'it-session',
  });
  const app = new Hono();
  app.route('/devices', moveOrgRoutes);
  const postDeviceMove = async () =>
    app.request(`/devices/${device!.id}/move-org`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        await withMoveOrgStepUpGrant(token, device!.id, { orgId: targetOrg.id, siteId: targetSite.id }),
      ),
    });

  return {
    partnerId: partner.id,
    userId: user.id,
    sourceOrgId: sourceOrg.id,
    sourceSiteId: sourceSite.id,
    targetOrgId: targetOrg.id,
    targetSiteId: targetSite.id,
    deviceTicketId: deviceTicket!.id,
    sitedEntry,
    unsitedEntry,
    siblingEntry,
    postDeviceMove,
  };
}

async function readEntry(id: string) {
  const [row] = await getTestDb()
    .select({ orgId: timeEntries.orgId, siteId: timeEntries.siteId })
    .from(timeEntries)
    .where(eq(timeEntries.id, id));
  return row;
}

/** The issue's acceptance criterion: no entry names a site in another org. */
async function crossOrgSiteRefs(partnerId: string): Promise<unknown[]> {
  return (await getTestDb().execute(sql`
    SELECT te.id, te.org_id, s.org_id AS site_org_id
      FROM time_entries te
      JOIN sites s ON s.id = te.site_id
     WHERE te.partner_id = ${partnerId}::uuid
       AND s.org_id IS DISTINCT FROM te.org_id
  `)) as unknown as unknown[];
}

describe('time_entries.site_id after an org move (#8356)', () => {
  it('device move re-points a sited entry to the target site, keeps an unsited one unsited, and spares an unrelated ticket', async () => {
    const f = await seed();
    expect(await readEntry(f.sitedEntry)).toEqual({ orgId: f.sourceOrgId, siteId: f.sourceSiteId });

    const res = await f.postDeviceMove();
    const body = (await res.json()) as { success?: boolean };
    expect(res.status, JSON.stringify(body)).toBe(200);

    expect(await readEntry(f.sitedEntry)).toEqual({ orgId: f.targetOrgId, siteId: f.targetSiteId });
    expect(await readEntry(f.unsitedEntry), 'no site link is invented').toEqual({ orgId: f.targetOrgId, siteId: null });
    expect(await readEntry(f.siblingEntry), 'an entry on a ticket that did not move is untouched').toEqual({
      orgId: f.sourceOrgId,
      siteId: f.sourceSiteId,
    });
    expect(await crossOrgSiteRefs(f.partnerId)).toEqual([]);
  });

  it('ticket move nulls the moved entries\' site and spares an unrelated ticket', async () => {
    const f = await seed();

    await withSystemDbAccessContext(() =>
      moveTicketOrg(f.deviceTicketId, f.targetOrgId, { kind: 'user' as const, userId: f.userId }),
    );

    expect(await readEntry(f.sitedEntry)).toEqual({ orgId: f.targetOrgId, siteId: null });
    expect(await readEntry(f.unsitedEntry)).toEqual({ orgId: f.targetOrgId, siteId: null });
    expect(await readEntry(f.siblingEntry)).toEqual({ orgId: f.sourceOrgId, siteId: f.sourceSiteId });
    expect(await crossOrgSiteRefs(f.partnerId)).toEqual([]);
  });
});
