/**
 * #8973 W4 (spec §4.3 "Move-org"): a DEVICE move-org re-resolves the business
 * calendar of every ticket that follows the device, AFTER
 * breeze_cascade_device_org_id() restamps tickets.org_id, in the same
 * transaction — and never leaves the source org's own calendar referenced.
 * Driven through the real POST /devices/:id/move-org route (step-up included).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  businessCalendarIntervals,
  businessCalendarRevisions,
  businessCalendars,
  devices,
  orgTicketSettings,
  tickets,
} from '../../db/schema';
import { createOrganization, createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { createAccessToken } from '../../services/jwt';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';
import { withMoveOrgStepUpGrant } from './moveOrgStepUpFixture';

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function calendar(owner: { orgId: string | null; partnerId: string | null }, opts: { isPartnerDefault?: boolean; timezone: string }) {
  return withSystemDbAccessContext(async () => {
    const [cal] = await db.insert(businessCalendars).values({ ...owner, name: `Cal ${uid()}`, isPartnerDefault: opts.isPartnerDefault ?? false }).returning();
    const [rev] = await db.insert(businessCalendarRevisions).values({ calendarId: cal!.id, ...owner, revision: 1, timezone: opts.timezone }).returning();
    await db.insert(businessCalendarIntervals).values([1, 2, 3, 4, 5].map((weekday) => ({
      revisionId: rev!.id, ...owner, weekday, startMinute: 540, endMinute: 1020,
    })));
    return { calendarId: cal!.id, revisionId: rev!.id };
  });
}

describe('device move-org re-resolves ticket calendars (#8973 W4)', () => {
  it("a ticket on the source org's own calendar moves to the target's partner default and its unfrozen deadlines follow", async () => {
    const sfx = uid();
    const { partner, organization: sourceOrg, site: sourceSite, user, role } = await setupTestEnvironment({ scope: 'partner' });
    const targetOrg = await createOrganization({ partnerId: partner.id });
    const targetSite = await createSite({ orgId: targetOrg.id });

    const sourceCal = await calendar({ orgId: sourceOrg.id, partnerId: null }, { timezone: 'Europe/London' });
    const partnerDefault = await calendar({ orgId: null, partnerId: partner.id }, { isPartnerDefault: true, timezone: 'America/New_York' });
    await withSystemDbAccessContext(() => db.insert(orgTicketSettings).values({ orgId: sourceOrg.id, businessCalendarId: sourceCal.calendarId }));

    const adminDb = getTestDb();
    const [device] = await adminDb.insert(devices).values({
      orgId: sourceOrg.id, siteId: sourceSite.id, agentId: `bc-agent-${sfx}`, hostname: `bc-host-${sfx}`,
      osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'offline',
    }).returning({ id: devices.id });
    // Mon 2030-06-03 09:00 New York; deadlines as the source calendar stamped them.
    const createdAt = new Date('2030-06-03T13:00:00Z');
    const [ticket] = await adminDb.insert(tickets).values({
      orgId: sourceOrg.id, partnerId: partner.id, deviceId: device!.id, ticketNumber: `BC-${sfx}`, subject: 'device ticket',
      source: 'manual', createdAt, slaCalendarRevisionId: sourceCal.revisionId,
      responseSlaMinutes: 60, resolutionSlaMinutes: 480,
      responseDueAt: new Date('2030-06-03T09:00:00Z'), resolutionDueAt: new Date('2030-06-03T16:00:00Z'),
    } as never).returning({ id: tickets.id });

    const token = await createAccessToken({
      sub: user.id, email: user.email, roleId: role.id, orgId: null, partnerId: partner.id, scope: 'partner',
      mfa: true, aep: 1, mep: 1, sid: 'it-session',
    });
    const app = new Hono();
    app.route('/devices', moveOrgRoutes);
    const res = await app.request(`/devices/${device!.id}/move-org`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(await withMoveOrgStepUpGrant(token, device!.id, { orgId: targetOrg.id, siteId: targetSite.id })),
    });
    expect(res.status, await res.clone().text()).toBe(200);

    const [after] = await adminDb.select().from(tickets).where(eq(tickets.id, ticket!.id));
    expect(after?.orgId).toBe(targetOrg.id);
    expect(after?.slaCalendarRevisionId).toBe(partnerDefault.revisionId);
    // Recomputed on the New York calendar: Mon 09:00 + 60 → 10:00; + 480 → 17:00.
    expect(after?.responseDueAt).toEqual(new Date('2030-06-03T14:00:00Z'));
    expect(after?.resolutionDueAt).toEqual(new Date('2030-06-03T21:00:00Z'));

    // Nothing references the source org's calendar any more.
    const stillReferenced = await adminDb.select({ id: tickets.id }).from(tickets).where(eq(tickets.slaCalendarRevisionId, sourceCal.revisionId));
    expect(stillReferenced).toEqual([]);
  });
});
