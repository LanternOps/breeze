/**
 * Real-Postgres coverage for dynamic device-group membership materialization.
 *
 * THE DEFECT (observed live): creating a dynamic group with `Architecture
 * equals x64` previewed 3 matching devices, but
 * `SELECT count(*) FROM device_group_memberships WHERE group_id = <new group>`
 * stayed at 0 forever, with nothing in the API logs.
 *
 * MECHANISM: `routes/groups.ts` fired the evaluation without awaiting it
 * (`evaluateGroupMembership(id).catch(...)`). Only the evaluation's FIRST query
 * was dispatched while the request's `withDbAccessContext` transaction was
 * still open; the handler then returned, drizzle/postgres.js committed that
 * transaction and released its pooled connection, and the detached
 * continuation's next query was queued on a transaction handle that no longer
 * owned a connection. That query never executed, so the promise never settled,
 * so the route's `.catch()` never ran — zero rows, zero errors, zero logs.
 *
 * Why a real database is required: the mocked route suites resolve
 * `evaluateGroupMembership` from a `vi.fn()`, so a detached call looks
 * identical to an awaited one. Only a real pooled connection with a real
 * transaction lifecycle can reproduce the stall, and only real `breeze_app`
 * forced RLS can prove the tenant boundary on the write.
 *
 * Coverage:
 *   1. POST /groups (dynamic) — memberships are readable the instant the
 *      response lands, and the response's own deviceCount agrees. FAILS before
 *      the fix (0 rows, and the request itself leaks a never-settling promise).
 *   2. Cross-tenant — a matching device in ANOTHER partner's org is never
 *      absorbed, and every materialized row carries the group's own org_id.
 *   3. RLS backstop — an org-B-scoped context cannot forge a membership row
 *      into org A's group even when it names org A's ids (42501).
 *   4. PATCH /groups/:id — a filter change re-materializes before responding
 *      (that branch was fire-and-forget too).
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { deviceGroupMemberships, deviceGroups, devices } from '../../db/schema';
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

/**
 * The group routes are `requireMfa()`-gated and `setupTestEnvironment` mints
 * its token with `mfa: false`, so re-mint the same identity with `mfa: true`.
 */
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

/**
 * `amd64` is what the Go agent actually stores for an x64 box (#3166) — using
 * the raw GOARCH spelling keeps this test honest about the projection the
 * Architecture filter relies on.
 */
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

async function membershipRows(groupId: string): Promise<Array<{ deviceId: string; orgId: string }>> {
  return withSystemDbAccessContext(async () =>
    db
      .select({ deviceId: deviceGroupMemberships.deviceId, orgId: deviceGroupMemberships.orgId })
      .from(deviceGroupMemberships)
      .where(eq(deviceGroupMemberships.groupId, groupId)),
  );
}

/** An unrelated partner + org + site, i.e. a genuinely different tenant. */
async function seedForeignTenant(): Promise<{ orgId: string; siteId: string }> {
  const partner = await createPartner();
  const organization = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: organization.id });
  return { orgId: organization.id, siteId: site.id };
}

async function createDynamicGroup(
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

describe('dynamic device group membership materialization', () => {
  runDb('materializes membership before the create response returns', async () => {
    const env = await setupTestEnvironment();
    const token = await mfaSatisfiedToken(env);
    const app = makeApp();

    const deviceA = await seedDevice(env.organization.id, env.site.id);
    const deviceB = await seedDevice(env.organization.id, env.site.id);
    // arm64 box in the same org: proves the filter still discriminates.
    await seedDevice(env.organization.id, env.site.id, 'arm64');

    const res = await createDynamicGroup(app, token, {
      name: `x64 boxes ${randomUUID().slice(0, 8)}`,
      type: 'dynamic',
      filterConditions: X64_FILTER,
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    const groupId: string = body.data.id;

    // The membership rows exist the moment the caller can see the response —
    // no polling, no eventual consistency. This is the assertion that fails
    // (0 rows) against the fire-and-forget version.
    const rows = await membershipRows(groupId);
    expect(rows.map((r) => r.deviceId).sort()).toEqual([deviceA, deviceB].sort());
    expect(body.data.deviceCount).toBe(2);
  });

  runDb('never absorbs a matching device from another tenant', async () => {
    const env = await setupTestEnvironment();
    const token = await mfaSatisfiedToken(env);
    const app = makeApp();

    const ownDevice = await seedDevice(env.organization.id, env.site.id);
    const foreign = await seedForeignTenant();
    const foreignDevice = await seedDevice(foreign.orgId, foreign.siteId);

    const res = await createDynamicGroup(app, token, {
      name: `x64 boxes ${randomUUID().slice(0, 8)}`,
      type: 'dynamic',
      filterConditions: X64_FILTER,
    });
    expect(res.status).toBe(201);
    const groupId: string = (await res.json()).data.id;

    const rows = await membershipRows(groupId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deviceId).toBe(ownDevice);
    // Every materialized row is stamped with the GROUP's org, never a
    // device-derived or caller-derived one.
    expect(rows[0]!.orgId).toBe(env.organization.id);
    expect(rows.map((r) => r.deviceId)).not.toContain(foreignDevice);
  });

  runDb('RLS rejects a forged cross-tenant membership into the group', async () => {
    const env = await setupTestEnvironment();
    const token = await mfaSatisfiedToken(env);
    const app = makeApp();

    await seedDevice(env.organization.id, env.site.id);
    const foreign = await seedForeignTenant();
    const foreignDevice = await seedDevice(foreign.orgId, foreign.siteId);

    const res = await createDynamicGroup(app, token, {
      name: `x64 boxes ${randomUUID().slice(0, 8)}`,
      type: 'dynamic',
      filterConditions: X64_FILTER,
    });
    const groupId: string = (await res.json()).data.id;

    const foreignContext: DbAccessContext = {
      scope: 'organization',
      orgId: foreign.orgId,
      accessibleOrgIds: [foreign.orgId],
      accessiblePartnerIds: null,
      userId: null,
      currentPartnerId: null,
    };

    // The foreign tenant cannot even SEE the group…
    const visible = await withDbAccessContext(foreignContext, async () =>
      db.select({ id: deviceGroups.id }).from(deviceGroups).where(eq(deviceGroups.id, groupId)),
    );
    expect(visible).toHaveLength(0);

    // …and Postgres refuses a membership row stamped with org A's org_id.
    // The failed statement aborts the surrounding access-context transaction,
    // and postgres.js's `begin` rethrows even when the callback handled it, so
    // the catch has to live OUTSIDE withDbAccessContext.
    const forged = await withDbAccessContext(foreignContext, async () =>
      db.insert(deviceGroupMemberships).values({
        groupId,
        deviceId: foreignDevice,
        orgId: env.organization.id,
        addedBy: 'manual',
      }),
    ).then(() => null, (err: Error) => err);
    expect(forged).toBeInstanceOf(Error);
    // Drizzle wraps the driver error, so the policy violation is on `.cause`.
    expect(String((forged as { cause?: { message?: string } }).cause?.message))
      .toMatch(/row-level security/i);

    // GAP NOW CLOSED (#3182). This used to be asserted as a KNOWN GAP: the
    // `device_group_memberships` policies key on `org_id` ALONE
    // (`breeze_has_org_access(org_id)`), so a foreign tenant that somehow
    // learned the group's UUID could insert a row naming that group as long as
    // it stamped its OWN org_id — quarantined (org A could never read it), but
    // structurally legal, and a cross-org device move produced exactly that
    // shape through ordinary supported use. `device_group_memberships_group_org_fk`
    // ((group_id, org_id) -> device_groups(id, org_id)) now rejects it outright,
    // so the row never lands at all rather than landing unreadable.
    const foreignStamped = await withDbAccessContext(foreignContext, async () =>
      db.insert(deviceGroupMemberships).values({
        groupId,
        deviceId: foreignDevice,
        orgId: foreign.orgId,
        addedBy: 'manual',
      }),
    ).then(() => null, (err: Error) => err);
    expect(
      foreignStamped,
      'a membership naming another org\'s group must be rejected by the composite FK, not merely quarantined (#3182)',
    ).toBeInstanceOf(Error);
    expect(JSON.stringify(foreignStamped)).toContain('device_group_memberships_group_org_fk');

    const visibleToOwner = await withDbAccessContext(
      {
        scope: 'organization',
        orgId: env.organization.id,
        accessibleOrgIds: [env.organization.id],
        accessiblePartnerIds: null,
        userId: null,
        currentPartnerId: null,
      },
      async () =>
        db
          .select({ deviceId: deviceGroupMemberships.deviceId })
          .from(deviceGroupMemberships)
          .where(eq(deviceGroupMemberships.groupId, groupId)),
    );
    expect(
      visibleToOwner.map((r) => r.deviceId),
      'the owner org still never sees the foreign device — now because the row was refused, not merely hidden',
    ).not.toContain(foreignDevice);

    // And the group's own materialization never produced the foreign device.
    const rows = await membershipRows(groupId);
    expect(rows.filter((r) => r.orgId === env.organization.id).map((r) => r.deviceId))
      .not.toContain(foreignDevice);
  });

  runDb('re-materializes membership when the filter changes on update', async () => {
    const env = await setupTestEnvironment();
    const token = await mfaSatisfiedToken(env);
    const app = makeApp();

    const x64Device = await seedDevice(env.organization.id, env.site.id, 'amd64');
    const armDevice = await seedDevice(env.organization.id, env.site.id, 'arm64');

    const created = await createDynamicGroup(app, token, {
      name: `arch group ${randomUUID().slice(0, 8)}`,
      type: 'dynamic',
      filterConditions: X64_FILTER,
    });
    const groupId: string = (await created.json()).data.id;
    expect((await membershipRows(groupId)).map((r) => r.deviceId)).toEqual([x64Device]);

    const patched = await app.request(`/groups/${groupId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filterConditions: {
          operator: 'AND',
          conditions: [{ field: 'architecture', operator: 'equals', value: 'arm64' }],
        },
      }),
    });

    expect(patched.status).toBe(200);
    const rows = await membershipRows(groupId);
    expect(rows.map((r) => r.deviceId)).toEqual([armDevice]);
    // The response's deviceCount is read after the re-evaluation, so it is
    // already correct rather than one request behind.
    expect((await patched.json()).data.deviceCount).toBe(1);
  });

  runDb('logs loudly when the group is not visible to the caller context', async () => {
    const env = await setupTestEnvironment();
    await seedDevice(env.organization.id, env.site.id);

    const [group] = await withSystemDbAccessContext(async () =>
      db
        .insert(deviceGroups)
        .values({
          orgId: env.organization.id,
          name: `hidden ${randomUUID().slice(0, 8)}`,
          type: 'dynamic',
          filterConditions: X64_FILTER,
          filterFieldsUsed: ['architecture'],
        })
        .returning({ id: deviceGroups.id }),
    );

    const foreign = await seedForeignTenant();
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
    try {
      const { evaluateGroupMembership } = await import('../../services/groupMembership');
      const summary = await withDbAccessContext(
        {
          scope: 'organization',
          orgId: foreign.orgId,
          accessibleOrgIds: [foreign.orgId],
          accessiblePartnerIds: null,
          userId: null,
          currentPartnerId: null,
        },
        () => evaluateGroupMembership(group!.id),
      );
      expect(summary).toMatchObject({ evaluatedGroups: 0, added: 0, materialized: 0 });
    } finally {
      console.error = original;
    }

    expect(errors.some((line) => line.includes(group!.id) && line.includes('NOT materialized'))).toBe(true);

    // And nothing was written for the group by that call.
    const rows = await withSystemDbAccessContext(async () =>
      db
        .select({ deviceId: deviceGroupMemberships.deviceId })
        .from(deviceGroupMemberships)
        .where(and(eq(deviceGroupMemberships.groupId, group!.id))),
    );
    expect(rows).toHaveLength(0);
  });
});
