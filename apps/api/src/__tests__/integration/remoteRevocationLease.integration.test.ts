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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import {
  devices,
  organizations,
  partners,
  organizationUsers,
  remoteSessions,
  roles,
  userPasskeys,
  users,
} from '../../db/schema';
import {
  REVOCATION_LEASE_HARD_CAP_MS,
  REVOCATION_LEASE_TTL_MS,
  loadRevocationRecheckRow,
  isDesktopStartCapable,
  prepareRevocationLeaseForStart,
  renewRevocationLease,
} from '../../services/remoteRevocationLease';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
} from './db-utils';
import { getTestDb } from './setup';

async function buildFixture(options: { leaseCapable?: boolean; fenceCapable?: boolean } = {}) {
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
      desktopFenceProtocolVersion: options.fenceCapable === false ? 0 : 1,
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
    expect(row!.device.desktopFenceProtocolVersion).toBe(1);
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

    // The revocation goes through the terminal-intent contract (SEC-038 W03):
    // the row handed to the teardown names the terminal generation the stop
    // must carry, and the phase is 'pending' until the agent acknowledges it.
    expect(teardownDisconnectedSessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: f.session.id,
        type: 'desktop',
        deviceId: f.device.id,
        status: 'disconnected',
        terminalGeneration: 1n,
        terminationPhase: 'pending',
      }),
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

  // #6107 — the lease must reach the same MFA verdict login does.
  describe('MFA through the effective policy (#6107)', () => {
    const savedKillSwitch = process.env.MFA_FORCE_FOR_PARTNER_ADMIN;
    afterEach(() => {
      if (savedKillSwitch === undefined) delete process.env.MFA_FORCE_FOR_PARTNER_ADMIN;
      else process.env.MFA_FORCE_FOR_PARTNER_ADMIN = savedKillSwitch;
    });

    // Policy edits (force_mfa flips) bump permissions_epoch by trigger. These
    // cases are about the MFA branch, so re-capture the baseline afterwards —
    // otherwise every one of them would revoke as `permissions_changed`.
    async function resnapshot(f: Awaited<ReturnType<typeof buildFixture>>) {
      const db = getTestDb();
      const [live] = await db
        .select({ permissionsEpoch: users.permissionsEpoch })
        .from(users)
        .where(eq(users.id, f.user.id))
        .limit(1);
      await db
        .update(remoteSessions)
        .set({ permissionsEpochSnapshot: Number(live!.permissionsEpoch) })
        .where(eq(remoteSessions.id, f.session.id));
    }

    async function requireMfaForOrg(orgId: string) {
      await getTestDb()
        .update(organizations)
        .set({ settings: { security: { requireMfa: true } } })
        .where(eq(organizations.id, orgId));
    }

    async function addPasskey(userId: string, disabled: boolean) {
      await getTestDb().insert(userPasskeys).values({
        userId,
        credentialId: `cred-${userId}-${Math.random().toString(36).slice(2, 10)}`,
        publicKey: 'test-public-key',
        deviceType: 'singleDevice',
        disabledAt: disabled ? new Date() : null,
      });
    }

    it('kill switch off: a factorless holder of a force_mfa role keeps renewing', async () => {
      process.env.MFA_FORCE_FOR_PARTNER_ADMIN = 'false';
      const f = await buildFixture();
      await getTestDb().update(roles).set({ forceMfa: true }).where(eq(roles.id, f.role.id));
      await resnapshot(f);

      const result = await renewRevocationLease(f.session.id);

      expect(result.status).toBe('renewed');
      expect(teardownDisconnectedSessions).not.toHaveBeenCalled();
    });

    it('kill switch on: the open enrolment grace window keeps the session renewing', async () => {
      process.env.MFA_FORCE_FOR_PARTNER_ADMIN = 'true';
      const f = await buildFixture();
      await getTestDb().update(roles).set({ forceMfa: true }).where(eq(roles.id, f.role.id));
      await resnapshot(f);

      const result = await renewRevocationLease(f.session.id);

      expect(result.status).toBe('renewed');
    });

    it('revokes a factorless user when org settings require MFA, even with the kill switch off', async () => {
      process.env.MFA_FORCE_FOR_PARTNER_ADMIN = 'false';
      const f = await buildFixture();
      await requireMfaForOrg(f.org.id);
      await resnapshot(f);

      const result = await renewRevocationLease(f.session.id);

      expect(result).toMatchObject({ status: 'revoked', reason: 'mfa_required' });
    });

    // The Partner Admin axis the kill switch is named for: a partner-scoped
    // user (users.org_id NULL) whose PARTNER role forces MFA. Re-points the
    // fixture's session at a partner member; the policy then runs its
    // partner_users -> roles join and reads partners.settings for real.
    async function buildPartnerAdminFixture() {
      const db = getTestDb();
      const f = await buildFixture();
      const partnerRole = await createRole({
        scope: 'partner',
        partnerId: f.partner.id,
        name: `Partner Admin ${f.session.id}`,
      });
      await db.update(roles).set({ forceMfa: true }).where(eq(roles.id, partnerRole.id));
      const admin = await createUser({
        partnerId: f.partner.id,
        orgId: null,
        email: `lease-padmin-${f.session.id}@example.com`,
      });
      await assignUserToPartner(admin.id, f.partner.id, partnerRole.id, 'all');
      await db
        .update(remoteSessions)
        .set({ userId: admin.id })
        .where(eq(remoteSessions.id, f.session.id));
      const partnerFixture = { ...f, user: admin };
      await resnapshot(partnerFixture);
      return partnerFixture;
    }

    it('kill switch off: a factorless Partner Admin (force_mfa partner role) keeps renewing', async () => {
      process.env.MFA_FORCE_FOR_PARTNER_ADMIN = 'false';
      const f = await buildPartnerAdminFixture();

      const row = await loadRevocationRecheckRow(f.session.id);
      expect(row!.user.orgId).toBeNull();
      expect(row!.partnerMembership?.orgAccess).toBe('all');

      const result = await renewRevocationLease(f.session.id);
      expect(result.status).toBe('renewed');
    });

    it('revokes a factorless Partner Admin when PARTNER settings require MFA', async () => {
      process.env.MFA_FORCE_FOR_PARTNER_ADMIN = 'false';
      const f = await buildPartnerAdminFixture();
      await getTestDb()
        .update(partners)
        .set({ settings: { security: { requireMfa: true } } })
        .where(eq(partners.id, f.partner.id));

      const result = await renewRevocationLease(f.session.id);
      expect(result).toMatchObject({ status: 'revoked', reason: 'mfa_required' });
    });

    it('does not count a DISABLED passkey as MFA protection', async () => {
      const f = await buildFixture();
      await requireMfaForOrg(f.org.id);
      await addPasskey(f.user.id, true);
      await resnapshot(f);

      const row = await loadRevocationRecheckRow(f.session.id);
      expect(row!.user.mfaProtected).toBe(false);

      const result = await renewRevocationLease(f.session.id);
      expect(result).toMatchObject({ status: 'revoked', reason: 'mfa_required' });
    });

    it('counts a usable passkey as MFA protection', async () => {
      const f = await buildFixture();
      await requireMfaForOrg(f.org.id);
      await addPasskey(f.user.id, true);
      await addPasskey(f.user.id, false);
      await resnapshot(f);

      const row = await loadRevocationRecheckRow(f.session.id);
      expect(row!.user.mfaProtected).toBe(true);

      const result = await renewRevocationLease(f.session.id);
      expect(result.status).toBe('renewed');
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

  // SEC-038 W06 (#5537): the desktop-fence gate against the real column.
  describe('desktop fence capability gate (REMOTE_DESKTOP_FENCE_REQUIRED)', () => {
    const original = process.env.REMOTE_DESKTOP_FENCE_REQUIRED;
    afterEach(() => {
      if (original === undefined) delete process.env.REMOTE_DESKTOP_FENCE_REQUIRED;
      else process.env.REMOTE_DESKTOP_FENCE_REQUIRED = original;
    });

    it('gate off: admits an unfenced agent', async () => {
      delete process.env.REMOTE_DESKTOP_FENCE_REQUIRED;
      const f = await buildFixture({ fenceCapable: false });
      const result = await prepareRevocationLeaseForStart(f.session.id);
      expect(result.ok).toBe(true);
    });

    it('gate on: refuses an unfenced agent with agent_upgrade_required', async () => {
      process.env.REMOTE_DESKTOP_FENCE_REQUIRED = 'true';
      const f = await buildFixture({ fenceCapable: false });
      await expect(prepareRevocationLeaseForStart(f.session.id)).resolves.toEqual({
        ok: false,
        reason: 'agent_upgrade_required',
      });
    });

    it('gate on: admits a fenced agent', async () => {
      process.env.REMOTE_DESKTOP_FENCE_REQUIRED = 'true';
      const f = await buildFixture();
      const result = await prepareRevocationLeaseForStart(f.session.id);
      expect(result.ok).toBe(true);
    });

    // The session-create fail-fast probe reads the real columns too.
    it('isDesktopStartCapable mirrors the gate against the device row', async () => {
      const fenced = await buildFixture();
      const unfenced = await buildFixture({ fenceCapable: false });
      const noLease = await buildFixture({ leaseCapable: false });

      delete process.env.REMOTE_DESKTOP_FENCE_REQUIRED;
      await expect(isDesktopStartCapable(fenced.device.id)).resolves.toBe(true);
      await expect(isDesktopStartCapable(unfenced.device.id)).resolves.toBe(true);
      await expect(isDesktopStartCapable(noLease.device.id)).resolves.toBe(false);

      process.env.REMOTE_DESKTOP_FENCE_REQUIRED = 'true';
      await expect(isDesktopStartCapable(fenced.device.id)).resolves.toBe(true);
      await expect(isDesktopStartCapable(unfenced.device.id)).resolves.toBe(false);
      await expect(isDesktopStartCapable('00000000-0000-0000-0000-000000000000')).resolves.toBe(false);
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
