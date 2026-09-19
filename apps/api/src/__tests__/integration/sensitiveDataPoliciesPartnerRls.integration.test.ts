/**
 * sensitive_data_policies RLS — dual-axis (org OR partner) enforcement
 * (#2131, epic #2135).
 *
 * Migration under test: 2026-07-01-sensitive-data-policies-partner-ownership.sql.
 *
 * A sensitive-data policy is owned by EITHER an org (org_id set, partner_id
 * NULL) OR a partner (partner_id set, org_id NULL — partner-wide / "all
 * orgs"). Scans and findings stay owned by the scanned DEVICE's org. Same
 * dual-axis contract-test blindspot as the sibling suites: this functional
 * test through the REAL postgres.js driver (breeze_app role) is the guard
 * that a partner cannot forge a partner_id for another partner.
 *
 * The second describe block proves the scheduler fan-out (#1724 trap): a
 * stored partner-wide policy must actually queue scans for devices across
 * every org under the owning partner, with each scan row carrying the
 * DEVICE's org.
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import postgres from 'postgres';
import { Hono } from 'hono';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  deviceCommands,
  devices,
  organizationUsers,
  partnerUsers,
  permissions,
  rolePermissions,
  sensitiveDataPolicies,
  sensitiveDataScans,
  sites,
  users,
} from '../../db/schema';
import {
  getSensitiveDataQueue,
  processDispatchScan,
  schedulePolicyScans,
  shutdownSensitiveDataWorkers,
} from '../../jobs/sensitiveDataJobs';
import { createOrganization, createPartner, createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import {
  captureSensitiveDataAuthority,
  captureSystemSensitiveDataAuthority,
  resolveSensitiveDataAuthority,
  type SensitiveDataPolicyOwner,
} from '../../services/sensitiveDataPolicyAuthority';
import type { AuthContext } from '../../middleware/auth';
import { clearPermissionCache } from '../../services/permissions';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { sensitiveDataRoutes } from '../../routes/sensitiveData';

const createdPolicies: string[] = [];
const createdDevices: string[] = [];
const createdSites: string[] = [];

const AUTHORITY_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-10-15-140001-sensitive-data-schedule-authority.sql',
);
const AUTHORITY_GENERATION_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-10-15-140002-sensitive-data-authority-generation.sql',
);
const MIXED_VERSION_GUARD_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-10-15-140003-sensitive-data-mixed-version-guard.sql',
);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

afterEach(async () => {
  if (createdPolicies.length === 0 && createdDevices.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdDevices.length > 0) {
      await db.delete(deviceCommands).where(inArray(deviceCommands.deviceId, createdDevices));
    }
    if (createdPolicies.length > 0) {
      await db
        .delete(sensitiveDataScans)
        .where(inArray(sensitiveDataScans.policyId, createdPolicies));
    }
    for (const id of createdPolicies) {
      await db.delete(sensitiveDataPolicies).where(eq(sensitiveDataPolicies.id, id));
    }
    for (const id of createdDevices) {
      await db.delete(devices).where(eq(devices.id, id));
    }
    for (const id of createdSites) {
      await db.delete(sites).where(eq(sites.id, id));
    }
  });
  createdPolicies.length = 0;
  createdDevices.length = 0;
  createdSites.length = 0;
  // The scheduler touches the BullMQ queue; close any lazily-created
  // connection so the vitest process can exit cleanly.
  await shutdownSensitiveDataWorkers();
});

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

/**
 * An ORG-scoped session. `currentPartnerId` mirrors what
 * `buildDbAccessContext` (middleware/auth.ts) actually puts on an org token —
 * the token's OWN partner, populated for every scope and distinct from
 * `accessiblePartnerIds`, which stays empty for org scope. It is what the
 * `*_partner_wide_select` read branch (#4953) keys on, so a test that omits it
 * is exercising a context with no partner GUC at all, not an org token's, and
 * any "org scope sees nothing" assertion under it is vacuous.
 */
function orgContext(orgId: string, currentPartnerId: string | null = null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

const BASE_POLICY = {
  name: 'Partner-wide PII sweep',
  scope: {},
  detectionClasses: ['pii', 'credential'],
  isActive: true,
};

function systemAuthority(owner: SensitiveDataPolicyOwner) {
  return captureSystemSensitiveDataAuthority(owner);
}

async function seedPartnerPolicy(partnerId: string, schedule: Record<string, unknown> | null = null): Promise<string> {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(sensitiveDataPolicies)
      .values({
        ...BASE_POLICY, schedule, orgId: null, partnerId,
        ...systemAuthority({ orgId: null, partnerId }),
      })
      .returning(),
  );
  const id = rows[0]!.id;
  createdPolicies.push(id);
  return id;
}

describe('sensitive_data_policies RLS — dual-axis (2026-07-01 migration)', () => {
  it('partner scope can INSERT a partner-wide policy (org_id NULL, partner_id set)', async () => {
    const partner = await createPartner();

    const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(sensitiveDataPolicies)
        .values({ ...BASE_POLICY, orgId: null, partnerId: partner.id })
        .returning(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBeNull();
    expect(rows[0]?.partnerId).toBe(partner.id);
    if (rows[0]) createdPolicies.push(rows[0].id);
  });

  it('a different partner can neither see nor forge a policy attributed to the first partner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const id = await seedPartnerPolicy(partnerA.id);

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db.select({ id: sensitiveDataPolicies.id }).from(sensitiveDataPolicies).where(eq(sensitiveDataPolicies.id, id)),
    );
    expect(visibleToB).toEqual([]);

    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db
          .insert(sensitiveDataPolicies)
          .values({ ...BASE_POLICY, name: 'Forged partner-wide', orgId: null, partnerId: partnerA.id })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // #4953 flipped this. It used to assert org scope could not see a
  // partner-wide policy at all — but the fixture never set `currentPartnerId`,
  // so it was exercising a context with no partner GUC and passed for the wrong
  // reason. `sensitive_data_policies_partner_wide_select`
  // (2026-10-11-000200-software-security-partner-wide-select.sql) now grants an
  // org token a SELECT-only view of its OWN partner's partner-wide rows, which
  // is what every request-path reader previously bought with a nested
  // system-context escalation. Writes are unchanged; the full read/write matrix
  // for all five software-security tables lives in
  // softwareSecurityPartnerWideSelect.integration.test.ts.
  it('an org-scope caller of the owning partner CAN read a partner-wide policy but cannot write it', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const id = await seedPartnerPolicy(partner.id);

    const visibleToOrg = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db.select({ id: sensitiveDataPolicies.id }).from(sensitiveDataPolicies).where(eq(sensitiveDataPolicies.id, id)),
    );
    expect(visibleToOrg.map((r) => r.id)).toEqual([id]);

    // The branch is FOR SELECT only: RLS hides the row from the write command
    // rather than raising, so assert the ROW COUNT — "it didn't throw" would be
    // satisfied by a successful hijack.
    const updated = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db
        .update(sensitiveDataPolicies)
        .set({ name: 'HIJACKED' })
        .where(eq(sensitiveDataPolicies.id, id))
        .returning({ id: sensitiveDataPolicies.id }),
    );
    expect(updated).toEqual([]);
  });

  it('org scope can still INSERT and SELECT an org-scoped policy (unchanged shape)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const inserted = await withDbAccessContext(orgContext(org.id), () =>
      db
        .insert(sensitiveDataPolicies)
        .values({ ...BASE_POLICY, name: 'Org policy', orgId: org.id, partnerId: null })
        .returning(),
    );
    if (inserted[0]) createdPolicies.push(inserted[0].id);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.orgId).toBe(org.id);

    const visible = await withDbAccessContext(orgContext(org.id), () =>
      db
        .select({ id: sensitiveDataPolicies.id })
        .from(sensitiveDataPolicies)
        .where(eq(sensitiveDataPolicies.id, inserted[0]!.id)),
    );
    expect(visible.map((r) => r.id)).toContain(inserted[0]?.id);
  });

  it('the one-owner CHECK rejects a policy that sets BOTH axes and one that sets NEITHER', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(sensitiveDataPolicies)
          .values({ ...BASE_POLICY, name: 'Both axes', orgId: org.id, partnerId: partner.id })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(sensitiveDataPolicies)
          .values({ ...BASE_POLICY, name: 'No axis', orgId: null, partnerId: null })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('partner scope can UPDATE and DELETE its own partner-wide policy', async () => {
    const partner = await createPartner();
    const id = await seedPartnerPolicy(partner.id);

    const updated = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .update(sensitiveDataPolicies)
        .set({ name: 'Renamed sweep', isActive: false })
        .where(eq(sensitiveDataPolicies.id, id))
        .returning(),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]?.isActive).toBe(false);

    const deleted = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db.delete(sensitiveDataPolicies).where(eq(sensitiveDataPolicies.id, id)).returning(),
    );
    expect(deleted).toHaveLength(1);
    createdPolicies.splice(createdPolicies.indexOf(id), 1);
  });
});

// ============================================================
// Scheduler fan-out (#2131): the load-bearing SQL that makes a stored
// partner-wide policy actually queue scans. The producer previously targeted
// devices via eq(devices.orgId, policy.orgId), which silently matched ZERO
// devices for org_id NULL — the #1724 trap.
// ============================================================

describe('schedulePolicyScans — partner-wide scan fan-out (#2131)', () => {
  async function seedDevice(orgId: string, hostname: string): Promise<string> {
    const [site] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(sites).values({ orgId, name: 'HQ' }).returning(),
    );
    createdSites.push(site!.id);
    const [device] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(devices)
        .values({
          orgId,
          siteId: site!.id,
          agentId: `agent-${site!.id.slice(0, 18)}`,
          hostname,
          osType: 'windows',
          osVersion: '10.0',
          architecture: 'x64',
          agentVersion: '1.0.0',
        })
        .returning(),
    );
    createdDevices.push(device!.id);
    return device!.id;
  }

  it('a partner-wide policy queues scans for devices in EVERY member org, each scan carrying the DEVICE org', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA1 = await createOrganization({ partnerId: partnerA.id });
    const orgA2 = await createOrganization({ partnerId: partnerA.id });
    const orgB1 = await createOrganization({ partnerId: partnerB.id });

    const deviceA1 = await seedDevice(orgA1.id, 'sd-fanout-a1');
    const deviceA2 = await seedDevice(orgA2.id, 'sd-fanout-a2');
    const deviceB1 = await seedDevice(orgB1.id, 'sd-fanout-b1');

    const policyId = await seedPartnerPolicy(partnerA.id, { enabled: true, type: 'interval', intervalMinutes: 60 });
    const [policy] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(sensitiveDataPolicies).where(eq(sensitiveDataPolicies.id, policyId)),
    );

    // The scheduler runs under system context (RLS bypass) — mirror that.
    const queued = await withDbAccessContext(SYSTEM_CTX, () => schedulePolicyScans(policy!, new Date()));
    expect(queued).toBe(2);

    const scanRows = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .select({ deviceId: sensitiveDataScans.deviceId, orgId: sensitiveDataScans.orgId })
        .from(sensitiveDataScans)
        .where(eq(sensitiveDataScans.policyId, policyId)),
    );

    const byDevice = new Map(scanRows.map((row) => [row.deviceId, row.orgId]));
    expect(byDevice.get(deviceA1)).toBe(orgA1.id); // scan row takes the DEVICE's org
    expect(byDevice.get(deviceA2)).toBe(orgA2.id);
    expect(byDevice.has(deviceB1)).toBe(false); // another partner's device NEVER matches
  });

  it('an org-owned policy still queues scans only for its own org (unchanged shape)', async () => {
    const partner = await createPartner();
    const org1 = await createOrganization({ partnerId: partner.id });
    const org2 = await createOrganization({ partnerId: partner.id });

    const device1 = await seedDevice(org1.id, 'sd-org-1');
    await seedDevice(org2.id, 'sd-org-2');

    const inserted = await withDbAccessContext(orgContext(org1.id), () =>
      db
        .insert(sensitiveDataPolicies)
        .values({
          ...BASE_POLICY,
          name: 'Org-owned sweep',
          schedule: { enabled: true, type: 'interval', intervalMinutes: 60 },
          orgId: org1.id,
          partnerId: null,
          ...systemAuthority({ orgId: org1.id, partnerId: null }),
        })
        .returning(),
    );
    createdPolicies.push(inserted[0]!.id);

    const queued = await withDbAccessContext(SYSTEM_CTX, () => schedulePolicyScans(inserted[0]!, new Date()));
    expect(queued).toBe(1);

    const scanRows = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .select({ deviceId: sensitiveDataScans.deviceId })
        .from(sensitiveDataScans)
        .where(eq(sensitiveDataScans.policyId, inserted[0]!.id)),
    );
    expect(scanRows.map((r) => r.deviceId)).toEqual([device1]);
  });

  it('runs as breeze_app but intersects stored and live selected-site execute authority', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [
        { resource: 'devices', action: 'write' },
        { resource: 'devices', action: 'execute' },
      ],
    });
    const hiddenSite = await createSite({ orgId: env.organization.id, name: 'Hidden' });
    createdSites.push(hiddenSite.id);
    const suffix = crypto.randomUUID().slice(0, 8);
    const insertedDevices = await withDbAccessContext(SYSTEM_CTX, () => db.insert(devices).values([
      {
        orgId: env.organization.id, siteId: env.site.id, agentId: `sd-visible-${suffix}`,
        hostname: `sd-visible-${suffix}`, osType: 'windows', osVersion: '11',
        architecture: 'x64', agentVersion: '1.0.0', status: 'online',
      },
      {
        orgId: env.organization.id, siteId: hiddenSite.id, agentId: `sd-hidden-${suffix}`,
        hostname: `sd-hidden-${suffix}`, osType: 'linux', osVersion: '1',
        architecture: 'x64', agentVersion: '1.0.0',
      },
    ]).returning({ id: devices.id }));
    createdDevices.push(...insertedDevices.map((row) => row.id));

    await withDbAccessContext(SYSTEM_CTX, () => db
      .update(organizationUsers)
      .set({ siteIds: [env.site.id] })
      .where(and(eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id))));
    await clearPermissionCache(env.user.id);

    const owner = { orgId: env.organization.id, partnerId: null } as const;
    const authority = captureSensitiveDataAuthority({
      scope: 'organization', user: env.user, orgId: env.organization.id,
      partnerId: env.partner.id, partnerOrgAccess: null,
      accessibleOrgIds: [env.organization.id], orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === env.organization.id,
      allowedSiteIds: [env.site.id], canAccessSite: (id: string | null) => id === env.site.id,
    } as unknown as AuthContext, owner)!;
    const token = await createAccessToken({
      sub: env.user.id, email: env.user.email, roleId: env.role.id,
      orgId: env.organization.id, partnerId: env.partner.id, scope: 'organization',
      mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    } satisfies Omit<TokenPayload, 'type'>);
    const app = new Hono();
    app.route('/sensitive-data', sensitiveDataRoutes);
    const denied = await app.request('/sensitive-data/policies', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Hidden explicit target', detectionClasses: ['credential'],
        schedule: {
          enabled: true, type: 'interval', intervalMinutes: 60,
          deviceIds: insertedDevices.map((row) => row.id),
        },
      }),
    });
    expect(denied.status).toBe(403);

    const allowed = await app.request('/sensitive-data/policies', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Selected-site recurring scan', detectionClasses: ['credential'],
        schedule: { enabled: true, type: 'interval', intervalMinutes: 60 },
      }),
    });
    expect(allowed.status, await allowed.clone().text()).toBe(201);
    const allowedBody = await allowed.json() as { data: { id: string } };
    const [policy] = await withDbAccessContext(SYSTEM_CTX, () => db
      .select().from(sensitiveDataPolicies).where(eq(sensitiveDataPolicies.id, allowedBody.data.id)));
    createdPolicies.push(policy!.id);

    const queued = await withDbAccessContext(SYSTEM_CTX, () => schedulePolicyScans(policy!, new Date()));
    expect(queued).toBe(1);
    const scans = await withDbAccessContext(SYSTEM_CTX, () => db
      .select({
        id: sensitiveDataScans.id,
        deviceId: sensitiveDataScans.deviceId,
        requestedBy: sensitiveDataScans.requestedBy,
        authorityGeneration: sensitiveDataScans.policyAuthorityGeneration,
      })
      .from(sensitiveDataScans)
      .where(eq(sensitiveDataScans.policyId, policy!.id)));
    expect(scans).toEqual([expect.objectContaining({ deviceId: insertedDevices[0]!.id, requestedBy: env.user.id })]);

    // No websocket is registered for this synthetic agent. This exercises the
    // full authorized dispatch boundary and durable command creation without
    // delivering a frame to, or executing a payload on, an agent.
    const dispatched = await withDbAccessContext(SYSTEM_CTX, () => processDispatchScan({
      type: 'dispatch-scan', scanId: scans[0]!.id, origin: 'policy_scheduler',
      authorityGeneration: scans[0]!.authorityGeneration!,
    }));
    expect(dispatched).toEqual({ dispatched: true, commandId: expect.any(String) });
    const [createdCommand] = await withDbAccessContext(SYSTEM_CTX, () => db
      .select({
        id: deviceCommands.id,
        deviceId: deviceCommands.deviceId,
        type: deviceCommands.type,
        payload: deviceCommands.payload,
        status: deviceCommands.status,
        createdBy: deviceCommands.createdBy,
        executedAt: deviceCommands.executedAt,
        completedAt: deviceCommands.completedAt,
        result: deviceCommands.result,
      })
      .from(deviceCommands)
      .where(eq(deviceCommands.id, dispatched.commandId!)));
    expect(createdCommand).toEqual({
      id: dispatched.commandId,
      deviceId: insertedDevices[0]!.id,
      type: 'sensitive_data_scan',
      payload: {
        scanId: scans[0]!.id,
        policyId: policy!.id,
        scope: {},
        detectionClasses: ['credential'],
        authorityGeneration: scans[0]!.authorityGeneration,
      },
      status: 'pending',
      createdBy: env.user.id,
      executedAt: null,
      completedAt: null,
      result: null,
    });
    await withDbAccessContext(SYSTEM_CTX, () => db.update(deviceCommands)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(deviceCommands.id, dispatched.commandId!)));
    await withDbAccessContext(SYSTEM_CTX, () => db.update(sensitiveDataScans)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(sensitiveDataScans.id, scans[0]!.id)));

    // Reapproval always rotates the generation. A scan admitted by the old
    // approval cannot create a command; a newly scheduled scan can.
    const [generationPolicy] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(sensitiveDataPolicies).values({
      ...BASE_POLICY, name: 'Generation-bound scan', orgId: owner.orgId, partnerId: null,
      schedule: { enabled: true, type: 'interval', intervalMinutes: 60 },
      createdBy: env.user.id, ...authority,
    }).returning());
    createdPolicies.push(generationPolicy!.id);
    expect(await withDbAccessContext(SYSTEM_CTX, () => schedulePolicyScans(generationPolicy!, new Date()))).toBe(1);
    const [oldGenerationScan] = await withDbAccessContext(SYSTEM_CTX, () => db.select({
      id: sensitiveDataScans.id,
      authorityGeneration: sensitiveDataScans.policyAuthorityGeneration,
    }).from(sensitiveDataScans).where(eq(sensitiveDataScans.policyId, generationPolicy!.id)));
    const replacementAuthority = captureSensitiveDataAuthority({
      scope: 'organization', user: env.user, orgId: env.organization.id,
      partnerId: env.partner.id, partnerOrgAccess: null,
      accessibleOrgIds: [env.organization.id], orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === env.organization.id,
      allowedSiteIds: [env.site.id], canAccessSite: (id: string | null) => id === env.site.id,
    } as unknown as AuthContext, owner)!;
    expect(replacementAuthority.executionAuthorityGeneration).not.toBe(oldGenerationScan!.authorityGeneration);
    const [reapprovedPolicy] = await withDbAccessContext(SYSTEM_CTX, () => db.update(sensitiveDataPolicies).set({
      ...replacementAuthority,
      schedule: { enabled: true, type: 'interval', intervalMinutes: 60 },
    }).where(eq(sensitiveDataPolicies.id, generationPolicy!.id)).returning());
    expect(await withDbAccessContext(SYSTEM_CTX, () => processDispatchScan({
      type: 'dispatch-scan', scanId: oldGenerationScan!.id, origin: 'policy_scheduler',
      authorityGeneration: oldGenerationScan!.authorityGeneration!,
    }))).toEqual({ dispatched: false, commandId: null });
    expect(await withDbAccessContext(SYSTEM_CTX, () => schedulePolicyScans(
      reapprovedPolicy!, new Date(Date.now() + 61 * 60 * 1000),
    ))).toBe(1);
    const generationScans = await withDbAccessContext(SYSTEM_CTX, () => db.select({
      id: sensitiveDataScans.id,
      authorityGeneration: sensitiveDataScans.policyAuthorityGeneration,
    }).from(sensitiveDataScans).where(eq(sensitiveDataScans.policyId, generationPolicy!.id)));
    const newGenerationScan = generationScans.find((candidate) => candidate.id !== oldGenerationScan!.id)!;
    const newGenerationDispatch = await withDbAccessContext(SYSTEM_CTX, () => processDispatchScan({
      type: 'dispatch-scan', scanId: newGenerationScan.id, origin: 'policy_scheduler',
      authorityGeneration: newGenerationScan.authorityGeneration!,
    }));
    expect(newGenerationDispatch).toEqual({ dispatched: true, commandId: expect.any(String) });
    const [newCommand] = await withDbAccessContext(SYSTEM_CTX, () => db.select({
      deviceId: deviceCommands.deviceId,
      type: deviceCommands.type,
      payload: deviceCommands.payload,
      createdBy: deviceCommands.createdBy,
    }).from(deviceCommands).where(eq(deviceCommands.id, newGenerationDispatch.commandId!)));
    expect(newCommand).toEqual({
      deviceId: insertedDevices[0]!.id,
      type: 'sensitive_data_scan',
      payload: {
        scanId: newGenerationScan.id,
        policyId: generationPolicy!.id,
        scope: {},
        detectionClasses: ['pii', 'credential'],
        authorityGeneration: newGenerationScan.authorityGeneration,
      },
      createdBy: env.user.id,
    });
    await withDbAccessContext(SYSTEM_CTX, () => db.update(deviceCommands)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(deviceCommands.id, newGenerationDispatch.commandId!)));
    await withDbAccessContext(SYSTEM_CTX, () => db.update(sensitiveDataScans)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(sensitiveDataScans.id, newGenerationScan.id)));

    // Mixed-version database enforcement: a pre-deploy producer's scheduled
    // scan has no durable generation, while a pre-deploy consumer omits the
    // generation from its command payload. Both must be unable to cross the
    // final endpoint-command boundary during a rolling update.
    const [oldProducerScan] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(sensitiveDataScans).values({
      orgId: env.organization.id, deviceId: insertedDevices[0]!.id,
      policyId: generationPolicy!.id, requestedBy: env.user.id, status: 'running',
      summary: { source: 'policy_scheduler' },
    }).returning({ id: sensitiveDataScans.id }));
    await expect(withDbAccessContext(SYSTEM_CTX, () => db.insert(deviceCommands).values({
      deviceId: insertedDevices[0]!.id, type: 'sensitive_data_scan', status: 'pending',
      payload: { scanId: oldProducerScan!.id }, createdBy: env.user.id,
    }))).rejects.toMatchObject({ cause: { code: '23514' } });

    const [oldConsumerScan] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(sensitiveDataScans).values({
      orgId: env.organization.id, deviceId: insertedDevices[0]!.id,
      policyId: generationPolicy!.id, requestedBy: env.user.id, status: 'running',
      policyAuthorityGeneration: replacementAuthority.executionAuthorityGeneration,
      summary: { source: 'policy_scheduler' },
    }).returning({ id: sensitiveDataScans.id }));
    await expect(withDbAccessContext(SYSTEM_CTX, () => db.insert(deviceCommands).values({
      deviceId: insertedDevices[0]!.id, type: 'sensitive_data_scan', status: 'pending',
      payload: { scanId: oldConsumerScan!.id }, createdBy: env.user.id,
    }))).rejects.toMatchObject({ cause: { code: '23514' } });
    await withDbAccessContext(SYSTEM_CTX, () => db.delete(sensitiveDataScans)
      .where(inArray(sensitiveDataScans.id, [oldProducerScan!.id, oldConsumerScan!.id])));

    // A throttled retry retains exact scheduled provenance in Redis. Rotating
    // approval before retry makes that delayed job stale and creates no
    // command. This never starts a worker or sends a frame to the agent.
    const [throttlePolicy] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(sensitiveDataPolicies).values({
      ...BASE_POLICY, name: 'Throttle provenance scan', orgId: owner.orgId, partnerId: null,
      schedule: { enabled: true, type: 'interval', intervalMinutes: 60 },
      createdBy: env.user.id, ...replacementAuthority,
    }).returning());
    createdPolicies.push(throttlePolicy!.id);
    expect(await withDbAccessContext(SYSTEM_CTX, () => schedulePolicyScans(throttlePolicy!, new Date()))).toBe(1);
    const [throttleScan] = await withDbAccessContext(SYSTEM_CTX, () => db.select({
      id: sensitiveDataScans.id, generation: sensitiveDataScans.policyAuthorityGeneration,
    }).from(sensitiveDataScans).where(eq(sensitiveDataScans.policyId, throttlePolicy!.id)));
    const [blockerScan] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(sensitiveDataScans).values({
      orgId: env.organization.id, deviceId: insertedDevices[0]!.id,
      requestedBy: env.user.id, status: 'running', summary: { source: 'manual' },
    }).returning({ id: sensitiveDataScans.id }));
    const throttleData = {
      type: 'dispatch-scan' as const, scanId: throttleScan!.id,
      origin: 'policy_scheduler' as const, authorityGeneration: throttleScan!.generation!,
    };
    expect(await withDbAccessContext(SYSTEM_CTX, () => processDispatchScan(throttleData)))
      .toEqual({ dispatched: false, commandId: null });
    const delayed = await getSensitiveDataQueue().getJobs(['delayed']);
    const retry = delayed.find((job) => (
      job.data.type === 'dispatch-scan' && job.data.scanId === throttleScan!.id
    ));
    expect(retry?.data).toEqual(throttleData);
    const retryData = retry?.data;
    if (!retryData || retryData.type !== 'dispatch-scan') {
      throw new Error('expected exact delayed dispatch retry');
    }
    await withDbAccessContext(SYSTEM_CTX, () => db.delete(sensitiveDataScans)
      .where(eq(sensitiveDataScans.id, blockerScan!.id)));
    const rotatedThrottleAuthority = captureSensitiveDataAuthority({
      scope: 'organization', user: env.user, orgId: env.organization.id,
      partnerId: env.partner.id, partnerOrgAccess: null,
      accessibleOrgIds: [env.organization.id], orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === env.organization.id,
      allowedSiteIds: [env.site.id], canAccessSite: (id: string | null) => id === env.site.id,
    } as unknown as AuthContext, owner)!;
    await withDbAccessContext(SYSTEM_CTX, () => db.update(sensitiveDataPolicies)
      .set({ ...rotatedThrottleAuthority })
      .where(eq(sensitiveDataPolicies.id, throttlePolicy!.id)));
    expect(await withDbAccessContext(SYSTEM_CTX, () => processDispatchScan(retryData)))
      .toEqual({ dispatched: false, commandId: null });
    const throttleCommands = await withDbAccessContext(SYSTEM_CTX, () => db.select({ id: deviceCommands.id })
      .from(deviceCommands).where(sql`${deviceCommands.payload}->>'scanId' = ${throttleScan!.id}`));
    expect(throttleCommands).toHaveLength(0);

    // Deterministic current-site race: hold an uncommitted A->hidden move,
    // prove dispatch is blocked on that exact row, then commit. Dispatch must
    // re-read the moved device under lock and create zero command.
    const [racePolicy] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(sensitiveDataPolicies).values({
      ...BASE_POLICY, name: 'Concurrent site-move scan', orgId: owner.orgId, partnerId: null,
      schedule: { enabled: true, type: 'interval', intervalMinutes: 60 },
      createdBy: env.user.id, ...replacementAuthority,
    }).returning());
    createdPolicies.push(racePolicy!.id);
    expect(await withDbAccessContext(SYSTEM_CTX, () => schedulePolicyScans(racePolicy!, new Date()))).toBe(1);
    const [raceScan] = await withDbAccessContext(SYSTEM_CTX, () => db.select({
      id: sensitiveDataScans.id,
      authorityGeneration: sensitiveDataScans.policyAuthorityGeneration,
    }).from(sensitiveDataScans).where(eq(sensitiveDataScans.policyId, racePolicy!.id)));
    const holder = postgres(process.env.DATABASE_URL!, { max: 1 });
    const monitor = postgres(process.env.DATABASE_URL!, { max: 1 });
    let releaseMove!: () => void;
    let moved!: () => void;
    let holderPid = 0;
    const movedReady = new Promise<void>((resolve) => { moved = resolve; });
    const release = new Promise<void>((resolve) => { releaseMove = resolve; });
    // Observe every started operation immediately, including early readiness failures.
    const pending: Array<Promise<PromiseSettledResult<unknown>[]>> = [];
    const track = <T>(operation: Promise<T>): Promise<T> => {
      pending.push(Promise.allSettled([operation]));
      return operation;
    };
    let primaryFailed = false;
    try {
      const holderWork = track(holder.begin(async (tx) => {
        await tx`select set_config('breeze.scope', 'system', true)`;
        const [pidRow] = await tx<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
        holderPid = pidRow!.pid;
        await tx`update devices set site_id = ${hiddenSite.id} where id = ${insertedDevices[0]!.id}`;
        moved();
        await release;
      }));
      await Promise.race([
        movedReady,
        holderWork.then(() => { throw new Error('site move finished before dispatch was ready'); }),
      ]);
      const dispatchRace = track(withDbAccessContext(SYSTEM_CTX, () => processDispatchScan({
        type: 'dispatch-scan', scanId: raceScan!.id, origin: 'policy_scheduler',
        authorityGeneration: raceScan!.authorityGeneration!,
      })));
      let observedBlocked = false;
      for (let attempt = 0; attempt < 100 && !observedBlocked; attempt += 1) {
        const [state] = await monitor<{ blocked: boolean }[]>`
          select exists (
            select 1 from pg_stat_activity
            where ${holderPid}::int = any(pg_blocking_pids(pid))
          ) as blocked
        `;
        observedBlocked = state?.blocked === true;
        if (!observedBlocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      releaseMove();
      await holderWork;
      expect(observedBlocked).toBe(true);
      expect(await dispatchRace).toEqual({ dispatched: false, commandId: null });
      const raceCommands = await withDbAccessContext(SYSTEM_CTX, () => db.select({ id: deviceCommands.id })
        .from(deviceCommands).where(sql`${deviceCommands.payload}->>'scanId' = ${raceScan!.id}`));
      expect(raceCommands).toHaveLength(0);
      await withDbAccessContext(SYSTEM_CTX, () => db.update(devices)
        .set({ siteId: env.site.id }).where(eq(devices.id, insertedDevices[0]!.id)));
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      releaseMove();
      const settled = (await Promise.all(pending)).flat();
      const closed = await Promise.allSettled([
        Promise.resolve().then(() => holder.end()),
        Promise.resolve().then(() => monitor.end()),
      ]);
      const failed = [...settled, ...closed].find((result) => result.status === 'rejected');
      if (!primaryFailed && failed?.status === 'rejected') throw failed.reason;
    }

    const [concurrentPolicy] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(sensitiveDataPolicies).values({
      ...BASE_POLICY, name: 'Concurrent selected-site scan', orgId: owner.orgId, partnerId: null,
      schedule: { enabled: true, type: 'interval', intervalMinutes: 60 },
      createdBy: env.user.id, ...authority,
    }).returning());
    createdPolicies.push(concurrentPolicy!.id);
    const concurrent = await Promise.all([
      withDbAccessContext(SYSTEM_CTX, () => schedulePolicyScans(concurrentPolicy!, new Date())),
      withDbAccessContext(SYSTEM_CTX, () => schedulePolicyScans(concurrentPolicy!, new Date())),
    ]);
    expect(concurrent.reduce((sum, count) => sum + count, 0)).toBe(1);
    const concurrentScans = await withDbAccessContext(SYSTEM_CTX, () => db
      .select({ id: sensitiveDataScans.id, authorityGeneration: sensitiveDataScans.policyAuthorityGeneration })
      .from(sensitiveDataScans)
      .where(eq(sensitiveDataScans.policyId, concurrentPolicy!.id)));
    expect(concurrentScans).toHaveLength(1);

    await withDbAccessContext(SYSTEM_CTX, () => db
      .update(organizationUsers)
      .set({ siteIds: [] })
      .where(and(eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id))));
    await clearPermissionCache(env.user.id);
    expect(await withDbAccessContext(SYSTEM_CTX, () => processDispatchScan({
      type: 'dispatch-scan', scanId: concurrentScans[0]!.id, origin: 'policy_scheduler',
      authorityGeneration: concurrentScans[0]!.authorityGeneration!,
    }))).toEqual({ dispatched: false, commandId: null });
    const commands = await withDbAccessContext(SYSTEM_CTX, () => db
      .select({ id: deviceCommands.id, payload: deviceCommands.payload })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, insertedDevices[0]!.id)));
    expect(commands).toEqual(expect.arrayContaining([
      { id: dispatched.commandId, payload: createdCommand!.payload },
      { id: newGenerationDispatch.commandId, payload: newCommand!.payload },
    ]));
    expect(commands.some((command) => (
      command.payload as { scanId?: string } | null
    )?.scanId === concurrentScans[0]!.id)).toBe(false);
    expect(await withDbAccessContext(SYSTEM_CTX, () => schedulePolicyScans(
      policy!, new Date(Date.now() + 61 * 60 * 1000),
    ))).toBe(0);
    const afterRevoke = await withDbAccessContext(SYSTEM_CTX, () => db
      .select({ id: sensitiveDataScans.id })
      .from(sensitiveDataScans)
      .where(eq(sensitiveDataScans.policyId, policy!.id)));
    expect(afterRevoke).toHaveLength(1);
  });

  it('blocks an old API producer from writing an active recurring row with no authority envelope', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await seedDevice(org.id, 'legacy-sensitive-scan');
    await expect(withDbAccessContext(SYSTEM_CTX, () => db.insert(sensitiveDataPolicies).values({
      ...BASE_POLICY, name: 'Legacy recurring scan', orgId: org.id, partnerId: null,
      schedule: { enabled: true, type: 'interval', intervalMinutes: 60 },
    }).returning())).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('migration disables only active legacy recurring rows and is idempotent with nonzero data', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const validAuthority = systemAuthority({ orgId: org.id, partnerId: null });
    // Reconstruct the pre-rollout catalog state in this disposable database.
    // The migration re-adds and validates the guard before the test returns.
    await getTestDb().execute(sql.raw(
      'ALTER TABLE sensitive_data_policies DROP CONSTRAINT IF EXISTS sensitive_data_policies_recurring_authority_chk',
    ));
    const inserted = await withDbAccessContext(SYSTEM_CTX, () => db.insert(sensitiveDataPolicies).values([
      {
        ...BASE_POLICY, name: 'Legacy active interval', orgId: org.id, partnerId: null,
        schedule: { enabled: true, type: 'interval', intervalMinutes: 60 },
      },
      {
        ...BASE_POLICY, name: 'Legacy active cron', orgId: org.id, partnerId: null,
        schedule: { enabled: true, type: 'cron', cron: '0 * * * *' },
      },
      {
        ...BASE_POLICY, name: 'Legacy active manual', orgId: org.id, partnerId: null,
        schedule: { enabled: true, type: 'manual' },
      },
      {
        ...BASE_POLICY, name: 'Legacy inactive interval', orgId: org.id, partnerId: null,
        isActive: false, schedule: { enabled: true, type: 'interval', intervalMinutes: 60 },
      },
      {
        ...BASE_POLICY, name: 'Current authorized interval', orgId: org.id, partnerId: null,
        schedule: { enabled: true, type: 'interval', intervalMinutes: 60 },
        ...validAuthority,
      },
    ]).returning({ id: sensitiveDataPolicies.id, name: sensitiveDataPolicies.name }));
    createdPolicies.push(...inserted.map((policy) => policy.id));

    const migration = [
      AUTHORITY_MIGRATION_FILE,
      AUTHORITY_GENERATION_MIGRATION_FILE,
      MIXED_VERSION_GUARD_MIGRATION_FILE,
    ]
      .map((file) => readFileSync(file, 'utf8')).join('\n');
    await getTestDb().execute(sql.raw(migration));
    const readStates = () => withDbAccessContext(SYSTEM_CTX, () => db
      .select({ name: sensitiveDataPolicies.name, isActive: sensitiveDataPolicies.isActive })
      .from(sensitiveDataPolicies)
      .where(inArray(sensitiveDataPolicies.id, inserted.map((policy) => policy.id))));
    const expected = [
      { name: 'Current authorized interval', isActive: true },
      { name: 'Legacy active cron', isActive: false },
      { name: 'Legacy active interval', isActive: false },
      { name: 'Legacy active manual', isActive: true },
      { name: 'Legacy inactive interval', isActive: false },
    ];
    const once = (await readStates()).sort((a, b) => a.name.localeCompare(b.name));
    expect(once).toEqual(expected);

    await getTestDb().execute(sql.raw(migration));
    const twice = (await readStates()).sort((a, b) => a.name.localeCompare(b.name));
    expect(twice).toEqual(expected);
  });

  it('live resolver rejects inactive users, removed execute grants, and narrowed partner access', async () => {
    const inactive = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'execute' }],
    });
    const inactiveOwner = { orgId: inactive.organization.id, partnerId: null } as const;
    const inactiveAuthority = captureSensitiveDataAuthority({
      scope: 'organization', user: inactive.user, orgId: inactive.organization.id,
      partnerId: inactive.partner.id, partnerOrgAccess: null,
      accessibleOrgIds: [inactive.organization.id], orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === inactive.organization.id,
      canAccessSite: () => true,
    } as unknown as AuthContext, inactiveOwner)!;
    const inactiveRow = { ...inactiveOwner, ...inactiveAuthority };
    expect(await resolveSensitiveDataAuthority(inactiveRow)).not.toBeNull();
    await withDbAccessContext(SYSTEM_CTX, () => db
      .update(users).set({ status: 'disabled' }).where(eq(users.id, inactive.user.id)));
    expect(await resolveSensitiveDataAuthority(inactiveRow)).toBeNull();

    const noGrant = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'execute' }],
    });
    const noGrantOwner = { orgId: noGrant.organization.id, partnerId: null } as const;
    const noGrantAuthority = captureSensitiveDataAuthority({
      scope: 'organization', user: noGrant.user, orgId: noGrant.organization.id,
      partnerId: noGrant.partner.id, partnerOrgAccess: null,
      accessibleOrgIds: [noGrant.organization.id], orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === noGrant.organization.id,
      canAccessSite: () => true,
    } as unknown as AuthContext, noGrantOwner)!;
    const noGrantRow = { ...noGrantOwner, ...noGrantAuthority };
    expect(await resolveSensitiveDataAuthority(noGrantRow)).not.toBeNull();
    const [executePermission] = await withDbAccessContext(SYSTEM_CTX, () => db
      .select({ id: permissions.id })
      .from(permissions)
      .where(and(eq(permissions.resource, 'devices'), eq(permissions.action, 'execute')))
      .limit(1));
    await withDbAccessContext(SYSTEM_CTX, () => db.delete(rolePermissions).where(and(
      eq(rolePermissions.roleId, noGrant.role.id),
      eq(rolePermissions.permissionId, executePermission!.id),
    )));
    expect(await resolveSensitiveDataAuthority(noGrantRow)).toBeNull();

    const partner = await setupTestEnvironment({
      scope: 'partner',
      rolePermissions: [{ resource: 'devices', action: 'execute' }],
    });
    const partnerOwner = { orgId: null, partnerId: partner.partner.id } as const;
    const partnerAuthority = captureSensitiveDataAuthority({
      scope: 'partner', user: partner.user, orgId: null,
      partnerId: partner.partner.id, partnerOrgAccess: 'all',
      accessibleOrgIds: [partner.organization.id], orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === partner.organization.id,
      canAccessSite: () => true,
    } as unknown as AuthContext, partnerOwner)!;
    const partnerRow = { ...partnerOwner, ...partnerAuthority };
    expect(await resolveSensitiveDataAuthority(partnerRow)).not.toBeNull();
    await withDbAccessContext(SYSTEM_CTX, () => db.update(partnerUsers)
      .set({ orgAccess: 'selected', orgIds: [partner.organization.id] })
      .where(and(eq(partnerUsers.userId, partner.user.id), eq(partnerUsers.partnerId, partner.partner.id))));
    expect(await resolveSensitiveDataAuthority(partnerRow)).toBeNull();
    await withDbAccessContext(SYSTEM_CTX, () => db.update(partnerUsers)
      .set({ orgAccess: 'none', orgIds: null })
      .where(and(eq(partnerUsers.userId, partner.user.id), eq(partnerUsers.partnerId, partner.partner.id))));
    expect(await resolveSensitiveDataAuthority(partnerRow)).toBeNull();
  });
});
