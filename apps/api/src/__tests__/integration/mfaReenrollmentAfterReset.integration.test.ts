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
import { createHash, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { generate } from 'otplib';
import { partnerUsers, userPasskeys, users } from '../../db/schema';
import { authBindingRoutes } from '../../routes/auth/binding';
import { encryptMfaSecret, hashRecoveryCodes, userIsMfaProtected } from '../../routes/auth/helpers';
import { mfaRoutes } from '../../routes/auth/mfa';
import { userRoutes } from '../../routes/users';
import { authMiddleware } from '../../middleware/auth';
import { createAccessToken } from '../../services/jwt';
import { assignUserToPartner, createPartner, createRole, createUser, grantRolePermissions } from './db-utils';
import { getTestDb, getTestRedis } from './setup';
import { resetAllFactorsAndInvalidate } from '../../services/mfaFactorReset';
import { passkeyRoutes } from '../../routes/auth/passkeys';
import { resolveWebAuthnConfig } from '../../services/passkeys';
import { loginRoutes } from '../../routes/auth/login';

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

// Software authenticator producing a real ES256 COSE key and none attestation.
// The production WebAuthn verifier validates RP hash, origin, challenge and UV.
function registrationCredential(challenge: string, credentialId: Buffer, publicKey: KeyObject) {
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')],
  ]));
  const config = resolveWebAuthnConfig();
  const length = Buffer.alloc(2);
  length.writeUInt16BE(credentialId.length);
  const authData = Buffer.concat([
    createHash('sha256').update(config.rpID).digest(), Buffer.from([0x45]),
    Buffer.alloc(4), Buffer.alloc(16), length, credentialId, Buffer.from(cose),
  ]);
  const attestation = isoCBOR.encode(new Map<string, string | Uint8Array | Map<string, never>>([
    ['fmt', 'none'], ['attStmt', new Map<string, never>()], ['authData', authData],
  ]));
  return {
    id: credentialId.toString('base64url'), rawId: credentialId.toString('base64url'), type: 'public-key',
    response: {
      clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: config.origin })).toString('base64url'),
      attestationObject: Buffer.from(attestation).toString('base64url'), transports: ['internal'],
    },
    clientExtensionResults: {},
  };
}

describe('admin reset → password-only TOTP re-enrollment (RMM-QA-166 I-3)', () => {
  it('rejects old access, refresh, TOTP, recovery and passkey login authority after reset', async () => {
    const partner = await createPartner();
    const target = await createUser({ partnerId: partner.id, password: PASSWORD, withMembership: true, status: 'active' });
    const login = () => loginRoutes.request('/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: target.email, password: PASSWORD }),
    });
    const initial = await login();
    expect(initial.status).toBe(200);
    const session = await initial.json() as { tokens: { accessToken: string } };
    const cookies = initial.headers.get('set-cookie')!;
    const refresh = /breeze_refresh_token=([^;]+)/.exec(cookies)![1];
    const csrf = /breeze_csrf_token=([^;]+)/.exec(cookies)![1];
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const recovery = 'ABCD-EFGH';
    await getTestDb().update(users).set({
      mfaEnabled: true, mfaMethod: 'totp', mfaSecret: encryptMfaSecret(secret), mfaRecoveryCodes: hashRecoveryCodes([recovery]),
    }).where(eq(users.id, target.id));
    const credentialId = randomBytes(32).toString('base64url');
    await getTestDb().insert(userPasskeys).values({ userId: target.id, credentialId, publicKey: 'AQID', counter: 0, deviceType: 'singleDevice', backedUp: false });
    const pendingLogin = await login();
    expect(pendingLogin.status).toBe(200);
    const pending = await pendingLogin.json() as { mfaRequired: boolean; tempToken: string };
    expect(pending.mfaRequired).toBe(true);
    const key = `mfa:pending:${pending.tempToken}`;
    const pendingRecord = await getTestRedis().get(key);
    expect(pendingRecord).not.toBeNull();
    await resetAllFactorsAndInvalidate(target.id, 'admin-mfa-reset');
    const oldAccess = await mfaRoutes.request('/mfa/setup', {
      method: 'POST', headers: { Authorization: `Bearer ${session.tokens.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: PASSWORD }),
    });
    expect(oldAccess.status).toBe(401);
    const oldRefresh = await loginRoutes.request('/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-breeze-csrf': decodeURIComponent(csrf!), Cookie: `breeze_refresh_token=${refresh}; breeze_csrf_token=${csrf}` },
      body: '{}',
    });
    expect(oldRefresh.status).toBe(401);
    for (const proof of [{ method: 'totp', code: await generate({ secret }) }, { method: 'recovery', code: recovery }]) {
      await getTestRedis().set(key, pendingRecord!, 'EX', 300);
      const rejected = await mfaRoutes.request('/mfa/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempToken: pending.tempToken, ...proof }),
      });
      expect(rejected.status).toBe(401);
      expect(rejected.headers.get('set-cookie')).toBeNull();
    }
    await getTestRedis().set(key, pendingRecord!, 'EX', 300);
    const oldPasskey = await passkeyRoutes.request('/mfa/passkey/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempToken: pending.tempToken, credential: { id: credentialId } }),
    });
    expect(oldPasskey.status).toBe(401);
    expect(oldPasskey.headers.get('set-cookie')).toBeNull();
    const freshLogin = await login();
    expect(freshLogin.status).toBe(200);
    expect(await freshLogin.json()).toMatchObject({ mfaRequired: false });
  });

  it('rejects a pre-reset WebAuthn registration challenge and accepts fresh registration of the same authenticator', async () => {
    const partner = await createPartner();
    const target = await createUser({ partnerId: partner.id, password: PASSWORD, withMembership: true, status: 'active' });
    const [membership] = await getTestDb().select().from(partnerUsers).where(eq(partnerUsers.userId, target.id));
    const oldToken = await mintToken(target.id, target.email, partner.id, membership!.roleId, false);
    const options = async (token: string) => {
      const response = await passkeyRoutes.request('/passkeys/register/options', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: PASSWORD }),
      });
      expect(response.status).toBe(200);
      return (await response.json() as { options: { challenge: string } }).options;
    };
    const oldOptions = await options(oldToken);
    const redis = getTestRedis();
    const key = `passkey:challenge:registration:${target.id}`;
    const stale = await redis.get(key);
    expect(stale).not.toBeNull();
    await resetAllFactorsAndInvalidate(target.id, 'admin-mfa-reset');
    await redis.set(key, stale!, 'EX', 300);
    const freshToken = await mintToken(target.id, target.email, partner.id, membership!.roleId, false);
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const credentialId = randomBytes(32);
    const verify = async (challenge: string) => passkeyRoutes.request('/passkeys/register/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${freshToken}`, 'Content-Type': 'application/json', cookie: await browserBindingCookie() },
      body: JSON.stringify({ credential: registrationCredential(challenge, credentialId, publicKey) }),
    });
    expect((await verify(oldOptions.challenge)).status).toBe(400);
    expect((await readUser(target.id)).mfaEnabled).toBe(false);
    expect(await getTestDb().select().from(userPasskeys).where(eq(userPasskeys.userId, target.id))).toHaveLength(0);
    const freshOptions = await options(freshToken);
    expect((await verify(freshOptions.challenge)).status).toBe(200);
    const [enrolled] = await getTestDb().select().from(userPasskeys).where(eq(userPasskeys.userId, target.id));
    expect(enrolled?.credentialId).toBe(credentialId.toString('base64url'));
  });

  it.each(['/mfa/verify', '/mfa/enable'])('rejects pre-reset pending setup surviving Redis cleanup at %s', async (endpoint) => {
    const partner = await createPartner();
    const target = await createUser({ partnerId: partner.id, password: PASSWORD, withMembership: true, status: 'active' });
    const [membership] = await getTestDb().select().from(partnerUsers).where(eq(partnerUsers.userId, target.id));
    const oldToken = await mintToken(target.id, target.email, partner.id, membership!.roleId, false);
    const setup = await mfaRoutes.request('/mfa/setup', {
      method: 'POST', headers: { Authorization: `Bearer ${oldToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: PASSWORD }),
    });
    expect(setup.status).toBe(200);
    const { secret } = await setup.json() as { secret: string };
    const redis = getTestRedis();
    const key = `mfa:setup:${target.id}`;
    const staleSetup = await redis.get(key);
    expect(staleSetup).not.toBeNull();
    await resetAllFactorsAndInvalidate(target.id, 'admin-mfa-reset');
    // Model failed DEL or a delayed pre-reset setup writer arriving after it.
    await redis.set(key, staleSetup!, 'EX', 600);
    const freshToken = await mintToken(target.id, target.email, partner.id, membership!.roleId, false);
    const response = await mfaRoutes.request(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${freshToken}`, 'Content-Type': 'application/json', cookie: await browserBindingCookie() },
      body: JSON.stringify({ code: await generate({ secret }), currentPassword: PASSWORD }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'MFA setup expired. Please start setup again.' });
    expect((await readUser(target.id)).mfaEnabled).toBe(false);
  });

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
