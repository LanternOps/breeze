/**
 * RMM-QA-166 I-3 — clean re-enrollment after an admin reset.
 *
 * Real Postgres + real Redis + the REAL authMiddleware (JWTs minted with
 * createAccessToken, epochs read from the live row). Proves the exit-contract
 * clause "old credentials fail, clean re-enrollment succeeds":
 *
 *   1. target holds TOTP + one passkey; admin resets via the real route → 200.
 *   2. userIsMfaProtected(target) === false (on main: still true — the
 *      passkey row survives the reset).
 *   3. POST /auth/mfa/setup with password only → 200 (no SR2-20 gate lives on
 *      /setup, so this is 200 on main too — recorded, not the discriminator).
 *   4. POST /auth/mfa/verify (Case 2, setup confirmation) with a VALID TOTP
 *      code and NO stepUpGrantId → 200 and the account is TOTP-enrolled. On
 *      main this is 403 `existing_factor_step_up_required`: the stale passkey
 *      makes enforceExistingFactorStepUp demand proof from the lost key.
 *   5. Re-inserting a passkey with the SAME credential_id as the deleted one
 *      succeeds (D1's UNIQUE-constraint argument, executed; on main it is a
 *      unique violation).
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/mfaReenrollmentAfterReset.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { generate } from 'otplib';
import { partnerUsers, userPasskeys, users } from '../../db/schema';
import { authBindingRoutes } from '../../routes/auth/binding';
import { userIsMfaProtected } from '../../routes/auth/helpers';
import { mfaRoutes } from '../../routes/auth/mfa';
import { userRoutes } from '../../routes/users';
import { authMiddleware } from '../../middleware/auth';
import { createAccessToken } from '../../services/jwt';
import { assignUserToPartner, createPartner, createRole, createUser, grantRolePermissions } from './db-utils';
import { getTestDb } from './setup';

const PASSWORD = 'TestPass123!';

async function readUser(id: string) {
  const [row] = await getTestDb().select().from(users).where(eq(users.id, id)).limit(1);
  if (!row) throw new Error(`user ${id} not found`);
  return row;
}

async function mintToken(userId: string, email: string, partnerId: string, roleId: string, mfa: boolean) {
  const live = await readUser(userId);
  return createAccessToken({
    sub: userId, email, roleId, orgId: null, partnerId, scope: 'partner', mfa,
    aep: live.authEpoch, mep: live.mfaEpoch, sid: randomUUID(),
  });
}

async function browserBindingCookie(): Promise<string> {
  const response = await authBindingRoutes.request('/browser-binding/bootstrap', { method: 'POST' });
  expect(response.status).toBe(204);
  const cookie = response.headers.get('set-cookie') ?? '';
  const binding = /(?:^|,\s*)breeze_auth_binding=([0-9a-f]{64})/.exec(cookie)?.[1];
  if (!binding) throw new Error('bootstrap did not return an auth binding');
  return `breeze_auth_binding=${binding}`;
}

describe('admin reset → password-only TOTP re-enrollment (RMM-QA-166 I-3)', () => {
  it('a reset user re-enrolls with password only and can re-register the same authenticator', async () => {
    const partner = await createPartner();
    const adminRole = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(adminRole.id, [{ resource: '*', action: '*' }]);
    const admin = await createUser({ partnerId: partner.id, email: `admin-${Date.now()}@example.com`, status: 'active' });
    await assignUserToPartner(admin.id, partner.id, adminRole.id, 'all');

    const target = await createUser({ partnerId: partner.id, email: `target-${Date.now()}@example.com`, status: 'active', password: PASSWORD, withMembership: true, mfaEnabled: true });
    await getTestDb().update(users).set({ mfaMethod: 'totp', mfaSecret: 'enc:old-secret', mfaRecoveryCodes: ['hash-old'] }).where(eq(users.id, target.id));
    const credentialId = `cred-reuse-${target.id}`;
    await getTestDb().insert(userPasskeys).values({
      userId: target.id, credentialId, publicKey: 'dGVzdC1wdWJsaWMta2V5', counter: 0, deviceType: 'singleDevice', backedUp: false, name: 'lost-key',
    });
    const [membership] = await getTestDb().select({ roleId: partnerUsers.roleId }).from(partnerUsers).where(eq(partnerUsers.userId, target.id)).limit(1);
    if (!membership) throw new Error('target membership missing');

    const app = new Hono();
    app.use('/users/*', authMiddleware as never);
    app.route('/users', userRoutes);
    app.route('/auth', mfaRoutes);

    // 1. admin reset via the real route (requireMfa: admin token carries mfa:true).
    const adminToken = await mintToken(admin.id, admin.email, partner.id, adminRole.id, true);
    const reset = await app.request(`/users/${target.id}/mfa/reset`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
    expect(reset.status).toBe(200);

    // 2. no factor remains — the gate that blocked re-enrollment is open.
    expect(await userIsMfaProtected(target.id)).toBe(false);

    // 3. password-only setup.
    const targetToken = await mintToken(target.id, target.email, partner.id, membership.roleId, false);
    const setup = await app.request('/auth/mfa/setup', {
      method: 'POST',
      headers: { Authorization: `Bearer ${targetToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: PASSWORD }),
    });
    expect(setup.status).toBe(200);
    const { secret } = (await setup.json()) as { secret: string };
    expect(typeof secret).toBe('string');

    // 4. confirm with a valid code and NO stepUpGrantId (Case 2 of /mfa/verify).
    const code = await generate({ secret });
    const confirm = await app.request('/auth/mfa/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${targetToken}`, 'Content-Type': 'application/json', cookie: await browserBindingCookie() },
      body: JSON.stringify({ code }),
    });
    expect(confirm.status).toBe(200);
    const enrolled = await readUser(target.id);
    expect(enrolled.mfaEnabled).toBe(true);
    expect(enrolled.mfaMethod).toBe('totp');

    // 5. the deleted credential id is free again (hard DELETE, not soft-disable).
    await expect(getTestDb().insert(userPasskeys).values({
      userId: target.id, credentialId, publicKey: 'dGVzdC1wdWJsaWMta2V5', counter: 0, deviceType: 'singleDevice', backedUp: false, name: 'same-key-again',
    })).resolves.toBeDefined();
  });
});
