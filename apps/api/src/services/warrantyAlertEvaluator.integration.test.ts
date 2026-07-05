import '../__tests__/integration/setup';

import { expect, it } from 'vitest';
import { and, eq, ne } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import {
  alerts,
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceWarranty,
  devices,
  organizations,
  partners,
  sites,
} from '../db/schema';
import { evaluateWarrantyAlerts } from './warrantyAlertEvaluator';

// Real-DB coverage for the two SQL predicates the mocked unit tests can't
// exercise (their db mock ignores the WHERE clause entirely):
//   1. the dismissed-dedup query's JSONB `context->>'warrantyEndDate'` scoping
//      (warrantyAlertEvaluator.ts), so a dismissal blocks re-creation for the
//      same end date but NOT after the warranty is renewed to a new end date;
//   2. the auto-resolve open-set query's Forever-suppression exclusion, so an
//      indefinitely-suppressed row survives auto-resolve while a timed one does not.
const runDb = it.runIf(!!process.env.DATABASE_URL);

/** ISO date string (YYYY-MM-DD) `days` from now — inside the default 30-day criticalDays. */
function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

type Fixture = { orgId: string; deviceId: string };

/**
 * Seed partner/org/site/device + a fixed-term warranty within the critical
 * window, and (when enableAlerting) a warranty config-policy feature link
 * assigned at org level so resolveWarrantySettings returns enabled settings.
 */
async function seed(unique: string, opts: { enableAlerting: boolean; endDate: string; isSubscription?: boolean }): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const [partner] = await db.insert(partners).values({ name: `WA Partner ${unique}`, slug: `wa-partner-${unique}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [org] = await db.insert(organizations).values({ partnerId: partner!.id, name: `WA Org ${unique}`, slug: `wa-org-${unique}`, type: 'customer', status: 'active' }).returning({ id: organizations.id });
    const [site] = await db.insert(sites).values({ orgId: org!.id, name: `WA Site ${unique}` }).returning({ id: sites.id });
    const [device] = await db.insert(devices).values({ orgId: org!.id, siteId: site!.id, agentId: `wa-agent-${unique}`, hostname: `wa-host-${unique}`, osType: 'macos', osVersion: '14', architecture: 'arm64', agentVersion: '0.0.0-test', status: 'offline' }).returning({ id: devices.id });

    await db.insert(deviceWarranty).values({
      deviceId: device!.id,
      orgId: org!.id,
      manufacturer: 'apple',
      serialNumber: `SN-${unique}`,
      status: opts.isSubscription ? 'subscription_active' : 'expiring',
      warrantyEndDate: opts.endDate,
      isSubscription: opts.isSubscription ?? false,
    });

    if (opts.enableAlerting) {
      const [policy] = await db.insert(configurationPolicies).values({ orgId: org!.id, name: `WA Policy ${unique}`, status: 'active' }).returning({ id: configurationPolicies.id });
      await db.insert(configPolicyFeatureLinks).values({ configPolicyId: policy!.id, featureType: 'warranty', inlineSettings: { enabled: true, warnDays: 90, criticalDays: 30 } });
      await db.insert(configPolicyAssignments).values({ configPolicyId: policy!.id, level: 'organization', targetId: org!.id, priority: 0 });
    }

    return { orgId: org!.id, deviceId: device!.id };
  });
}

function openWarrantyAlerts(deviceId: string) {
  return withSystemDbAccessContext(() =>
    db.select().from(alerts).where(and(eq(alerts.deviceId, deviceId), ne(alerts.status, 'dismissed')))
  );
}

runDb('does NOT re-create a warranty alert dismissed for the SAME end date', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const endDate = inDays(10);
  const { orgId, deviceId } = await seed(unique, { enableAlerting: true, endDate });

  await withSystemDbAccessContext(() =>
    db.insert(alerts).values({
      deviceId, orgId, configItemName: 'warranty_expiry', status: 'dismissed', severity: 'critical',
      title: 'Warranty expired (dismissed)', context: { warrantyEndDate: endDate, source: 'warranty_evaluator' },
    })
  );

  const created = await withSystemDbAccessContext(() => evaluateWarrantyAlerts(deviceId));

  expect(created).toBeNull();
  const open = await openWarrantyAlerts(deviceId);
  expect(open).toHaveLength(0); // no fresh active alert
});

runDb('DOES re-create a warranty alert after the warranty is renewed to a NEW end date', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const renewedEndDate = inDays(10); // current coverage window
  const { orgId, deviceId } = await seed(unique, { enableAlerting: true, endDate: renewedEndDate });

  // A dismissal recorded against the OLD (now-superseded) end date must not
  // suppress the alert for the renewed coverage's approaching expiry.
  await withSystemDbAccessContext(() =>
    db.insert(alerts).values({
      deviceId, orgId, configItemName: 'warranty_expiry', status: 'dismissed', severity: 'critical',
      title: 'Warranty expired (old, dismissed)', context: { warrantyEndDate: '2020-01-01', source: 'warranty_evaluator' },
    })
  );

  const created = await withSystemDbAccessContext(() => evaluateWarrantyAlerts(deviceId));

  expect(created).not.toBeNull();
  const open = await openWarrantyAlerts(deviceId);
  expect(open).toHaveLength(1);
  expect(open[0]!.status).toBe('active');
});

runDb('a legacy dismissed row with no end date in context blocks re-creation unconditionally', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { orgId, deviceId } = await seed(unique, { enableAlerting: true, endDate: inDays(10) });

  await withSystemDbAccessContext(() =>
    db.insert(alerts).values({
      deviceId, orgId, configItemName: 'warranty_expiry', status: 'dismissed', severity: 'critical',
      title: 'Warranty expired (legacy dismissed)', context: { source: 'warranty_evaluator' }, // no warrantyEndDate
    })
  );

  const created = await withSystemDbAccessContext(() => evaluateWarrantyAlerts(deviceId));

  expect(created).toBeNull();
  expect(await openWarrantyAlerts(deviceId)).toHaveLength(0);
});

runDb('auto-resolve leaves a FOREVER-suppressed alert suppressed but resolves a TIMED one (subscription path)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Subscription warranty short-circuits to autoResolveWarrantyAlerts without
  // needing a config policy.
  const { orgId, deviceId } = await seed(unique, { enableAlerting: false, endDate: inDays(28), isSubscription: true });

  const base = { deviceId, orgId, configItemName: 'warranty_expiry', severity: 'critical' as const, title: 'Warranty expiry' };
  const ids = await withSystemDbAccessContext(async () => {
    const [forever] = await db.insert(alerts).values({ ...base, status: 'suppressed', suppressedUntil: null }).returning({ id: alerts.id });
    const [timed] = await db.insert(alerts).values({ ...base, status: 'suppressed', suppressedUntil: new Date(Date.now() + 86_400_000) }).returning({ id: alerts.id });
    const [active] = await db.insert(alerts).values({ ...base, status: 'active' }).returning({ id: alerts.id });
    return { forever: forever!.id, timed: timed!.id, active: active!.id };
  });

  await withSystemDbAccessContext(() => evaluateWarrantyAlerts(deviceId));

  await withSystemDbAccessContext(async () => {
    const [foreverRow] = await db.select().from(alerts).where(eq(alerts.id, ids.forever));
    expect(foreverRow!.status).toBe('suppressed'); // Forever mute survives — the #2110 invariant

    const [timedRow] = await db.select().from(alerts).where(eq(alerts.id, ids.timed));
    expect(timedRow!.status).toBe('resolved');

    const [activeRow] = await db.select().from(alerts).where(eq(alerts.id, ids.active));
    expect(activeRow!.status).toBe('resolved');
  });
});
