/**
 * "Reboot pending too long" alerts must clear themselves once the device
 * restarts. The sweep that raises them only visits devices that still report
 * `pending_reboot = true`, so a device that restarted dropped out of it and its
 * alert stayed open forever ("Lana has needed a restart for 8 day(s)" long
 * after Lana restarted).
 *
 * Against live PostgreSQL: `resolveClearedRebootPendingAlerts` resolves the
 * open alert of a device that no longer needs a restart, leaves the alert of a
 * device that still does, and honours the same status rule as the other
 * condition-cleared resolvers (dismissed and "Forever"-suppressed alerts stay).
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/rebootPendingAlertResolve.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { alerts, devices } from '../../db/schema';
import {
  REBOOT_PENDING_ALERT_SOURCE,
  ensureRebootPendingRule,
  resolveClearedRebootPendingAlerts,
} from '../../services/patchAlerts';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedOrg() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org!.id });
  return { orgId: org!.id, siteId: site!.id };
}

async function seedDevice(orgId: string, siteId: string, pendingReboot: boolean) {
  const [d] = await withSystemDbAccessContext(() => db
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `rp-agent-${randomUUID()}`,
      hostname: `rp-host-${randomUUID().slice(0, 8)}`,
      osType: 'windows',
      osVersion: '10.0.19045',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
      pendingReboot,
    })
    .returning({ id: devices.id }));
  return d!.id;
}

type SeedStatus = 'active' | 'acknowledged' | 'suppressed-timed' | 'suppressed-forever' | 'dismissed';

async function seedAlert(orgId: string, ruleId: string, deviceId: string, status: SeedStatus) {
  const [a] = await withSystemDbAccessContext(() => db
    .insert(alerts)
    .values({
      orgId,
      ruleId,
      deviceId,
      status: status.startsWith('suppressed') ? 'suppressed' : status as 'active' | 'acknowledged' | 'dismissed',
      suppressedUntil: status === 'suppressed-timed' ? new Date(Date.now() + 86400_000) : null,
      severity: 'medium',
      title: 'Reboot pending',
      message: 'has needed a restart for 8 day(s).',
      context: { source: REBOOT_PENDING_ALERT_SOURCE, pendingDays: 8 },
    })
    .returning({ id: alerts.id }));
  return a!.id;
}

async function statuses(ids: string[]) {
  const rows = await withSystemDbAccessContext(() => db
    .select({ id: alerts.id, status: alerts.status, resolutionReason: alerts.resolutionReason })
    .from(alerts)
    .where(inArray(alerts.id, ids)));
  return new Map(rows.map((r) => [r.id, r]));
}

describe('reboot-pending alerts resolve once the device restarts', () => {
  runDb('resolves the cleared device, keeps the still-pending one and the terminal/forever statuses', async () => {
    const { orgId, siteId } = await seedOrg();
    const ruleId = await withSystemDbAccessContext(() => ensureRebootPendingRule(orgId));

    // One alert per device: the open-alert unique index allows one per (rule, device).
    const seeded: Record<string, { status: SeedStatus; pending: boolean }> = {};
    const plan: Array<[SeedStatus, boolean]> = [
      ['active', false],
      ['acknowledged', false],
      ['suppressed-timed', false],
      ['suppressed-forever', false],
      ['dismissed', false],
      ['active', true],
    ];
    for (const [status, pending] of plan) {
      const deviceId = await seedDevice(orgId, siteId, pending);
      const alertId = await seedAlert(orgId, ruleId, deviceId, status);
      seeded[alertId] = { status, pending };
    }

    await withSystemDbAccessContext(() => resolveClearedRebootPendingAlerts());

    const after = await statuses(Object.keys(seeded));
    for (const [alertId, { status, pending }] of Object.entries(seeded)) {
      const row = after.get(alertId)!;
      const shouldResolve = !pending && ['active', 'acknowledged', 'suppressed-timed'].includes(status);
      expect({ status, pending, now: row.status }).toEqual({
        status,
        pending,
        now: shouldResolve ? 'resolved' : (status.startsWith('suppressed') ? 'suppressed' : status),
      });
      if (shouldResolve) expect(row.resolutionReason).toBe('condition_cleared');
    }
  });
});
