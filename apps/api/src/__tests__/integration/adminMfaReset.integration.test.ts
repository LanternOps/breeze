/**
 * RMM-QA-166 — admin MFA reset strips EVERY factor, including user_passkeys.
 *
 * Drives the real POST /users/:id/mfa/reset against real Postgres (breeze_app,
 * RLS-enforced) + real Redis, with the auth middleware mocked the same way
 * userDeleteResurrect.integration.test.ts does (opens a real
 * withDbAccessContext for the caller's partner scope).
 *
 *   I-1 mixed-factor target (TOTP secret + recovery codes + mfaMethod='sms' +
 *       verified phone + two passkeys + refresh family + pending Redis keys):
 *       200; userIsMfaProtected === false; zero user_passkeys rows; all six
 *       columns cleared; auth_epoch unchanged, mfa_epoch > before; family
 *       revoked with reason admin-mfa-reset; both Redis keys gone; audit row
 *       user.mfa_reset with actor_id = admin and details.passkeysDeleted === 2.
 *   I-2 passkey-only target (mfa_enabled=false, one live passkey): 200 and the
 *       row is gone — main refuses this with 400 (column gate).
 *
 * Run:
 *   pnpm test-stack up   # worktree root
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/adminMfaReset.integration.test.ts
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

type AuthCtx = {
  scope: 'partner';
  partnerId: string;
  accessiblePartnerIds: string[];
  userId: string;
};

let activeAuthContext: AuthCtx | null = null;

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  const { withDbAccessContext } = await import('../../db');
  return {
    ...actual,
    authMiddleware: (c: any, next: any) => {
      if (!activeAuthContext) return c.json({ error: 'Unauthorized' }, 401);
      const ctx = activeAuthContext;
      c.set('auth', {
        scope: ctx.scope,
        partnerId: ctx.partnerId,
        partnerOrgAccess: 'all',
        orgId: null,
        accessibleOrgIds: [],
        user: { id: ctx.userId, email: 'admin@integration.test' },
        token: { mfa: true },
      });
      return withDbAccessContext(
        {
          scope: ctx.scope,
          orgId: null,
          accessibleOrgIds: [],
          accessiblePartnerIds: ctx.accessiblePartnerIds,
          userId: ctx.userId,
        },
        () => next(),
      );
    },
    hasSatisfiedMfa: () => true,
    requireMfa: () => (_c: any, next: any) => next(),
    requirePermission: () => (_c: any, next: any) => next(),
  };
});

import { auditLogs, refreshTokenFamilies, userPasskeys, users } from '../../db/schema';
import { userIsMfaProtected } from '../../routes/auth/helpers';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';
import { assignUserToPartner, createPartner, createRole, createUser } from './db-utils';
import { getTestDb, getTestRedis } from './setup';

async function buildApp() {
  const { userRoutes } = await import('../../routes/users');
  const { authMiddleware } = await import('../../middleware/auth');
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/users', userRoutes);
  return app;
}

async function readUser(id: string) {
  const [row] = await getTestDb().select().from(users).where(eq(users.id, id)).limit(1);
  if (!row) throw new Error(`user ${id} not found`);
  return row;
}

async function passkeyRows(userId: string) {
  return getTestDb().select({ id: userPasskeys.id }).from(userPasskeys).where(eq(userPasskeys.userId, userId));
}

async function seedPasskey(userId: string, suffix: string, disabledAt: Date | null = null) {
  const [row] = await getTestDb()
    .insert(userPasskeys)
    .values({
      userId,
      credentialId: `cred-${suffix}-${userId}`,
      publicKey: 'dGVzdC1wdWJsaWMta2V5',
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
      name: `key-${suffix}`,
      disabledAt,
    })
    .returning();
  return row!;
}

async function waitForAuditRow(action: string, resourceId: string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const [row] = await getTestDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, action), eq(auditLogs.resourceId, resourceId)))
      .limit(1);
    if (row) return row;
    if (Date.now() > deadline) throw new Error(`audit row ${action} for ${resourceId} never appeared`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function seedTenant() {
  const partner = await createPartner();
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  const admin = await createUser({ partnerId: partner.id, email: `admin-${Date.now()}@example.com`, status: 'active' });
  await assignUserToPartner(admin.id, partner.id, role.id, 'all');
  activeAuthContext = { scope: 'partner', partnerId: partner.id, accessiblePartnerIds: [partner.id], userId: admin.id };
  return { partner, role, admin };
}

beforeEach(() => { activeAuthContext = null; });
afterEach(() => { activeAuthContext = null; vi.clearAllMocks(); });

describe('POST /users/:id/mfa/reset — strips every factor (RMM-QA-166)', () => {
  it('I-1: mixed TOTP+SMS+recovery+phone+two-passkey target is fully reset, sessions cut, audit names the admin', async () => {
    const { partner, role, admin } = await seedTenant();
    const target = await createUser({ partnerId: partner.id, email: `mixed-${Date.now()}@example.com`, status: 'active', mfaEnabled: true });
    await assignUserToPartner(target.id, partner.id, role.id);
    await getTestDb().update(users).set({
      mfaMethod: 'sms',
      mfaSecret: 'enc:seeded-secret',
      mfaRecoveryCodes: ['hash-a', 'hash-b'],
      phoneNumber: '+15550100',
      phoneVerified: true,
    }).where(eq(users.id, target.id));
    const pk1 = await seedPasskey(target.id, 'one');
    const pk2 = await seedPasskey(target.id, 'two');
    const familyId = await mintRefreshTokenFamily(target.id);
    const redis = getTestRedis();
    await redis.set(`mfa:setup:${target.id}`, JSON.stringify({ secret: 'pending' }), 'EX', 600);
    await redis.set(`passkey:challenge:registration:${target.id}`, '{}', 'EX', 300);

    const before = await readUser(target.id);
    expect(await userIsMfaProtected(target.id)).toBe(true);

    const app = await buildApp();
    const res = await app.request(`/users/${target.id}/mfa/reset`, { method: 'POST' });
    expect(res.status).toBe(200);

    // Every factor is gone — this is the finding's core claim.
    expect(await userIsMfaProtected(target.id)).toBe(false);
    expect(await passkeyRows(target.id)).toHaveLength(0);
    const after = await readUser(target.id);
    expect(after).toMatchObject({
      mfaEnabled: false, mfaMethod: null, mfaSecret: null, mfaRecoveryCodes: null, phoneNumber: null, phoneVerified: false,
    });
    // Assurance invalidated: mfa_epoch advanced (auth_epoch is not the reset's concern).
    expect(after.mfaEpoch).toBeGreaterThan(before.mfaEpoch);
    expect(after.authEpoch).toBe(before.authEpoch);
    const [family] = await getTestDb().select().from(refreshTokenFamilies).where(eq(refreshTokenFamilies.familyId, familyId)).limit(1);
    expect(family?.revokedAt).not.toBeNull();
    expect(family?.revokedReason).toBe('admin-mfa-reset');
    // Pending artifacts swept.
    expect(await redis.exists(`mfa:setup:${target.id}`)).toBe(0);
    expect(await redis.exists(`passkey:challenge:registration:${target.id}`)).toBe(0);
    // Audit identifies the administrator and the deleted credentials.
    const audit = await waitForAuditRow('user.mfa_reset', target.id);
    expect(audit.actorId).toBe(admin.id);
    const details = audit.details as { passkeysDeleted: number; factors: { passkeys: Array<{ id: string }> } };
    expect(details.passkeysDeleted).toBe(2);
    expect(details.factors.passkeys.map((p) => p.id).sort()).toEqual([pk1.id, pk2.id].sort());
  });

  it('I-2: a passkey-only leftover (mfa_enabled=false, live passkey) is reset, not refused', async () => {
    const { partner, role } = await seedTenant();
    const target = await createUser({ partnerId: partner.id, email: `pkonly-${Date.now()}@example.com`, status: 'active', mfaEnabled: false });
    await assignUserToPartner(target.id, partner.id, role.id);
    await seedPasskey(target.id, 'only');
    expect(await userIsMfaProtected(target.id)).toBe(true);

    const app = await buildApp();
    const res = await app.request(`/users/${target.id}/mfa/reset`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await passkeyRows(target.id)).toHaveLength(0);
    expect(await userIsMfaProtected(target.id)).toBe(false);
  });
});
