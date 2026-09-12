/**
 * Fail-closed revocation lease — live Postgres.
 *
 * The unit suite covers the decision matrix with a hand-built row. What it
 * CANNOT prove is the part this feature actually depends on: that a real
 * `organization_users` role change advances `users.permissions_epoch` through
 * the database trigger from 2026-08-06-b-live-authorization.sql, that the
 * recheck query reads that new value back through its joins, and that the
 * revocation writes the session row terminal. A mocked epoch would pass whether
 * or not the trigger exists.
 *
 * Run:
 *   pnpm test-stack up   # worktree root
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/remoteRevocationLease.integration.test.ts
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// The teardown side effect (viewer-token revoke + durable stop_desktop relay) is
// out of scope here and would drag the agent WS + BullMQ into the suite. Stub it
// and assert it was CALLED with the disconnected row — the wiring itself is
// covered by remoteSessionTeardown.test.ts.
const teardownDisconnectedSessions = vi.fn(async () => {});
vi.mock('../../services/remoteSessionTeardown', () => ({
  teardownDisconnectedSessions: (...args: unknown[]) =>
    teardownDisconnectedSessions(...(args as [])),
  terminateUserRemoteSessions: vi.fn(async () => 0),
  terminateDeviceRemoteSessions: vi.fn(async () => 0),
  TEARDOWN_FAILED: -1,
}));

import { devices, organizationUsers, remoteSessions, users } from '../../db/schema';
import {
  REVOCATION_LEASE_HARD_CAP_MS,
  REVOCATION_LEASE_TTL_MS,
  loadRevocationRecheckRow,
  prepareRevocationLeaseForStart,
  renewRevocationLease,
} from '../../services/remoteRevocationLease';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
} from './db-utils';
import { getTestDb } from './setup';

async function buildFixture(options: { leaseCapable?: boolean } = {}) {
  const db = getTestDb();
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const partner = await createPartner({ name: `Lease Partner ${unique}` });
  const org = await createOrganization({ partnerId: partner.id, name: `Lease Org ${unique}` });
  const site = await createSite({ orgId: org.id, name: `Lease Site ${unique}` });
  const role = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
  const otherRole = await createRole({
    scope: 'organization',
    orgId: org.id,
    partnerId: partner.id,
    name: `Other Role ${unique}`,
  });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `lease-${unique}@example.com`,
  });
  await assignUserToOrganization(user.id, org.id, role.id);

  const [device] = await db
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `lease-agent-${unique}`,
      hostname: `lease-host-${unique}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      revocationLeaseProtocolVersion: options.leaseCapable === false ? 0 : 1,
    })
    .returning();

  // The epoch as it stands AFTER the membership was created (assigning a
  // membership itself bumps it via trigger), which is exactly what session
  // creation would capture.
  const [live] = await db
    .select({ permissionsEpoch: users.permissionsEpoch })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  const [session] = await db
    .insert(remoteSessions)
    .values({
      deviceId: device!.id,
      orgId: org.id,
      userId: user.id,
      type: 'desktop',
      status: 'active',
      startedAt: new Date(),
      permissionsEpochSnapshot: Number(live!.permissionsEpoch),
    })
    .returning();

  return { partner, org, site, role, otherRole, user, device: device!, session: session! };
}

describe('revocation lease against live Postgres', () => {
  beforeEach(() => {
    teardownDisconnectedSessions.mockClear();
  });

  it('reads the whole recheck row back through its joins in one query', async () => {
    const f = await buildFixture();

    const row = await loadRevocationRecheckRow(f.session.id);

    expect(row).not.toBeNull();
    expect(row!.session.orgId).toBe(f.org.id);
    expect(row!.session.permissionsEpochSnapshot).toBeTypeOf('number');
    expect(row!.device.siteId).toBe(f.site.id);
    expect(row!.device.revocationLeaseProtocolVersion).toBe(1);
    expect(row!.user.status).toBe('active');
    expect(row!.orgMembership?.roleId).toBe(f.role.id);
    // An org-scoped user has no partner membership on this axis.
    expect(row!.user.orgId).toBe(f.org.id);
  });

  it('renews a healthy session and leaves the row untouched', async () => {
    const db = getTestDb();
    const f = await buildFixture();

    const result = await renewRevocationLease(f.session.id);

    expect(result.status).toBe('renewed');
    if (result.status !== 'renewed') return;
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.hardDeadline).toBeLessThanOrEqual(Date.now() + REVOCATION_LEASE_HARD_CAP_MS + 1000);
    expect(result.renewEverySec).toBe(25);
    expect(result.graceSec).toBe(90);
    expect(result.expiresAt - Date.now()).toBeLessThanOrEqual(REVOCATION_LEASE_TTL_MS);

    const [after] = await db
      .select({ status: remoteSessions.status, errorMessage: remoteSessions.errorMessage })
      .from(remoteSessions)
      .where(eq(remoteSessions.id, f.session.id))
      .limit(1);
    expect(after!.status).toBe('active');
    expect(after!.errorMessage).toBeNull();
    expect(teardownDisconnectedSessions).not.toHaveBeenCalled();
  });

  it('revokes the session when a REAL role change bumps permissions_epoch', async () => {
    const db = getTestDb();
    const f = await buildFixture();

    const [before] = await db
      .select({ permissionsEpoch: users.permissionsEpoch })
      .from(users)
      .where(eq(users.id, f.user.id))
      .limit(1);

    // The actual mutation an admin performs: POST /users/:id/role updates the
    // membership's role_id, and the trigger advances the epoch in the same
    // transaction. Nothing here touches users.permissions_epoch directly.
    await db
      .update(organizationUsers)
      .set({ roleId: f.otherRole.id })
      .where(eq(organizationUsers.userId, f.user.id));

    const [after] = await db
      .select({ permissionsEpoch: users.permissionsEpoch })
      .from(users)
      .where(eq(users.id, f.user.id))
      .limit(1);
    // Positive control: if the trigger did not fire, the assertion below would
    // pass for the wrong reason (nothing to detect).
    expect(Number(after!.permissionsEpoch)).toBeGreaterThan(Number(before!.permissionsEpoch));

    const result = await renewRevocationLease(f.session.id);

    expect(result).toEqual({ status: 'revoked', reason: 'permissions_changed' });

    const [row] = await db
      .select({
        status: remoteSessions.status,
        errorMessage: remoteSessions.errorMessage,
        endedAt: remoteSessions.endedAt,
      })
      .from(remoteSessions)
      .where(eq(remoteSessions.id, f.session.id))
      .limit(1);
    expect(row!.status).toBe('disconnected');
    expect(row!.errorMessage).toBe('revoked:permissions_changed');
    expect(row!.endedAt).not.toBeNull();

    expect(teardownDisconnectedSessions).toHaveBeenCalledWith([
      { id: f.session.id, type: 'desktop', deviceId: f.device.id },
    ]);
  });

  it('revokes when the membership is removed outright', async () => {
    const db = getTestDb();
    const f = await buildFixture();

    await db.delete(organizationUsers).where(eq(organizationUsers.userId, f.user.id));

    // The membership delete ALSO bumps the epoch, so `permissions_changed` is
    // reported first — either way the session is definitively revoked and the
    // row is terminal. What matters is that it does not survive.
    const result = await renewRevocationLease(f.session.id);
    expect(result.status).toBe('revoked');

    const [row] = await db
      .select({ status: remoteSessions.status, errorMessage: remoteSessions.errorMessage })
      .from(remoteSessions)
      .where(eq(remoteSessions.id, f.session.id))
      .limit(1);
    expect(row!.status).toBe('disconnected');
    expect(row!.errorMessage).toMatch(/^revoked:/);
  });

  it('revokes when the device leaves the caller site ceiling', async () => {
    const db = getTestDb();
    const f = await buildFixture();

    // Narrow the membership to a DIFFERENT site. Note this also bumps the epoch
    // (site_ids is one of the trigger's watched columns), so re-snapshot the
    // baseline first to isolate the site check itself.
    const otherSite = await createSite({ orgId: f.org.id, name: 'Other Site' });
    await db
      .update(organizationUsers)
      .set({ siteIds: [otherSite.id] })
      .where(eq(organizationUsers.userId, f.user.id));
    const [live] = await db
      .select({ permissionsEpoch: users.permissionsEpoch })
      .from(users)
      .where(eq(users.id, f.user.id))
      .limit(1);
    await db
      .update(remoteSessions)
      .set({ permissionsEpochSnapshot: Number(live!.permissionsEpoch) })
      .where(eq(remoteSessions.id, f.session.id));

    const result = await renewRevocationLease(f.session.id);

    expect(result).toEqual({ status: 'revoked', reason: 'site_scope_lost' });
  });

  it('revokes an inactive user', async () => {
    const db = getTestDb();
    const f = await buildFixture();

    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.user.id));

    expect(await renewRevocationLease(f.session.id)).toEqual({
      status: 'revoked',
      reason: 'user_inactive',
    });
  });

  it('refuses a caller who does not own the session, without touching the row', async () => {
    const db = getTestDb();
    const f = await buildFixture();

    const result = await renewRevocationLease(f.session.id, { expectUserId: f.device.id });

    expect(result).toEqual({ status: 'forbidden' });
    const [row] = await db
      .select({ status: remoteSessions.status })
      .from(remoteSessions)
      .where(eq(remoteSessions.id, f.session.id))
      .limit(1);
    expect(row!.status).toBe('active');
  });

  it('refuses to mint a lease for an agent that has not declared the capability', async () => {
    const f = await buildFixture({ leaseCapable: false });

    await expect(prepareRevocationLeaseForStart(f.session.id)).resolves.toEqual({
      ok: false,
      reason: 'agent_upgrade_required',
    });
  });

  it('mints a lease capped at 12 hours for a capable agent', async () => {
    const f = await buildFixture();

    const result = await prepareRevocationLeaseForStart(f.session.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lease.renewEverySec).toBe(25);
    expect(result.lease.graceSec).toBe(90);
    expect(result.lease.hardDeadline).toBeLessThanOrEqual(
      Date.now() + REVOCATION_LEASE_HARD_CAP_MS + 1000,
    );
  });

  it('refuses to mint a lease for a session with no durable epoch baseline', async () => {
    const db = getTestDb();
    const f = await buildFixture();
    await db
      .update(remoteSessions)
      .set({ permissionsEpochSnapshot: null })
      .where(eq(remoteSessions.id, f.session.id));

    await expect(prepareRevocationLeaseForStart(f.session.id)).resolves.toEqual({
      ok: false,
      reason: 'session_unavailable',
    });
  });

  it('revokes a session whose epoch baseline was never captured', async () => {
    const db = getTestDb();
    const f = await buildFixture();
    await db
      .update(remoteSessions)
      .set({ permissionsEpochSnapshot: null })
      .where(eq(remoteSessions.id, f.session.id));

    expect(await renewRevocationLease(f.session.id)).toEqual({
      status: 'revoked',
      reason: 'epoch_baseline_missing',
    });
  });
});
