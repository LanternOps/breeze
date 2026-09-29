/**
 * A device parked in its partner's holding org receives nothing, against real
 * Postgres.
 *
 * Seed: partner P with a customer org C (control device D_c) and its holding
 * org H (parked device D_p), both devices online Windows workstations, and
 * partner-wide configuration (org_id NULL, partner_id P) assigned at partner
 * level for automation, maintenance, backup and a patch ring.
 *
 * Every selector and resolver below must select D_c (the control: proves the
 * partner-wide setup actually reaches the partner's devices, so the parked
 * result is not vacuous) and must NOT select D_p. Then the delivery layer:
 * commands, remote access, AI device access and offline effects all refuse
 * or skip D_p.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/parkedDeviceZeroDelivery.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db, withSystemDbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyAutomations,
  configPolicyBackupSettings,
  configPolicyFeatureLinks,
  configPolicyMaintenanceSettings,
  configurationPolicies,
  devices,
  offlineTransitionEffects,
  patchPolicies,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import {
  resolveAllBackupAssignedDevices,
  resolveAutomationsForDevice,
  resolveMaintenanceConfigForDevice,
} from '../../services/featureConfigResolver';
import { resolveEffectiveConfig } from '../../services/configurationPolicy';
import { __resolveDevicesForAssignmentTarget } from '../../services/policyEvaluationService';
import { resolveRingDeviceIds } from '../../routes/updateRingsHelpers';
import { selectCisScanTargetDevices } from '../../jobs/cisJobs';
import { persistOfflineTransition } from '../../services/offlineEffectsStore';
import { offlineTransitionId, processMarkOffline } from '../../jobs/offlineDetector';
import { queueCommand } from '../../services/commandQueue';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { checkRemoteAccess, invalidateRemoteAccessCache } from '../../services/remoteAccessPolicy';
import { verifyDeviceAccess } from '../../services/aiTools';
import { ParkedDeviceCommandRefusedError } from '../../services/unassignedPool/deliveryEligibility';
import { isParkedDeliverableCommandType } from '../../services/unassignedPool/deliveryEligibility';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { insertDevice, seedHoldingOrg, seedParkedDevice } from './unassignedPoolFixtures';

const systemAuth = {
  principal: { kind: 'system', reason: 'parked-zero-delivery-test' },
  user: { id: 'system', email: 'system', name: 'System', isPlatformAdmin: false },
  token: {} as never,
  partnerId: null,
  orgId: null,
  scope: 'system',
  accessibleOrgIds: null,
  orgCondition: () => undefined,
  canAccessOrg: () => true,
} as unknown as AuthContext;

type Fixture = {
  partnerId: string;
  customerOrgId: string;
  holdingOrgId: string;
  control: string;
  parked: string;
  ringId: string;
};

async function makeFleetDevice(id: string): Promise<void> {
  await getTestDb().update(devices).set({
    status: 'online',
    osType: 'windows',
    deviceRole: 'workstation',
    lastSeenAt: new Date(),
  }).where(eq(devices.id, id));
}

/** A partner-wide config policy (org_id NULL) assigned at partner level. */
async function partnerWidePolicy(
  partnerId: string,
  featureType: string,
  child?: (featureLinkId: string) => Promise<void>,
  link: { featurePolicyId?: string; inlineSettings?: Record<string, unknown> } = {},
): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: null,
      partnerId,
      name: `${featureType} ${randomUUID().slice(0, 8)}`,
      status: 'active',
    }).returning({ id: configurationPolicies.id });
    const [featureLink] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id,
      featureType: featureType as never,
      ...link,
    }).returning({ id: configPolicyFeatureLinks.id });
    if (child) await child(featureLink!.id);
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id,
      level: 'partner',
      targetId: partnerId,
      priority: 0,
    });
  });
}

async function seed(): Promise<Fixture> {
  const partner = await createPartner();
  const customer = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: customer.id });
  const control = await insertDevice(customer.id, site.id);
  const pool = await seedHoldingOrg(partner.id);
  const parked = await seedParkedDevice(pool.orgId, pool.siteId);
  await makeFleetDevice(control.id);
  await makeFleetDevice(parked.id);

  await partnerWidePolicy(partner.id, 'automation', async (featureLinkId) => {
    await db.insert(configPolicyAutomations).values({
      featureLinkId,
      name: `partner automation ${randomUUID().slice(0, 8)}`,
      triggerType: 'manual',
      actions: [{ type: 'run_script' }],
    });
  });
  await partnerWidePolicy(partner.id, 'maintenance', async (featureLinkId) => {
    await db.insert(configPolicyMaintenanceSettings).values({ featureLinkId, durationHours: 7 });
  });
  await partnerWidePolicy(partner.id, 'backup', async (featureLinkId) => {
    await db.insert(configPolicyBackupSettings).values({
      featureLinkId,
      orgId: null,
      partnerId: partner.id,
      backupMode: 'file',
    });
  });

  const ringId = await withSystemDbAccessContext(async () => {
    const [ring] = await db.insert(patchPolicies).values({
      partnerId: partner.id,
      kind: 'ring',
      name: `ring ${randomUUID().slice(0, 8)}`,
    }).returning({ id: patchPolicies.id });
    return ring!.id;
  });
  await partnerWidePolicy(partner.id, 'patch', undefined, { featurePolicyId: ringId });

  return {
    partnerId: partner.id,
    customerOrgId: customer.id,
    holdingOrgId: pool.orgId,
    control: control.id,
    parked: parked.id,
    ringId,
  };
}

describe('a parked device receives nothing (real Postgres)', () => {
  let f: Fixture;

  beforeEach(async () => {
    invalidateRemoteAccessCache();
    f = await seed();
  });

  describe('per-device resolvers give the parked device no partner-wide configuration', () => {
    it('automations', async () => {
      const control = await withSystemDbAccessContext(() => resolveAutomationsForDevice(f.control));
      expect(control.length).toBeGreaterThan(0);
      await expect(withSystemDbAccessContext(() => resolveAutomationsForDevice(f.parked))).resolves.toEqual([]);
    });

    it('maintenance', async () => {
      const control = await withSystemDbAccessContext(() => resolveMaintenanceConfigForDevice(f.control));
      expect(control?.durationHours).toBe(7);
      await expect(withSystemDbAccessContext(() => resolveMaintenanceConfigForDevice(f.parked))).resolves.toBeNull();
    });

    it('effective configuration', async () => {
      const control = await withSystemDbAccessContext(() => resolveEffectiveConfig(f.control, systemAuth));
      expect(control?.features.maintenance).toBeDefined();
      const parked = await withSystemDbAccessContext(() => resolveEffectiveConfig(f.parked, systemAuth));
      expect(parked?.features.maintenance).toBeUndefined();
      expect(parked?.features.automation).toBeUndefined();
      expect(parked?.features.backup).toBeUndefined();
    });
  });

  describe('fan-out selectors select the control and never the parked device', () => {
    it('policy assignment-target resolution', async () => {
      const ids = await withSystemDbAccessContext(() => __resolveDevicesForAssignmentTarget('partner', f.partnerId));
      expect(ids).toContain(f.control);
      expect(ids).not.toContain(f.parked);
    });

    it('backup assigned devices', async () => {
      const customer = await withSystemDbAccessContext(() => resolveAllBackupAssignedDevices(f.customerOrgId));
      expect(customer.map((d) => d.deviceId)).toContain(f.control);
      const holding = await withSystemDbAccessContext(() => resolveAllBackupAssignedDevices(f.holdingOrgId));
      expect(holding.map((d) => d.deviceId)).not.toContain(f.parked);
    });

    it('update-ring devices', async () => {
      const ids = await withSystemDbAccessContext(() => resolveRingDeviceIds(f.ringId));
      expect(ids).toContain(f.control);
      expect(ids).not.toContain(f.parked);
    });

    it('scheduled CIS scan targets for a partner-wide baseline', async () => {
      const rows = await withSystemDbAccessContext(() =>
        selectCisScanTargetDevices({ orgId: null, partnerId: f.partnerId, osType: 'windows' }));
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(f.control);
      expect(ids).not.toContain(f.parked);
    });
  });

  describe('delivery refuses or skips the parked device', () => {
    it('queueCommand refuses a non-removal command and writes no row', async () => {
      await expect(withSystemDbAccessContext(() =>
        queueCommand(f.parked, 'script', { scriptId: 'noop', content: 'echo' }),
      )).rejects.toBeInstanceOf(ParkedDeviceCommandRefusedError);
      const control = await withSystemDbAccessContext(() =>
        queueCommand(f.control, 'script', { scriptId: 'noop', content: 'echo' }));
      expect(control.id).toBeTruthy();
    });

    it('the claim path hands the parked device no non-removal work', async () => {
      const claimed = await withSystemDbAccessContext(() => claimPendingCommandsForDevice(f.parked, 10, 'agent'));
      expect(claimed.filter((c) => !isParkedDeliverableCommandType(c.type))).toEqual([]);
    });

    it('remote access and AI device access deny the parked device, allow the control', async () => {
      await expect(withSystemDbAccessContext(() => checkRemoteAccess(f.parked, 'remoteTools')))
        .resolves.toMatchObject({ allowed: false, code: 'DEVICE_PENDING_ASSIGNMENT' });
      await expect(withSystemDbAccessContext(() => checkRemoteAccess(f.control, 'remoteTools')))
        .resolves.toEqual({ allowed: true });
      await expect(withSystemDbAccessContext(() => verifyDeviceAccess(f.parked, systemAuth)))
        .resolves.toEqual({ error: 'Device not found or access denied' });
    });

    it('mark-offline writes the parked device offline, counts it as a transition, and persists no effect', async () => {
      const [row] = await getTestDb().select({ lastSeenAt: devices.lastSeenAt, orgId: devices.orgId })
        .from(devices).where(eq(devices.id, f.parked)).limit(1);
      const observed = row!.lastSeenAt!.toISOString();
      const result = await processMarkOffline({
        type: 'mark-offline',
        transitionId: offlineTransitionId(row!.orgId, f.parked, observed),
        deviceId: f.parked,
        orgId: row!.orgId,
        observedLastSeenAt: observed,
      } as never);
      expect(result).toEqual({ transitioned: true, alertCreated: false });
      const [after] = await getTestDb().select({ status: devices.status }).from(devices).where(eq(devices.id, f.parked));
      expect(after!.status).toBe('offline');
      const effects = await getTestDb().select({ id: offlineTransitionEffects.id })
        .from(offlineTransitionEffects).where(eq(offlineTransitionEffects.deviceId, f.parked));
      expect(effects).toEqual([]);
    });

    it('going offline raises no event and no alert plan for the parked device', async () => {
      const observedAt = new Date().toISOString();
      const ids = await withSystemDbAccessContext(async () => {
        const [parkedRow] = await db.select().from(devices).where(eq(devices.id, f.parked)).limit(1);
        return persistOfflineTransition(parkedRow!, randomUUID(), observedAt);
      });
      expect(ids).toEqual([]);
      const parkedEffects = await getTestDb().select({ id: offlineTransitionEffects.id })
        .from(offlineTransitionEffects).where(eq(offlineTransitionEffects.deviceId, f.parked));
      expect(parkedEffects).toEqual([]);

      const controlIds = await withSystemDbAccessContext(async () => {
        const [controlRow] = await db.select().from(devices).where(eq(devices.id, f.control)).limit(1);
        return persistOfflineTransition(controlRow!, randomUUID(), observedAt);
      });
      expect(controlIds).toHaveLength(2);
      const controlEffects = await getTestDb().select({ kind: offlineTransitionEffects.kind })
        .from(offlineTransitionEffects)
        .where(and(eq(offlineTransitionEffects.deviceId, f.control)));
      expect(controlEffects.map((e) => e.kind).sort()).toEqual(['alert-plan', 'offline-event']);
    });
  });
});
