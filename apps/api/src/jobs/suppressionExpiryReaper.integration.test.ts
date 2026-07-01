import '../__tests__/integration/setup';

import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { alerts, devices, organizations, partners, sites } from '../db/schema';
import { reapExpiredSuppressions } from './suppressionExpiryReaper';

const runDb = it.runIf(!!process.env.DATABASE_URL);

runDb('reactivates only past timed suppressions; leaves future, forever, and non-suppressed rows', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60 * 60_000);

  const ids = await withSystemDbAccessContext(async () => {
    const [partner] = await db.insert(partners).values({ name: `SR Partner ${unique}`, slug: `sr-partner-${unique}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [org] = await db.insert(organizations).values({ partnerId: partner!.id, name: `SR Org ${unique}`, slug: `sr-org-${unique}`, type: 'customer', status: 'active' }).returning({ id: organizations.id });
    const [site] = await db.insert(sites).values({ orgId: org!.id, name: `SR Site ${unique}` }).returning({ id: sites.id });
    const [device] = await db.insert(devices).values({ orgId: org!.id, siteId: site!.id, agentId: `sr-agent-${unique}`, hostname: `sr-host-${unique}`, osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'offline' }).returning({ id: devices.id });

    const base = { deviceId: device!.id, orgId: org!.id, severity: 'info' as const, title: 'SR alert', triggeredAt: new Date() };
    const [pastSup] = await db.insert(alerts).values({ ...base, status: 'suppressed', suppressedUntil: past }).returning({ id: alerts.id });
    const [futureSup] = await db.insert(alerts).values({ ...base, status: 'suppressed', suppressedUntil: future }).returning({ id: alerts.id });
    const [foreverSup] = await db.insert(alerts).values({ ...base, status: 'suppressed', suppressedUntil: null }).returning({ id: alerts.id });
    const [activeAlert] = await db.insert(alerts).values({ ...base, status: 'active', suppressedUntil: null }).returning({ id: alerts.id });
    return { pastSup: pastSup!.id, futureSup: futureSup!.id, foreverSup: foreverSup!.id, activeAlert: activeAlert!.id };
  });

  // Other suites may leave suppressed rows behind on the shared DB, so assert on
  // our specific rows rather than the exact reaped count.
  const reaped = await withSystemDbAccessContext(() => reapExpiredSuppressions());
  expect(reaped).toBeGreaterThanOrEqual(1);

  await withSystemDbAccessContext(async () => {
    const [pastRow] = await db.select().from(alerts).where(eq(alerts.id, ids.pastSup));
    expect(pastRow!.status).toBe('active');
    expect(pastRow!.suppressedUntil).toBeNull();

    const [futureRow] = await db.select().from(alerts).where(eq(alerts.id, ids.futureSup));
    expect(futureRow!.status).toBe('suppressed');

    const [foreverRow] = await db.select().from(alerts).where(eq(alerts.id, ids.foreverSup));
    expect(foreverRow!.status).toBe('suppressed'); // Forever stays forever
    expect(foreverRow!.suppressedUntil).toBeNull();

    const [activeRow] = await db.select().from(alerts).where(eq(alerts.id, ids.activeAlert));
    expect(activeRow!.status).toBe('active');
  });
});
