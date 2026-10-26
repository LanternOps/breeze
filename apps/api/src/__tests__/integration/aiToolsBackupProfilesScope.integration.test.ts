/**
 * Integration test — W03 (#6757) backup profile, backup SLA and cloud-to-cloud
 * write tools honour the org axis, the partner-wide gate and the site-ceiling
 * gate, against real Postgres as the unprivileged `breeze_app` role.
 *
 * Tools: manage_backup_profiles, configure_backup_sla, trigger_c2c_sync,
 * restore_c2c_items.
 *
 *  - manage_backup_profiles: a partner-wide create needs full partner access
 *    (`partnerOrgAccess: 'all'`); an org-scoped caller cannot update or delete
 *    a partner-wide profile (org_id NULL, partner_id set); a profile of
 *    another org is "not found"; `update` returns the `previous` values.
 *  - configure_backup_sla: a site-restricted caller is refused
 *    (`canMutateOrgWideGovernance`); a cross-org update is "not found".
 *  - trigger_c2c_sync / restore_c2c_items: a config / item of another org is
 *    "not found". W03-D11: items in org A with a `targetConnectionId` of org B
 *    (caller reaches both) are refused and no restore job row is inserted.
 *
 * Only the BullMQ C2C enqueue is stubbed; every refusal under test happens
 * before it.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

const { enqueueC2cSyncMock, enqueueC2cRestoreMock } = vi.hoisted(() => ({
  enqueueC2cSyncMock: vi.fn(async (..._args: unknown[]) => undefined),
  enqueueC2cRestoreMock: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock('../../jobs/c2cEnqueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../jobs/c2cEnqueue')>();
  return { ...actual, enqueueC2cSync: enqueueC2cSyncMock, enqueueC2cRestore: enqueueC2cRestoreMock };
});

import { withDbAccessContext, type DbAccessContext } from '../../db';
import {
  backupProfiles,
  backupSlaConfigs,
  c2cBackupConfigs,
  c2cBackupItems,
  c2cBackupJobs,
  c2cConnections,
} from '../../db/schema';
import { registerSLABackupTools } from '../../services/aiToolsSLABackup';
import { registerC2CTools } from '../../services/aiToolsC2C';
import { registerPolicyPrereqTools } from '../../services/aiToolsPolicyPrereqs';
import { clearPermissionCache } from '../../services/permissions';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function registry(): Map<string, AiTool> {
  const reg = new Map<string, AiTool>();
  registerPolicyPrereqTools(reg);
  registerSLABackupTools(reg);
  registerC2CTools(reg);
  return reg;
}

type Who = 'orgA' | 'orgASiteRestricted' | 'orgB' | 'partnerAll' | 'partnerSelected';

interface Fixture {
  partnerId: string;
  orgA: string;
  orgB: string;
  orgUserId: string;
  partnerUserId: string;
  auth: Record<Who, AuthContext>;
}

const PERMS = [
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'write' },
  { resource: 'devices', action: 'execute' },
  { resource: 'backup', action: 'read' },
  { resource: 'backup', action: 'write' },
];

function orgAuth(userId: string, partnerId: string, orgId: string, allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: (col: PgColumn) => eq(col, orgId),
    canAccessOrg: (id: string) => id === orgId,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) =>
      !allowedSiteIds ? true : !!s && allowedSiteIds.includes(s),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'backup-profiles-scope' },
  } as unknown as AuthContext;
}

function partnerAuth(
  userId: string,
  partnerId: string,
  orgIds: string[],
  partnerOrgAccess: 'all' | 'selected',
): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId,
    orgId: null,
    scope: 'partner',
    partnerOrgAccess,
    accessibleOrgIds: orgIds,
    orgCondition: (col: PgColumn) => inArray(col, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id),
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'backup-profiles-scope' },
  } as unknown as AuthContext;
}

async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id, name: 'Profiles scope A' });

  const orgUser = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `bp-org-${randomUUID()}@example.com` });
  const orgRole = await createRole({ scope: 'organization', orgId: orgA.id });
  await grantRolePermissions(orgRole.id, PERMS);
  await assignUserToOrganization(orgUser.id, orgA.id, orgRole.id);

  const partnerUser = await createUser({ partnerId: partner.id, email: `bp-partner-${randomUUID()}@example.com` });
  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(partnerRole.id, PERMS);
  await assignUserToPartner(partnerUser.id, partner.id, partnerRole.id, 'all');

  const orgIds = [orgA.id, orgB.id];
  return {
    partnerId: partner.id,
    orgA: orgA.id,
    orgB: orgB.id,
    orgUserId: orgUser.id,
    partnerUserId: partnerUser.id,
    auth: {
      orgA: orgAuth(orgUser.id, partner.id, orgA.id),
      orgASiteRestricted: orgAuth(orgUser.id, partner.id, orgA.id, [siteA.id]),
      orgB: orgAuth(orgUser.id, partner.id, orgB.id),
      partnerAll: partnerAuth(partnerUser.id, partner.id, orgIds, 'all'),
      partnerSelected: partnerAuth(partnerUser.id, partner.id, orgIds, 'selected'),
    },
  };
}

function ctxFor(f: Fixture, who: Who): DbAccessContext {
  if (who === 'partnerAll' || who === 'partnerSelected') {
    return {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [f.orgA, f.orgB],
      accessiblePartnerIds: [f.partnerId],
      userId: f.partnerUserId,
      currentPartnerId: f.partnerId,
    };
  }
  const orgId = who === 'orgB' ? f.orgB : f.orgA;
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: f.orgUserId,
    currentPartnerId: f.partnerId,
  };
}

async function run(f: Fixture, who: Who, tool: string, input: Record<string, unknown>) {
  const handler = registry().get(tool)!.handler;
  const raw = await withDbAccessContext(ctxFor(f, who), () => handler(input, f.auth[who]));
  return JSON.parse(raw) as Record<string, any>;
}

const SELECTIONS = { file: { enabled: true, paths: ['/data'] } };

async function seedProfile(opts: { orgId: string | null; partnerId: string | null; name?: string }) {
  const [row] = await getTestDb().insert(backupProfiles).values({
    orgId: opts.orgId,
    partnerId: opts.partnerId,
    name: opts.name ?? `profile-${randomUUID().slice(0, 8)}`,
    description: 'original description',
    selections: SELECTIONS,
    isActive: true,
  }).returning();
  return row!;
}

async function loadProfile(id: string) {
  const [row] = await getTestDb().select().from(backupProfiles).where(eq(backupProfiles.id, id));
  return row;
}

describe('manage_backup_profiles — partner-wide gate, org axis and the `previous` block', () => {
  let f: Fixture;
  beforeEach(async () => {
    await clearPermissionCache();
    f = await seedFixture();
  });

  runDb('a partner-wide create without full partner access is refused and writes no row', async () => {
    const denied = await run(f, 'partnerSelected', 'manage_backup_profiles', {
      action: 'create', name: 'all orgs', ownerScope: 'partner', selections: SELECTIONS,
    });
    expect(denied).toEqual({ error: 'Partner-wide backup profiles require full partner org access' });
    expect(await getTestDb().select({ id: backupProfiles.id }).from(backupProfiles)).toHaveLength(0);

    // an org-scoped caller has no partner-wide breadth at all
    const orgDenied = await run(f, 'orgA', 'manage_backup_profiles', {
      action: 'create', name: 'all orgs', ownerScope: 'partner', selections: SELECTIONS,
    });
    expect(orgDenied.error).toBe('Partner-wide backup profiles require full partner org access');
    expect(await getTestDb().select({ id: backupProfiles.id }).from(backupProfiles)).toHaveLength(0);
  });

  runDb('a partner-wide create with full partner access succeeds as org_id NULL / partner_id set', async () => {
    const ok = await run(f, 'partnerAll', 'manage_backup_profiles', {
      action: 'create', name: 'all orgs', ownerScope: 'partner', selections: SELECTIONS,
    });
    expect(ok.error).toBeUndefined();
    expect(ok.success).toBe(true);
    const stored = await loadProfile(ok.profileId);
    expect(stored?.orgId).toBeNull();
    expect(stored?.partnerId).toBe(f.partnerId);
  });

  runDb('an org-scoped caller cannot update or delete a partner-wide profile', async () => {
    const wide = await seedProfile({ orgId: null, partnerId: f.partnerId, name: 'partner-wide' });

    const update = await run(f, 'orgA', 'manage_backup_profiles', { action: 'update', profileId: wide.id, name: 'hijacked', isActive: false });
    expect(update.success).toBeUndefined();
    expect(update.error).toBe('Backup profile not found or access denied');

    const del = await run(f, 'orgA', 'manage_backup_profiles', { action: 'delete', profileId: wide.id });
    expect(del.success).toBeUndefined();
    expect(del.error).toBe('Backup profile not found or access denied');

    const stored = await loadProfile(wide.id);
    expect(stored?.name).toBe('partner-wide');
    expect(stored?.isActive).toBe(true);
  });

  runDb('a partner caller without full access sees the partner-wide profile but cannot update or delete it; full access can', async () => {
    const wide = await seedProfile({ orgId: null, partnerId: f.partnerId, name: 'partner-wide' });

    const update = await run(f, 'partnerSelected', 'manage_backup_profiles', { action: 'update', profileId: wide.id, name: 'hijacked' });
    expect(update).toEqual({ error: 'Modifying a partner-wide backup profile requires full partner org access' });
    const del = await run(f, 'partnerSelected', 'manage_backup_profiles', { action: 'delete', profileId: wide.id });
    expect(del).toEqual({ error: 'Deleting a partner-wide backup profile requires full partner org access' });
    expect((await loadProfile(wide.id))?.name).toBe('partner-wide');

    const ok = await run(f, 'partnerAll', 'manage_backup_profiles', { action: 'update', profileId: wide.id, name: 'renamed by admin' });
    expect(ok.error).toBeUndefined();
    expect((await loadProfile(wide.id))?.name).toBe('renamed by admin');
    const gone = await run(f, 'partnerAll', 'manage_backup_profiles', { action: 'delete', profileId: wide.id });
    expect(gone.success).toBe(true);
    expect(await loadProfile(wide.id)).toBeUndefined();
  });

  runDb('a profile of another org is not found for get, update and delete and stays untouched', async () => {
    const theirs = await seedProfile({ orgId: f.orgB, partnerId: null, name: 'org-b profile' });
    const NOT_FOUND = { error: 'Backup profile not found or access denied' };

    expect(await run(f, 'orgA', 'manage_backup_profiles', { action: 'get', profileId: theirs.id })).toEqual(NOT_FOUND);
    expect(await run(f, 'orgA', 'manage_backup_profiles', { action: 'update', profileId: theirs.id, name: 'x' })).toEqual(NOT_FOUND);
    expect(await run(f, 'orgA', 'manage_backup_profiles', { action: 'delete', profileId: theirs.id })).toEqual(NOT_FOUND);
    expect((await loadProfile(theirs.id))?.name).toBe('org-b profile');

    // the caller's own org still works (non-vacuous), as does a multi-org partner
    const own = await seedProfile({ orgId: f.orgA, partnerId: null, name: 'org-a profile' });
    expect((await run(f, 'orgA', 'manage_backup_profiles', { action: 'get', profileId: own.id })).profile?.name).toBe('org-a profile');
    expect((await run(f, 'partnerAll', 'manage_backup_profiles', { action: 'get', profileId: theirs.id })).profile?.name).toBe('org-b profile');
  });

  runDb('update returns a `previous` block with the replaced name, description, selections and isActive', async () => {
    const own = await seedProfile({ orgId: f.orgA, partnerId: null, name: 'before' });
    const newSelections = { file: { enabled: true, paths: ['/other'] } };

    const result = await run(f, 'orgA', 'manage_backup_profiles', {
      action: 'update', profileId: own.id, name: 'after', description: 'new description', selections: newSelections, isActive: false,
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.previous).toEqual({
      name: 'before',
      description: 'original description',
      selections: SELECTIONS,
      isActive: true,
    });
    expect(result.profile.name).toBe('after');
    expect(result.profile.isActive).toBe(false);
    expect((await loadProfile(own.id))?.name).toBe('after');
  });

  runDb('a site-restricted caller cannot create, update or delete (org-wide governance), but can still read', async () => {
    const own = await seedProfile({ orgId: f.orgA, partnerId: null, name: 'org-a profile' });
    const DENIED = 'Site-restricted users cannot modify organization-wide settings. Ask an unrestricted administrator.';

    expect((await run(f, 'orgASiteRestricted', 'manage_backup_profiles', { action: 'create', name: 'n', selections: SELECTIONS })).error).toBe(DENIED);
    expect((await run(f, 'orgASiteRestricted', 'manage_backup_profiles', { action: 'update', profileId: own.id, name: 'n' })).error).toBe(DENIED);
    expect((await run(f, 'orgASiteRestricted', 'manage_backup_profiles', { action: 'delete', profileId: own.id })).error).toBe(DENIED);
    expect((await loadProfile(own.id))?.name).toBe('org-a profile');

    expect((await run(f, 'orgASiteRestricted', 'manage_backup_profiles', { action: 'get', profileId: own.id })).profile?.name).toBe('org-a profile');
  });
});

describe('configure_backup_sla — site ceiling and org axis', () => {
  let f: Fixture;
  beforeEach(async () => {
    await clearPermissionCache();
    f = await seedFixture();
  });

  const DENIED = 'Site-restricted users cannot modify organization-wide settings. Ask an unrestricted administrator.';

  async function seedSla(orgId: string, name = 'sla') {
    const [row] = await getTestDb().insert(backupSlaConfigs).values({
      orgId, name, rpoTargetMinutes: 60, rtoTargetMinutes: 120,
    }).returning({ id: backupSlaConfigs.id });
    return row!.id;
  }

  async function loadSla(id: string) {
    const [row] = await getTestDb().select().from(backupSlaConfigs).where(eq(backupSlaConfigs.id, id));
    return row;
  }

  runDb('a site-restricted caller is refused on create and update and nothing is written', async () => {
    const slaId = await seedSla(f.orgA);

    const create = await run(f, 'orgASiteRestricted', 'configure_backup_sla', {
      action: 'create', name: 'new', rpoTargetMinutes: 30, rtoTargetMinutes: 60,
    });
    expect(create).toEqual({ error: DENIED });
    expect(await getTestDb().select({ id: backupSlaConfigs.id }).from(backupSlaConfigs)).toHaveLength(1);

    const update = await run(f, 'orgASiteRestricted', 'configure_backup_sla', { action: 'update', configId: slaId, rpoTargetMinutes: 5 });
    expect(update).toEqual({ error: DENIED });
    expect((await loadSla(slaId))?.rpoTargetMinutes).toBe(60);
  });

  runDb('an unrestricted caller creates and updates in its own org', async () => {
    const created = await run(f, 'orgA', 'configure_backup_sla', {
      action: 'create', name: 'new', rpoTargetMinutes: 30, rtoTargetMinutes: 60,
    });
    expect(created.error).toBeUndefined();
    expect(created.success).toBe(true);
    expect(created.config.orgId).toBe(f.orgA);

    const updated = await run(f, 'orgA', 'configure_backup_sla', { action: 'update', configId: created.config.id, rpoTargetMinutes: 15 });
    expect(updated.error).toBeUndefined();
    expect((await loadSla(created.config.id))?.rpoTargetMinutes).toBe(15);
  });

  runDb('a cross-org update is not found and changes nothing', async () => {
    const theirs = await seedSla(f.orgB, 'org-b sla');
    const result = await run(f, 'orgA', 'configure_backup_sla', { action: 'update', configId: theirs, rpoTargetMinutes: 1, name: 'hijacked' });
    expect(result).toEqual({ error: 'SLA config not found or access denied' });
    const stored = await loadSla(theirs);
    expect(stored?.rpoTargetMinutes).toBe(60);
    expect(stored?.name).toBe('org-b sla');
  });
});

describe('C2C write tools — org axis and W03-D11', () => {
  let f: Fixture;
  beforeEach(async () => {
    await clearPermissionCache();
    enqueueC2cSyncMock.mockClear();
    enqueueC2cRestoreMock.mockClear();
    f = await seedFixture();
  });

  async function seedC2c(orgId: string) {
    const testDb = getTestDb();
    const [connection] = await testDb.insert(c2cConnections).values({
      orgId, provider: 'microsoft_365', displayName: `conn-${randomUUID().slice(0, 6)}`,
    }).returning({ id: c2cConnections.id });
    const [config] = await testDb.insert(c2cBackupConfigs).values({
      orgId, connectionId: connection!.id, name: `cfg-${randomUUID().slice(0, 6)}`, backupScope: 'mailbox',
    }).returning({ id: c2cBackupConfigs.id });
    const [item] = await testDb.insert(c2cBackupItems).values({
      orgId, configId: config!.id, itemType: 'email', externalId: `ext-${randomUUID()}`,
    }).returning({ id: c2cBackupItems.id });
    return { connectionId: connection!.id, configId: config!.id, itemId: item!.id };
  }

  async function jobsFor(configId: string) {
    return getTestDb().select().from(c2cBackupJobs).where(eq(c2cBackupJobs.configId, configId));
  }

  describe('trigger_c2c_sync', () => {
    runDb('a config of another org is not found and creates no job; the own org and a multi-org caller succeed', async () => {
      const a = await seedC2c(f.orgA);
      const b = await seedC2c(f.orgB);
      const NOT_FOUND = { error: 'Config not found or access denied' };

      expect(await run(f, 'orgB', 'trigger_c2c_sync', { configId: a.configId })).toEqual(NOT_FOUND);
      expect(await run(f, 'orgA', 'trigger_c2c_sync', { configId: b.configId })).toEqual(NOT_FOUND);
      expect(await jobsFor(a.configId)).toHaveLength(0);
      expect(await jobsFor(b.configId)).toHaveLength(0);
      expect(enqueueC2cSyncMock).not.toHaveBeenCalled();

      const own = await run(f, 'orgA', 'trigger_c2c_sync', { configId: a.configId });
      expect(own.error).toBeUndefined();
      expect(own.success).toBe(true);
      expect(await jobsFor(a.configId)).toHaveLength(1);

      const wide = await run(f, 'partnerSelected', 'trigger_c2c_sync', { configId: b.configId });
      expect(wide.error).toBeUndefined();
      expect(wide.success).toBe(true);
      expect(enqueueC2cSyncMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('restore_c2c_items', () => {
    runDb('an item of another org is not found and creates no restore job', async () => {
      const a = await seedC2c(f.orgA);

      expect(await run(f, 'orgB', 'restore_c2c_items', { itemIds: [a.itemId] })).toEqual({ error: 'No matching items found' });
      expect(await jobsFor(a.configId)).toHaveLength(0);
      expect(enqueueC2cRestoreMock).not.toHaveBeenCalled();

      const own = await run(f, 'orgA', 'restore_c2c_items', { itemIds: [a.itemId], targetConnectionId: a.connectionId });
      expect(own.error).toBeUndefined();
      expect(own.success).toBe(true);
      expect(await jobsFor(a.configId)).toHaveLength(1);
    });

    runDb('W03-D11: items in org A with a target connection of org B are refused for a caller that reaches both, and no job row is inserted', async () => {
      const a = await seedC2c(f.orgA);
      const b = await seedC2c(f.orgB);

      const result = await run(f, 'partnerSelected', 'restore_c2c_items', { itemIds: [a.itemId], targetConnectionId: b.connectionId });
      expect(result).toEqual({ error: 'Target connection not found or access denied' });
      expect(await jobsFor(a.configId)).toHaveLength(0);
      expect(await getTestDb().select({ id: c2cBackupJobs.id }).from(c2cBackupJobs)).toHaveLength(0);
      expect(enqueueC2cRestoreMock).not.toHaveBeenCalled();

      // the same caller restoring org A items to an org A connection succeeds
      const ok = await run(f, 'partnerSelected', 'restore_c2c_items', { itemIds: [a.itemId], targetConnectionId: a.connectionId });
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);
      expect(await jobsFor(a.configId)).toHaveLength(1);
    });
  });
});
