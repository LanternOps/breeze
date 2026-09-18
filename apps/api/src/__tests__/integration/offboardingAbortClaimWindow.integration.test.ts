import './setup';

import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceCommands, devices, organizations } from '../../db/schema';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import {
  abortOrganizationOffboarding,
  abortOrganizationOffboardingAroundStatusChange,
} from '../../services/tenantOffboarding';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

/**
 * #3996 — a tenant abort must not open a window in which the drain's queued
 * `self_uninstall` is collectable as an ORDINARY command.
 *
 * THE BUG. The drain narrowing is keyed on `organizations.status ===
 * 'offboarding'` (`getAgentTenantState`). The instant the abort's status write
 * is visible the tenant is no longer draining, so every agent under it
 * authenticates on the normal path — where `claimPendingCommandsForDevice` is
 * called with NO type allowlist and `self_uninstall` is exempt from every
 * claim-time eligibility cancel (`DRAIN_EXEMPT_TYPES`,
 * `commandClaimEligibility.ts`). A still-`pending` row is therefore an
 * ordinary claimable command, and the blast radius is the tenant's whole fleet.
 * On the #2879 suspended-lifecycle override path the window was genuinely
 * COMMITTED: the status UPDATE ran in its own short system transaction and the
 * cancel opened a second one afterwards.
 *
 * WHAT ACTUALLY CLOSES IT, and why this is a real-Postgres test. Reordering
 * alone does not: while the abort transaction is open the last committed state
 * is still `offboarding` with pending rows, and an agent request proceeds
 * against that in its own transaction. The mechanism is the LOCK —
 * `claimPendingCommandsForDevice` selects candidates `FOR UPDATE SKIP LOCKED`,
 * so a row the abort has already locked is SKIPPED by a concurrent claim
 * rather than delivered. That is a property of Postgres row locking across two
 * connections; no mocked suite can assert it. The unit suite
 * (`services/tenantOffboarding.test.ts`) pins the ORDER of the statements;
 * this file pins that the order has the effect it is there for.
 *
 * HARNESS. The claim is issued from inside the `applyStatusChange` callback —
 * the exact moment the route's status write happens, with the abort's locks
 * held and nothing committed — and `runOutsideDbContext` puts it on its own
 * pool connection rather than joining the abort's transaction. It cannot
 * deadlock the test: `SKIP LOCKED` never waits.
 *
 * THE CONTROL IS LOAD-BEARING. "The claim returned nothing" is exactly what a
 * broken harness also reports (a device the claim path rejects for some
 * unrelated reason, a wrong `targetRole`, an unseeded row). The second case
 * stages the PRE-FIX shape — status flip committed first, cancel afterwards —
 * against an identically seeded tenant and asserts the claim DOES collect the
 * uninstall and flip it to `sent`. Both cases must hold for either to mean
 * anything, and the control is also the executable record of the defect.
 *
 * VERIFIED TO DISCRIMINATE, against this Postgres:
 *  - Control, before `ordinaryClaim` established a DB access context: red with
 *    `[]` — the claim's `devices` read was a contextless DENY, so the whole
 *    file would have passed vacuously. Fixed in the helper; see its comment.
 *  - `lockDrainUninstallsForOrgIds` DELETED from
 *    `abortOrganizationOffboardingAroundStatusChange` (reordering kept): the
 *    first case reds with `['self_uninstall']` claimed mid-abort. So the lock,
 *    not the order, is what closes the window — the property this file exists
 *    to pin.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

interface DrainingTenant {
  orgId: string;
  deviceId: string;
  commandId: string;
}

let seedCounter = 0;

/**
 * An org mid-drain: `offboarding` + a live stamp + one pending, tenant-owned
 * `self_uninstall` on one device. `targetRole` and a null `deliverBy` match
 * what `queueDrainUninstalls` writes, because the claim's own predicate
 * filters on both.
 */
async function seedDrainingTenant(label: string): Promise<DrainingTenant> {
  seedCounter += 1;
  const suffix = `${Date.now()}-${seedCounter}-${Math.random().toString(36).slice(2, 8)}`;
  const partner = await createPartner({ status: 'active' });
  const org = await createOrganization({ partnerId: partner.id, status: 'active' });
  const site = await createSite({ orgId: org.id });

  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `agent-3996-${label}-${suffix}`,
      hostname: `host-3996-${label}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!device) throw new Error('seedDrainingTenant: device insert returned no row');

  const [command] = await getTestDb()
    .insert(deviceCommands)
    .values({
      deviceId: device.id,
      type: 'self_uninstall',
      status: 'pending',
      targetRole: 'agent',
      payload: {},
      uninstallReasons: ['tenant_offboarding'],
    })
    .returning({ id: deviceCommands.id });
  if (!command) throw new Error('seedDrainingTenant: command insert returned no row');

  await withSystemDbAccessContext(async () => {
    await getTestDb()
      .update(organizations)
      .set({ status: 'offboarding', offboardingStartedAt: new Date(), updatedAt: new Date() })
      .where(eq(organizations.id, org.id));
  });

  return { orgId: org.id, deviceId: device.id, commandId: command.id };
}

/**
 * The claim an agent makes on the ORDINARY path: no type allowlist.
 *
 * `runOutsideDbContext` puts it on its own pool connection instead of joining
 * the abort's transaction, and the fresh context inside is not optional: the
 * claim reads `devices`, which is RLS-protected, and a CONTEXTLESS read there
 * is a DENY (not a bypass). Without it the claim returns `[]` for want of a
 * visible device row and every assertion below would pass vacuously — which
 * is precisely what the control case caught while this helper was wrong.
 */
async function ordinaryClaim(deviceId: string): Promise<string[]> {
  const claimed = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => claimPendingCommandsForDevice(deviceId, 10, 'agent'))
  );
  return claimed.map((row) => row.type);
}

async function readCommand(commandId: string) {
  const [row] = await getTestDb()
    .select({
      status: deviceCommands.status,
      result: deviceCommands.result,
      uninstallReasons: deviceCommands.uninstallReasons,
    })
    .from(deviceCommands)
    .where(eq(deviceCommands.id, commandId));
  return row;
}

async function readOrgStatus(orgId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    getTestDb()
      .select({
        status: organizations.status,
        offboardingStartedAt: organizations.offboardingStartedAt,
      })
      .from(organizations)
      .where(and(eq(organizations.id, orgId)))
  );
  return row;
}

describe('#3996 — the abort locks the drain uninstalls before the status flip', () => {
  runDb(
    'an ordinary claim landing mid-abort collects nothing, and the row ends cancelled',
    async () => {
      const tenant = await seedDrainingTenant('locked');

      let claimedMidAbort: string[] | undefined;
      const result = await abortOrganizationOffboardingAroundStatusChange(
        tenant.orgId,
        async () => {
          // The route's own status write, with the abort's locks already
          // held. It MUST go through the app `db` (which resolves to the
          // abort's ambient transaction), not `getTestDb()` — the harness pool
          // is a separate connection and would simply block on the org row
          // this transaction has locked.
          const [row] = await db
            .update(organizations)
            .set({ status: 'active', updatedAt: new Date() })
            .where(eq(organizations.id, tenant.orgId))
            .returning({ id: organizations.id });
          // A heartbeat lands in the window, on a separate connection. The
          // tenant is (as far as any other transaction can tell) still
          // offboarding with a pending uninstall — but the row is locked.
          claimedMidAbort = await ordinaryClaim(tenant.deviceId);
          return row;
        }
      );

      expect(claimedMidAbort, 'SKIP LOCKED must skip the row the abort holds').toEqual([]);
      expect(result.abort).toEqual({ aborted: true, uninstallsCancelled: 1 });

      const command = await readCommand(tenant.commandId);
      expect(command?.status).toBe('cancelled');
      expect(command?.result).toEqual({ reason: 'organization_offboarding_aborted' });

      const org = await readOrgStatus(tenant.orgId);
      expect(org?.status).toBe('active');
      expect(org?.offboardingStartedAt).toBeNull();

      // And the row stays uncollectable afterwards — terminal, not pending.
      expect(await ordinaryClaim(tenant.deviceId)).toEqual([]);
    }
  );

  runDb(
    'CONTROL — the pre-fix shape (flip committed, cancel afterwards) delivers the uninstall to the fleet',
    async () => {
      const tenant = await seedDrainingTenant('prefix');

      // Exactly what the #2879 override branch used to do: commit the status
      // write in its own transaction, then abort in a second one.
      await withSystemDbAccessContext(async () => {
        await getTestDb()
          .update(organizations)
          .set({ status: 'active', updatedAt: new Date() })
          .where(eq(organizations.id, tenant.orgId));
      });

      // The heartbeat that lands between the two commits.
      expect(
        await ordinaryClaim(tenant.deviceId),
        'the defect: an ordinary claim collects the drain uninstall'
      ).toEqual(['self_uninstall']);
      expect((await readCommand(tenant.commandId))?.status).toBe('sent');

      // And the cancel that follows can no longer stop it: the payload is
      // already on the wire. It does still terminalise the row (`sent` is
      // covered by NON_TERMINAL_COMMAND_STATUSES) — which is exactly why the
      // cancelled count alone can never be the assertion that this bug is
      // fixed. Closing the residual is #3995's agent-side fence.
      const abort = await abortOrganizationOffboarding(tenant.orgId);
      expect(abort.aborted).toBe(true);
    }
  );
});
