/**
 * IOC auto-quarantine stored authority, against real Postgres:
 *   - addFeatureLink/updateFeatureLink persist the envelope only with a
 *     captured authority and auto-quarantine on, and clear it otherwise;
 *   - the dispatch resolver admits only a live devices:execute approver, for a
 *     device inside the policy owner;
 *   - a grandfathered legacy link keeps quarantining while its policy creator
 *     holds devices:execute, and is revoked (one-way) when not;
 *   - the shape CHECK rejects a partial envelope; the migration is idempotent.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { configPolicyFeatureLinks, configurationPolicies, devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { addFeatureLink, updateFeatureLink } from '../../services/configurationPolicy';
import {
  captureSecurityQuarantineAuthority,
  resolveSecurityScanQuarantineAuthority,
} from '../../services/securityScanQuarantineAuthority';
import { setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-12-12-120100-security-quarantine-execution-authority.sql',
);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdPolicies: string[] = [];
const createdDevices: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdPolicies.length > 0) {
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.id, createdPolicies));
    }
    if (createdDevices.length > 0) {
      await db.delete(devices).where(inArray(devices.id, createdDevices));
    }
  });
  createdPolicies.length = 0;
  createdDevices.length = 0;
});

type Env = Awaited<ReturnType<typeof setupTestEnvironment>>;

function orgAuth(env: Env): AuthContext {
  return {
    scope: 'organization',
    user: env.user,
    orgId: env.organization.id,
    partnerId: env.partner.id,
    partnerOrgAccess: null,
    accessibleOrgIds: [env.organization.id],
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => id === env.organization.id,
  } as unknown as AuthContext;
}

async function createPolicy(env: Env) {
  const [policy] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(configurationPolicies).values({
    orgId: env.organization.id,
    name: `IOC policy ${crypto.randomUUID().slice(0, 8)}`,
  }).returning());
  createdPolicies.push(policy!.id);
  return policy!;
}

async function createDevice(env: Env) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [device] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(devices).values({
    orgId: env.organization.id, siteId: env.site.id, agentId: `ioc-${suffix}`,
    hostname: `ioc-${suffix}`, osType: 'windows', osVersion: '11',
    architecture: 'x64', agentVersion: '1.0.0', status: 'online',
  }).returning({ id: devices.id }));
  createdDevices.push(device!.id);
  return device!;
}

async function readStamp(linkId: string) {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () => db
    .select({
      generation: configPolicyFeatureLinks.executionAuthorityGeneration,
      userId: configPolicyFeatureLinks.executionAuthorityUserId,
    })
    .from(configPolicyFeatureLinks)
    .where(eq(configPolicyFeatureLinks.id, linkId)));
  return row!;
}

describe('security feature-link auto-quarantine authority', () => {
  it('persists, clears and resolves the stamp end to end', async () => {
    const executor = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [
        { resource: 'devices', action: 'write' },
        { resource: 'devices', action: 'execute' },
      ],
    });
    const policy = await createPolicy(executor);
    const device = await createDevice(executor);
    const authority = captureSecurityQuarantineAuthority(orgAuth(executor), {
      orgId: executor.organization.id, partnerId: null,
    })!;

    const link = await withDbAccessContext(SYSTEM_CTX, () => addFeatureLink(
      policy.id, 'security', null, { autoQuarantine: true }, undefined, db, { executionAuthority: authority },
    ));
    expect(await readStamp(link!.id)).toEqual({
      generation: authority.executionAuthorityGeneration,
      userId: executor.user.id,
    });
    expect(await withDbAccessContext(SYSTEM_CTX, () =>
      resolveSecurityScanQuarantineAuthority(link!.id, device.id))).toEqual({ allowed: true });

    // A settings write without a captured authority (AI tool / internal path)
    // clears the stamp: the next dispatch is detect-only.
    await withDbAccessContext(SYSTEM_CTX, () => updateFeatureLink(
      link!.id, { inlineSettings: { autoQuarantine: true, exclusions: ['C:\\Temp'] } }, policy.id,
    ));
    expect(await readStamp(link!.id)).toEqual({ generation: null, userId: null });
    expect(await withDbAccessContext(SYSTEM_CTX, () =>
      resolveSecurityScanQuarantineAuthority(link!.id, device.id)))
      .toEqual({ allowed: false, reason: 'reapproval_required' });
  });

  it('rejects an approver without devices:execute and a device outside the owner', async () => {
    const writer = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'write' }],
    });
    const other = await setupTestEnvironment({ scope: 'organization' });
    const policy = await createPolicy(writer);
    const device = await createDevice(writer);
    const foreignDevice = await createDevice(other);

    const link = await withDbAccessContext(SYSTEM_CTX, () => addFeatureLink(
      policy.id, 'security', null, { autoQuarantine: true }, undefined, db, {
        executionAuthority: captureSecurityQuarantineAuthority(orgAuth(writer), {
          orgId: writer.organization.id, partnerId: null,
        }),
      },
    ));

    expect(await withDbAccessContext(SYSTEM_CTX, () =>
      resolveSecurityScanQuarantineAuthority(link!.id, device.id)))
      .toEqual({ allowed: false, reason: 'authority_revoked' });

    // Grant execute to a different env's policy to reach the device check.
    const executor = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'execute' }],
    });
    const executorPolicy = await createPolicy(executor);
    const executorLink = await withDbAccessContext(SYSTEM_CTX, () => addFeatureLink(
      executorPolicy.id, 'security', null, {}, undefined, db, {
        executionAuthority: captureSecurityQuarantineAuthority(orgAuth(executor), {
          orgId: executor.organization.id, partnerId: null,
        }),
      },
    ));
    expect(await withDbAccessContext(SYSTEM_CTX, () =>
      resolveSecurityScanQuarantineAuthority(executorLink!.id, foreignDevice.id)))
      .toEqual({ allowed: false, reason: 'device_out_of_scope' });
  });

  it('grandfathers a legacy link on a policy creator with devices:execute and downgrades one without', async () => {
    const executor = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'execute' }],
    });
    const writer = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'write' }],
    });

    const legacyLink = async (env: Env) => {
      const [policy] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(configurationPolicies).values({
        orgId: env.organization.id,
        name: `Legacy IOC ${crypto.randomUUID().slice(0, 8)}`,
        createdBy: env.user.id,
      }).returning());
      createdPolicies.push(policy!.id);
      const [link] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy!.id,
        featureType: 'security',
        inlineSettings: { autoQuarantine: true },
        executionAuthorityLegacy: 'grandfathered',
      }).returning());
      return link!;
    };

    const keptLink = await legacyLink(executor);
    const keptDevice = await createDevice(executor);
    const downgradedLink = await legacyLink(writer);
    const downgradedDevice = await createDevice(writer);

    expect(await withDbAccessContext(SYSTEM_CTX, () =>
      resolveSecurityScanQuarantineAuthority(keptLink.id, keptDevice.id))).toEqual({ allowed: true });
    expect(await withDbAccessContext(SYSTEM_CTX, () =>
      resolveSecurityScanQuarantineAuthority(downgradedLink.id, downgradedDevice.id)))
      .toEqual({ allowed: false, reason: 'reapproval_required' });

    const legacyState = (id: string) => withDbAccessContext(SYSTEM_CTX, async () => (await db
      .select({ legacy: configPolicyFeatureLinks.executionAuthorityLegacy })
      .from(configPolicyFeatureLinks)
      .where(eq(configPolicyFeatureLinks.id, id)))[0]!.legacy);
    expect(await legacyState(keptLink.id)).toBe('grandfathered');
    // One-way: flagged for re-approval.
    expect(await legacyState(downgradedLink.id)).toBe('revoked');
    const [status] = await withDbAccessContext(SYSTEM_CTX, () => db
      .select({ status: configPolicyFeatureLinks.executionAuthorityStatus, at: configPolicyFeatureLinks.executionAuthorityStatusAt })
      .from(configPolicyFeatureLinks)
      .where(eq(configPolicyFeatureLinks.id, downgradedLink.id)));
    expect(status).toMatchObject({ status: 'approver_invalid', at: expect.any(Date) });

    // A save through the service leaves the legacy path for good.
    await withDbAccessContext(SYSTEM_CTX, () => updateFeatureLink(
      keptLink.id, { inlineSettings: { autoQuarantine: true } }, keptLink.configPolicyId,
    ));
    expect(await legacyState(keptLink.id)).toBeNull();
    expect(await withDbAccessContext(SYSTEM_CTX, () =>
      resolveSecurityScanQuarantineAuthority(keptLink.id, keptDevice.id)))
      .toEqual({ allowed: false, reason: 'reapproval_required' });
  });

  it('rejects a partial envelope (shape CHECK) and replays the migration idempotently', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const policy = await createPolicy(env);
    await expect(withDbAccessContext(SYSTEM_CTX, () => db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy.id,
      featureType: 'security',
      executionAuthorityVersion: 1,
      executionAuthorityGeneration: crypto.randomUUID(),
    }).returning())).rejects.toMatchObject({ cause: { code: '23514' } });

    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    await getTestDb().execute(sql.raw(migration));
    await getTestDb().execute(sql.raw(migration));
  });
});
