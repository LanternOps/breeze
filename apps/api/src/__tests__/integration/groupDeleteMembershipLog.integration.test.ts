/**
 * Real-Postgres coverage for DELETE /groups/:id against the membership audit
 * log (#3313).
 *
 * THE DEFECT (reported from a live 0.104.0 deployment): deleting any device
 * group that had ever been evaluated returned 500. The route cleared
 * `device_group_memberships` and then deleted the group, but #3181 added
 * `group_membership_log`, which also references `device_groups.id`:
 *
 *   groupId: uuid('group_id').notNull().references(() => deviceGroups.id)
 *
 * with no `onDelete`, so the constraint defaults to NO ACTION. Materializing a
 * dynamic group's membership writes rows there, so from the first evaluation
 * onward the group is undeletable:
 *
 *   PostgresError: update or delete on table "device_groups" violates foreign
 *   key constraint "group_membership_log_group_id_device_groups_id_fk"
 *
 * Why a real database is required: `groups.test.ts` mocks the whole db layer
 * behind `delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) }))`, so
 * every delete resolves regardless of what Postgres would say about the
 * constraint. A mocked suite cannot distinguish "we cleaned the log" from "we
 * forgot to, and Postgres would have rejected it". Only a real FK can.
 *
 * Why nothing caught this: #3181 DID register `group_membership_log` in every
 * cascade contract the repo documents — `CORE_ORG_CASCADE_DELETE_ORDER`,
 * `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`
 * and `CORE_TENANT_EXPORT_POLICY` — and org-delete and device-delete are both
 * covered by contract tests. The group-delete route is not one of those lists
 * and had no test at all, which is the hole this file closes.
 *
 * Coverage:
 *   1. The regression — an evaluated dynamic group deletes cleanly and takes
 *      its log rows with it. FAILS with 500 before the fix.
 *   2. The trivial path — a static group with no log rows still deletes, so
 *      the new statement cannot have broken the case that already worked.
 *   3. Tenant isolation — deleting one org's group leaves another org's log
 *      rows untouched, i.e. the cleanup is scoped by group_id, not a blanket
 *      wipe.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, withSystemDbAccessContext } from '../../db';
import {
  deviceGroupMemberships,
  deviceGroups,
  devices,
  groupMembershipLog,
} from '../../db/schema';
import { groupRoutes } from '../../routes/groups';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import {
  createOrganization,
  createPartner,
  createSite,
  setupTestEnvironment,
  type TestEnvironment,
} from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const X64_FILTER = {
  operator: 'AND' as const,
  conditions: [{ field: 'architecture', operator: 'equals', value: 'x64' }],
};

function makeApp(): Hono {
  const app = new Hono();
  app.route('/groups', groupRoutes);
  return app;
}

/** The group routes are `requireMfa()`-gated; `setupTestEnvironment` mints
 *  `mfa: false`, so re-mint the same identity with `mfa: true`. */
async function mfaSatisfiedToken(env: TestEnvironment): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: env.organization.id,
    partnerId: env.partner.id,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

/** `amd64` is what the Go agent stores for an x64 box (#3166). */
async function seedDevice(orgId: string, siteId: string, architecture = 'amd64'): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `agent-${randomUUID()}`,
        hostname: `host-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '10',
        architecture,
        agentVersion: '1.0.0',
        status: 'online',
      })
      .returning({ id: devices.id });
    return row!.id;
  });
}

async function logRowCount(groupId: string): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({ id: groupMembershipLog.id })
      .from(groupMembershipLog)
      .where(eq(groupMembershipLog.groupId, groupId));
    return rows.length;
  });
}

async function groupExists(groupId: string): Promise<boolean> {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({ id: deviceGroups.id })
      .from(deviceGroups)
      .where(eq(deviceGroups.id, groupId));
    return rows.length > 0;
  });
}

async function membershipCount(groupId: string): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({ deviceId: deviceGroupMemberships.deviceId })
      .from(deviceGroupMemberships)
      .where(eq(deviceGroupMemberships.groupId, groupId));
    return rows.length;
  });
}

async function createGroup(
  app: Hono,
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request('/groups', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function deleteGroup(app: Hono, token: string, groupId: string): Promise<Response> {
  return app.request(`/groups/${groupId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('DELETE /groups/:id — group_membership_log cleanup (#3313)', () => {
  runDb('deletes an evaluated dynamic group and its membership log rows', async () => {
    const env = await setupTestEnvironment();
    const token = await mfaSatisfiedToken(env);
    const app = makeApp();

    await seedDevice(env.organization.id, env.site.id);
    await seedDevice(env.organization.id, env.site.id);

    const created = await createGroup(app, token, {
      name: `x64 boxes ${randomUUID().slice(0, 8)}`,
      type: 'dynamic',
      filterConditions: X64_FILTER,
    });
    expect(created.status).toBe(201);
    const groupId: string = (await created.json()).data.id;

    // Precondition: the group really did accumulate log rows. Without this the
    // delete below would pass vacuously — the FK only bites when rows exist,
    // so a green test proves nothing unless this count is non-zero.
    expect(await logRowCount(groupId)).toBeGreaterThan(0);
    expect(await membershipCount(groupId)).toBeGreaterThan(0);

    // This is the request that returned 500 in 0.104.0.
    const deleted = await deleteGroup(app, token, groupId);
    expect(deleted.status).toBe(200);

    expect(await groupExists(groupId)).toBe(false);
    expect(await membershipCount(groupId)).toBe(0);
    expect(await logRowCount(groupId)).toBe(0);
  });

  runDb('still deletes a static group that never accumulated log rows', async () => {
    const env = await setupTestEnvironment();
    const token = await mfaSatisfiedToken(env);
    const app = makeApp();

    const created = await createGroup(app, token, {
      name: `static ${randomUUID().slice(0, 8)}`,
      type: 'static',
    });
    expect(created.status).toBe(201);
    const groupId: string = (await created.json()).data.id;

    expect(await logRowCount(groupId)).toBe(0);

    const deleted = await deleteGroup(app, token, groupId);
    expect(deleted.status).toBe(200);
    expect(await groupExists(groupId)).toBe(false);
  });

  runDb("leaves another tenant's log rows untouched", async () => {
    const env = await setupTestEnvironment();
    const token = await mfaSatisfiedToken(env);
    const app = makeApp();

    await seedDevice(env.organization.id, env.site.id);
    const mine = await createGroup(app, token, {
      name: `mine ${randomUUID().slice(0, 8)}`,
      type: 'dynamic',
      filterConditions: X64_FILTER,
    });
    expect(mine.status).toBe(201);
    const myGroupId: string = (await mine.json()).data.id;

    // A genuinely different tenant with its own evaluated group.
    const foreignPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: foreignPartner.id });
    const foreignSite = await createSite({ orgId: foreignOrg.id });
    const foreignDeviceId = await seedDevice(foreignOrg.id, foreignSite.id);

    const foreignGroupId = await withSystemDbAccessContext(async () => {
      const [group] = await db
        .insert(deviceGroups)
        .values({
          orgId: foreignOrg.id,
          siteId: foreignSite.id,
          name: `foreign ${randomUUID().slice(0, 8)}`,
          type: 'static',
        })
        .returning({ id: deviceGroups.id });
      await db.insert(groupMembershipLog).values({
        groupId: group!.id,
        deviceId: foreignDeviceId,
        orgId: foreignOrg.id,
        action: 'added',
        reason: 'filter_match',
      });
      return group!.id;
    });

    expect(await logRowCount(foreignGroupId)).toBe(1);

    const deleted = await deleteGroup(app, token, myGroupId);
    expect(deleted.status).toBe(200);

    // Scoped by group_id, not a blanket wipe.
    expect(await logRowCount(foreignGroupId)).toBe(1);
  });
});
