import './setup';

import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { deviceCommands, devices, organizations } from '../../db/schema';
import { AGENT_TOKEN_SUSPEND_REASON } from '../../services/agentTokenSuspension';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { beginOrganizationOffboarding } from '../../services/tenantOffboarding';
import { getAgentTenantState, invalidateAgentTenantCache } from '../../services/tenantStatus';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

/**
 * #2785 — offboarding drain entered from `suspended`/`churned`.
 *
 * The mocked unit suite can only prove that the drain issues an UPDATE with the
 * right WHERE clause. The property that actually matters is DELIVERABILITY: a
 * device that was token-suspended by an earlier sever must, after the
 * transition, be able to CLAIM its queued `self_uninstall`. agentAuthMiddleware
 * 401s on `devices.agent_token_suspended_at` *before* it ever reaches the drain
 * narrowing, so leaving the column set means the uninstall sits `pending` for
 * the whole 72h window and the tenant finalizes with a "never drained" report —
 * the exact failure #2774 exists to remove.
 *
 * This drives the real service against real Postgres: real enum values, real
 * RLS/system contexts, real `device_commands` claim CAS.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

const SUSPEND_REASON = AGENT_TOKEN_SUSPEND_REASON.tenantSuspended;
const PROBE_REASON = AGENT_TOKEN_SUSPEND_REASON.crossTenantProbe;

async function seedDevice(
  orgId: string,
  siteId: string,
  label: string,
  suspendedReason: string | null
): Promise<{ id: string }> {
  const agentId = `agent-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId,
      hostname: `host-${label}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
      // The precondition: an earlier sever (or a cross-tenant probe) already
      // locked this device's agent token.
      agentTokenSuspendedAt: suspendedReason ? new Date() : null,
      agentTokenSuspendedReason: suspendedReason,
    })
    .returning({ id: devices.id });
  return { id: row!.id };
}

/**
 * The PATCH route commits `status='offboarding'` BEFORE calling
 * begin*Offboarding (see tenantOffboarding.repairIncompleteEntry's comment), so
 * the fixture must do the same or getAgentTenantState would never report
 * 'draining'.
 */
async function commitOffboardingStatus(orgId: string): Promise<void> {
  await getTestDb()
    .update(organizations)
    .set({ status: 'offboarding', updatedAt: new Date() })
    .where(eq(organizations.id, orgId));
  await invalidateAgentTenantCache([orgId]);
}

async function readSuspension(deviceId: string) {
  const [row] = await getTestDb()
    .select({
      suspendedAt: devices.agentTokenSuspendedAt,
      reason: devices.agentTokenSuspendedReason,
    })
    .from(devices)
    .where(eq(devices.id, deviceId));
  return row!;
}

async function readPendingUninstalls(deviceId: string) {
  return getTestDb()
    .select({ id: deviceCommands.id, status: deviceCommands.status })
    .from(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, 'self_uninstall')));
}

describe('#2785 offboarding drain entered from a severed state', () => {
  runDb(
    'a previously tenant-suspended device can actually CLAIM its queued self_uninstall',
    async () => {
      const partner = await createPartner({ status: 'active' });
      // Entering the drain from `suspended` — the transition #2781 never covered.
      const org = await createOrganization({ partnerId: partner.id, status: 'suspended' });
      const site = await createSite({ orgId: org.id });
      const stranded = await seedDevice(org.id, site.id, 'stranded', SUSPEND_REASON);

      await commitOffboardingStatus(org.id);
      await beginOrganizationOffboarding(org.id, null);

      // 1. The superseded suspension is gone, so agentAuthMiddleware's
      //    pre-tenant-state 401 no longer fires for this device.
      const after = await readSuspension(stranded.id);
      expect(after.suspendedAt).toBeNull();
      expect(after.reason).toBeNull();

      // 2. The tenant reads as draining, so the agent surface narrows rather
      //    than closing.
      await expect(getAgentTenantState(org.id)).resolves.toBe('draining');

      // 3. The uninstall was queued...
      const queued = await readPendingUninstalls(stranded.id);
      expect(queued).toHaveLength(1);
      expect(queued[0]!.status).toBe('pending');

      // 4. ...and is genuinely deliverable: the drain-narrowed claim (the exact
      //    allowlist routes/agents/commands.ts passes when tenantDraining) hands
      //    it over and CAS-flips it to `sent`. This is the end-to-end property;
      //    everything above is intermediate state.
      const claimed = await withSystemDbAccessContext(() =>
        claimPendingCommandsForDevice(stranded.id, 10, 'agent', ['self_uninstall'])
      );
      expect(claimed.map((row) => row.type)).toEqual(['self_uninstall']);

      const afterClaim = await readPendingUninstalls(stranded.id);
      expect(afterClaim[0]!.status).toBe('sent');
    }
  );

  runDb('churned → offboarding is equally deliverable', async () => {
    const partner = await createPartner({ status: 'active' });
    const org = await createOrganization({ partnerId: partner.id, status: 'churned' });
    const site = await createSite({ orgId: org.id });
    const stranded = await seedDevice(org.id, site.id, 'churned', SUSPEND_REASON);

    await commitOffboardingStatus(org.id);
    await beginOrganizationOffboarding(org.id, null);

    expect((await readSuspension(stranded.id)).suspendedAt).toBeNull();
    const claimed = await withSystemDbAccessContext(() =>
      claimPendingCommandsForDevice(stranded.id, 10, 'agent', ['self_uninstall'])
    );
    expect(claimed.map((row) => row.type)).toEqual(['self_uninstall']);
  });

  runDb(
    'a probe-suspended device stays suspended, and another tenant is never touched',
    async () => {
      const partner = await createPartner({ status: 'active' });
      const org = await createOrganization({ partnerId: partner.id, status: 'suspended' });
      const site = await createSite({ orgId: org.id });
      const stranded = await seedDevice(org.id, site.id, 'stranded', SUSPEND_REASON);
      // Same org, different reason tag: a security suspension the drain must NOT
      // launder into a working credential.
      const probed = await seedDevice(org.id, site.id, 'probed', PROBE_REASON);

      // A completely separate tenant, also tenant-suspended: the restore is
      // scoped to the draining org ids, so this must be untouched.
      const otherPartner = await createPartner({ status: 'suspended' });
      const otherOrg = await createOrganization({
        partnerId: otherPartner.id,
        status: 'suspended',
      });
      const otherSite = await createSite({ orgId: otherOrg.id });
      const bystander = await seedDevice(otherOrg.id, otherSite.id, 'bystander', SUSPEND_REASON);

      await commitOffboardingStatus(org.id);
      await beginOrganizationOffboarding(org.id, null);

      expect((await readSuspension(stranded.id)).suspendedAt).toBeNull();

      const probeAfter = await readSuspension(probed.id);
      expect(probeAfter.suspendedAt).not.toBeNull();
      expect(probeAfter.reason).toBe(PROBE_REASON);

      const bystanderAfter = await readSuspension(bystander.id);
      expect(bystanderAfter.suspendedAt).not.toBeNull();
      expect(bystanderAfter.reason).toBe(SUSPEND_REASON);
      // ...and no command was queued into the bystander tenant.
      expect(await readPendingUninstalls(bystander.id)).toHaveLength(0);
    }
  );
});
