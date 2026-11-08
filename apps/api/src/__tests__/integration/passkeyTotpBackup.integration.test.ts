/**
 * #10650 — authenticator app (TOTP) as a backup beside a primary passkey.
 *
 * Real Postgres (breeze_app, RLS-enforced) + real Redis + the REAL
 * authMiddleware, auth routes, session-replacement primitives, epochs,
 * refresh families, step-up grants and audit. Only the WebAuthn ASSERTION
 * verifier (`verifyPasskeyAuthentication`) is stubbed, so a passkey step-up
 * proves "the user tapped their passkey" without a real authenticator; the
 * one passkey REGISTRATION below is a real software-authenticator ceremony.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/passkeyTotpBackup.integration.test.ts
 *   pnpm test-stack down
 */
import './setup';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { generate } from 'otplib';

vi.mock('../../services/passkeys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/passkeys')>();
  return { ...actual, verifyPasskeyAuthentication: vi.fn() };
});

import { verifyPasskeyAuthentication, resolveWebAuthnConfig } from '../../services/passkeys';
import { partnerUsers, partners, refreshTokenFamilies, userPasskeys, users } from '../../db/schema';
import { authRoutes } from '../../routes/auth';
import { authBindingRoutes } from '../../routes/auth/binding';
import { decryptMfaSecret, encryptMfaSecret, hashRecoveryCodes } from '../../routes/auth/helpers';
import { userRoutes } from '../../routes/users';
import { authMiddleware } from '../../middleware/auth';
import { createAccessToken } from '../../services/jwt';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';
import { resetAllFactorsAndInvalidate } from '../../services/mfaFactorReset';
import { createPartner, createUser } from './db-utils';
import { getTestDb, getTestRedis } from './setup';

const PASSWORD = 'TestPass123!';
const RECOVERY = ['AAAA-BBBB', 'CCCC-DDDD'];

const app = new Hono();
app.use('/users/*', authMiddleware as never);
app.route('/users', userRoutes);
app.route('/auth', authRoutes);

async function readUser(id: string) {
  const [row] = await getTestDb().select().from(users).where(eq(users.id, id)).limit(1);
  if (!row) throw new Error(`user ${id} not found`);
  return row;
}

async function activePasskeys(userId: string) {
  return getTestDb().select().from(userPasskeys)
    .where(and(eq(userPasskeys.userId, userId), isNull(userPasskeys.disabledAt)));
}

async function browserBindingCookie(): Promise<string> {
  const response = await authBindingRoutes.request('/browser-binding/bootstrap', { method: 'POST' });
  expect(response.status).toBe(204);
  const cookie = response.headers.get('set-cookie') ?? '';
  const binding = /(?:^|,\s*)breeze_auth_binding=([0-9a-f]{64})/.exec(cookie)?.[1];
  if (!binding) throw new Error('bootstrap did not return an auth binding');
  return `breeze_auth_binding=${binding}`;
}

/** Unverified claim read — these tests own the tokens they inspect. */
function claims(jwt: string): Record<string, unknown> {
  const [, payload] = jwt.split('.');
  return JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Each TOTP time step is single-use per user; start every proof from a clean slate. */
async function forgetUsedTotpSteps(userId: string) {
  await getTestRedis().del(`mfa:usedstep:${userId}`);
}

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Resolves once `expected` backends are waiting (directly or transitively) on `blockerPid`. */
async function waitForBlockedBackends(monitor: Sql, blockerPid: number, expected: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const [row] = await monitor<{ waiting: number }[]>`
      WITH RECURSIVE wait_chain(pid) AS (
        SELECT pid FROM pg_catalog.pg_stat_activity
        WHERE datname = current_database() AND state = 'active'
          AND ${blockerPid}::int = ANY(pg_catalog.pg_blocking_pids(pid))
        UNION
        SELECT activity.pid FROM pg_catalog.pg_stat_activity activity
        JOIN wait_chain blocker ON blocker.pid = ANY(pg_catalog.pg_blocking_pids(activity.pid))
        WHERE activity.datname = current_database() AND activity.state = 'active'
      )
      SELECT count(*)::int AS waiting FROM wait_chain
    `;
    if ((row?.waiting ?? 0) >= expected) return;
    if (Date.now() > deadline) throw new Error(`only ${row?.waiting ?? 0} of ${expected} requests reached the users-row lock`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Hold the caller's users row `FOR UPDATE` from a separate connection, so each
 * request runs every pre-check and then parks on the row lock its factor
 * write takes. Requests are started one at a time (each `start` waits until
 * the previous one is parked), which also keeps TOTP codes accepted in step
 * order. `release` lets them race for the lock.
 *
 * The holder and the wait-chain monitor each get a dedicated connection: the
 * shared test pool is not used while a request is parked.
 *
 * `noKeyUpdate` holds `FOR NO KEY UPDATE` instead — what an UPDATE of the row
 * takes — so the request still parks, but an FK insert referencing the row
 * (which needs only `FOR KEY SHARE`) can commit while it waits.
 */
async function userRowBarrier(userId: string, { noKeyUpdate = false }: { noKeyUpdate?: boolean } = {}) {
  const holderClient: Sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const monitor: Sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const locked = deferred();
  const released = deferred();
  let pid = 0;
  const holder = holderClient.begin(async (tx) => {
    if (noKeyUpdate) await tx`SELECT id FROM users WHERE id = ${userId} FOR NO KEY UPDATE`;
    else await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    pid = row!.pid;
    locked.resolve();
    await released.promise;
  });
  await locked.promise;
  let parked = 0;
  return {
    // Returns the in-flight request WRAPPED: an async function that returned the
    // promise itself would adopt it, and awaiting `start` would then wait for a
    // request that cannot finish until `release`.
    async start(request: () => Promise<Response>): Promise<{ response: Promise<Response> }> {
      const response = request();
      parked += 1;
      await waitForBlockedBackends(monitor, pid, parked);
      return { response };
    },
    async release() {
      released.resolve();
      await holder;
      await Promise.all([holderClient.end({ timeout: 1 }), monitor.end({ timeout: 1 })]);
    },
  };
}

async function setPartnerSecurity(partnerId: string, security: Record<string, unknown>) {
  await getTestDb().update(partners).set({ settings: { security } }).where(eq(partners.id, partnerId));
}

type Fixture = Awaited<ReturnType<typeof passkeyPrimaryAccount>>;

/** A partner technician whose only factor is one passkey (passkey primary). */
async function passkeyPrimaryAccount() {
  const partner = await createPartner();
  const user = await createUser({
    partnerId: partner.id,
    password: PASSWORD,
    withMembership: true,
    status: 'active',
    email: `passkey-primary-${randomUUID()}@example.test`,
  });
  const [membership] = await getTestDb().select({ roleId: partnerUsers.roleId }).from(partnerUsers)
    .where(eq(partnerUsers.userId, user.id)).limit(1);
  const credentialId = `cred-${randomUUID()}`;
  const [passkey] = await getTestDb().insert(userPasskeys).values({
    userId: user.id, credentialId, publicKey: 'dGVzdC1wdWJsaWMta2V5', counter: 0,
    deviceType: 'singleDevice', backedUp: false, name: 'laptop',
  }).returning();
  await getTestDb().update(users).set({
    mfaEnabled: true, mfaMethod: 'passkey', mfaSecret: null, mfaRecoveryCodes: hashRecoveryCodes(RECOVERY),
  }).where(eq(users.id, user.id));
  return { partner, user, roleId: membership!.roleId, credentialId, passkeyId: passkey!.id, sid: randomUUID() };
}

/** A token for the fixture's session, bound to the LIVE epochs. */
async function tokenFor(fx: Fixture, mfa = true) {
  const live = await readUser(fx.user.id);
  return createAccessToken({
    sub: fx.user.id, email: fx.user.email, roleId: fx.roleId, orgId: null, partnerId: fx.partner.id,
    scope: 'partner', mfa, ...(mfa ? { mfa_src: 'factor' as const } : {}),
    aep: live.authEpoch, mep: live.mfaEpoch, sid: fx.sid,
  });
}

async function post(path: string, token: string | null, body: unknown, cookie?: string) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function passkeyStepUp(fx: Fixture, operation: string, extra: Record<string, unknown> = {}) {
  const res = await post('/auth/mfa/step-up', await tokenFor(fx), {
    method: 'passkey', credential: { id: fx.credentialId }, operation, ...extra,
  });
  expect(res.status).toBe(200);
  return (await res.json() as { stepUpGrantId: string }).stepUpGrantId;
}

async function stageBackup(fx: Fixture) {
  const setup = await post('/auth/mfa/setup', await tokenFor(fx), { currentPassword: PASSWORD });
  expect(setup.status).toBe(200);
  return (await setup.json() as { secret: string }).secret;
}

async function addBackup(fx: Fixture) {
  const secret = await stageBackup(fx);
  const stepUpGrantId = await passkeyStepUp(fx, 'add_factor');
  await forgetUsedTotpSteps(fx.user.id);
  const res = await post('/auth/mfa/enable', await tokenFor(fx), {
    code: await generate({ secret }), currentPassword: PASSWORD, stepUpGrantId,
  }, await browserBindingCookie());
  return { res, secret };
}

// Software authenticator producing a real ES256 COSE key and none attestation.
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

beforeEach(() => {
  vi.mocked(verifyPasskeyAuthentication).mockReset().mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter: 1, credentialDeviceType: 'singleDevice', credentialBackedUp: false },
  } as Awaited<ReturnType<typeof verifyPasskeyAuthentication>>);
});

describe('#10650 authenticator app as a passkey backup (real PG + Redis)', () => {
  it('1. setup → passkey step-up → enable adds the backup: primary, codes and the caller kept; every other session revoked', async () => {
    const fx = await passkeyPrimaryAccount();
    const priorFamilies = [await mintRefreshTokenFamily(fx.user.id), await mintRefreshTokenFamily(fx.user.id)];
    const before = await readUser(fx.user.id);

    const { res, secret } = await addBackup(fx);

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ success: true, backup: true });
    expect(body).not.toHaveProperty('recoveryCodes');
    expect(body.tokens).toMatchObject({ accessToken: expect.any(String) });

    const after = await readUser(fx.user.id);
    expect(after.mfaEnabled).toBe(true);
    expect(after.mfaMethod).toBe('passkey');
    expect(decryptMfaSecret(after.mfaSecret)).toBe(secret);
    expect(after.mfaEpoch).toBe(before.mfaEpoch + 1);
    expect(after.mfaRecoveryCodes).toEqual(before.mfaRecoveryCodes);

    const families = await getTestDb().select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, fx.user.id));
    for (const familyId of priorFamilies) {
      const prior = families.find((f) => f.familyId === familyId);
      expect(prior, `prior family ${familyId}`).toBeDefined();
      expect(prior!.revokedAt).toBeInstanceOf(Date);
    }
    expect(families.filter((f) => f.revokedAt === null)).toHaveLength(1);
    expect(claims((body.tokens as { accessToken: string }).accessToken)).toMatchObject({ mep: after.mfaEpoch, mfa: true });

    const me = await app.request('/users/me', { headers: { Authorization: `Bearer ${(body.tokens as { accessToken: string }).accessToken}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ mfaMethod: 'passkey', totpEnrolled: true });
  });

  it('2. login offers the authenticator app beside the passkey, and a TOTP login mints an MFA-assured session', async () => {
    const fx = await passkeyPrimaryAccount();
    const { res, secret } = await addBackup(fx);
    expect(res.status).toBe(200);

    const cookie = await browserBindingCookie();
    const login = await post('/auth/login', null, { email: fx.user.email, password: PASSWORD }, cookie);
    expect(login.status).toBe(200);
    const challenge = await login.json() as { mfaRequired: boolean; tempToken: string; mfaMethod: string; allowedMethods: Record<string, boolean> };
    expect(challenge).toMatchObject({ mfaRequired: true, mfaMethod: 'passkey', allowedMethods: { totp: true, passkey: true } });

    await forgetUsedTotpSteps(fx.user.id);
    const verify = await post('/auth/mfa/verify', null, {
      tempToken: challenge.tempToken, code: await generate({ secret }), method: 'totp',
    }, cookie);
    expect(verify.status).toBe(200);
    const session = await verify.json() as { tokens: { accessToken: string } };
    expect(claims(session.tokens.accessToken)).toMatchObject({ mfa: true, sub: fx.user.id });
  });

  it('3. after a lost passkey, a TOTP step-up deletes the last passkey: TOTP is promoted and the codes are kept', async () => {
    const fx = await passkeyPrimaryAccount();
    const { res, secret } = await addBackup(fx);
    expect(res.status).toBe(200);
    const before = await readUser(fx.user.id);

    await forgetUsedTotpSteps(fx.user.id);
    const stepUp = await post('/auth/mfa/step-up', await tokenFor(fx), {
      method: 'totp', code: await generate({ secret }), operation: 'delete_passkey', passkeyId: fx.passkeyId,
    });
    expect(stepUp.status).toBe(200);
    const { stepUpGrantId } = await stepUp.json() as { stepUpGrantId: string };

    const del = await app.request(`/auth/passkeys/${fx.passkeyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await tokenFor(fx)}`, 'Content-Type': 'application/json', cookie: await browserBindingCookie() },
      body: JSON.stringify({ currentPassword: PASSWORD, stepUpGrantId }),
    });
    expect(del.status).toBe(200);

    const after = await readUser(fx.user.id);
    expect(after).toMatchObject({ mfaEnabled: true, mfaMethod: 'totp' });
    expect(after.mfaSecret).toBe(before.mfaSecret);
    expect(after.mfaRecoveryCodes).toEqual(before.mfaRecoveryCodes);
    expect(await activePasskeys(fx.user.id)).toHaveLength(0);
  });

  it('4. two concurrent confirmations with distinct grants and codes: exactly one write and one epoch bump', async () => {
    const fx = await passkeyPrimaryAccount();
    const before = await readUser(fx.user.id);
    const secret = await stageBackup(fx);
    const grantA = await passkeyStepUp(fx, 'add_factor');
    const grantB = await passkeyStepUp(fx, 'add_factor');
    await forgetUsedTotpSteps(fx.user.id);
    const now = Math.floor(Date.now() / 1000);
    const token = await tokenFor(fx);
    const [cookieA, cookieB] = [await browserBindingCookie(), await browserBindingCookie()];
    // Distinct, step-ordered codes: the replay guard accepts a step only if it
    // is newer than the last accepted one, so A (older) must verify first.
    const codeA = await generate({ secret, epoch: now - 30 });
    const codeB = await generate({ secret });

    const barrier = await userRowBarrier(fx.user.id);
    const first = await barrier.start(() =>
      post('/auth/mfa/enable', token, { code: codeA, currentPassword: PASSWORD, stepUpGrantId: grantA }, cookieA));
    const second = await barrier.start(() =>
      post('/auth/mfa/enable', token, { code: codeB, currentPassword: PASSWORD, stepUpGrantId: grantB }, cookieB));
    await barrier.release();
    const results = await Promise.all([first.response, second.response]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(await loser.json()).toMatchObject({ code: 'factor_state_changed', stepUpGrantConsumed: true });

    const after = await readUser(fx.user.id);
    expect(after.mfaEpoch).toBe(before.mfaEpoch + 1);
    expect(after.mfaMethod).toBe('passkey');
    expect(decryptMfaSecret(after.mfaSecret)).toBe(secret);
  });

  it('5. concurrent TOTP removal and last-passkey delete under requireMfa: a policy-allowed factor survives', async () => {
    const fx = await passkeyPrimaryAccount();
    const { res } = await addBackup(fx);
    expect(res.status).toBe(200);
    await setPartnerSecurity(fx.partner.id, { requireMfa: true });

    const removeGrant = await passkeyStepUp(fx, 'remove_totp');
    const deleteGrant = await passkeyStepUp(fx, 'delete_passkey', { passkeyId: fx.passkeyId });
    const token = await tokenFor(fx);
    const [cookieA, cookieB] = [await browserBindingCookie(), await browserBindingCookie()];

    // Both pass every pre-check against the same snapshot (each sees the other
    // factor still present), then race for the users-row lock.
    const barrier = await userRowBarrier(fx.user.id);
    const removalPending = await barrier.start(() =>
      post('/auth/mfa/totp/remove', token, { currentPassword: PASSWORD, stepUpGrantId: removeGrant }, cookieA));
    const deletionPending = await barrier.start(async () => app.request(`/auth/passkeys/${fx.passkeyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', cookie: cookieB },
      body: JSON.stringify({ currentPassword: PASSWORD, stepUpGrantId: deleteGrant }),
    }));
    await barrier.release();
    const [removal, deletion] = await Promise.all([removalPending.response, deletionPending.response]);
    expect([removal.status, deletion.status].sort()).toEqual([200, 409]);

    const after = await readUser(fx.user.id);
    const passkeysLeft = (await activePasskeys(fx.user.id)).length;
    const totpLeft = after.mfaSecret !== null && (after.mfaMethod === 'totp' || after.mfaMethod === 'passkey');
    expect(after.mfaEnabled).toBe(true);
    expect(passkeysLeft > 0 || totpLeft).toBe(true);
  });

  it('6. an admin reset between setup and confirm: the confirm fails as expired and no secret is written', async () => {
    const fx = await passkeyPrimaryAccount();
    const secret = await stageBackup(fx);
    const key = `mfa:setup:${fx.user.id}`;
    const staged = await getTestRedis().get(key);
    expect(staged).not.toBeNull();

    await resetAllFactorsAndInvalidate(fx.user.id, 'admin-mfa-reset');
    // Model a failed DEL / delayed writer: the pre-reset record is back.
    await getTestRedis().set(key, staged!, 'EX', 600);

    await forgetUsedTotpSteps(fx.user.id);
    const res = await post('/auth/mfa/enable', await tokenFor(fx), {
      code: await generate({ secret }), currentPassword: PASSWORD,
    }, await browserBindingCookie());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'MFA setup expired. Please start setup again.' });
    expect((await readUser(fx.user.id)).mfaSecret).toBeNull();
  });

  it('7. a disallowed backup secret does not survive MFA-off, so a new first passkey brings no TOTP back', async () => {
    const fx = await passkeyPrimaryAccount();
    const { res } = await addBackup(fx);
    expect(res.status).toBe(200);
    await setPartnerSecurity(fx.partner.id, { requireMfa: false, allowedMethods: { totp: false, sms: true } });

    const deleteGrant = await passkeyStepUp(fx, 'delete_passkey', { passkeyId: fx.passkeyId });
    const del = await app.request(`/auth/passkeys/${fx.passkeyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await tokenFor(fx)}`, 'Content-Type': 'application/json', cookie: await browserBindingCookie() },
      body: JSON.stringify({ currentPassword: PASSWORD, stepUpGrantId: deleteGrant }),
    });
    expect(del.status).toBe(200);
    expect(await readUser(fx.user.id)).toMatchObject({ mfaEnabled: false, mfaMethod: null, mfaSecret: null, mfaRecoveryCodes: null });

    // Enroll a brand-new first passkey through the real WebAuthn ceremony.
    const token = await tokenFor(fx, false);
    const options = await post('/auth/passkeys/register/options', token, { currentPassword: PASSWORD });
    expect(options.status).toBe(200);
    const { challenge } = (await options.json() as { options: { challenge: string } }).options;
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const register = await post('/auth/passkeys/register/verify', token, {
      credential: registrationCredential(challenge, randomBytes(32), publicKey),
    }, await browserBindingCookie());
    expect(register.status).toBe(200);
    const registered = await register.json() as { tokens: { accessToken: string } };

    const after = await readUser(fx.user.id);
    expect(after).toMatchObject({ mfaEnabled: true, mfaMethod: 'passkey', mfaSecret: null });
    const me = await app.request('/users/me', { headers: { Authorization: `Bearer ${registered.tokens.accessToken}` } });
    expect(await me.json()).toMatchObject({ totpEnrolled: false });

    const login = await post('/auth/login', null, { email: fx.user.email, password: PASSWORD }, await browserBindingCookie());
    expect(await login.json()).toMatchObject({ mfaRequired: true, allowedMethods: { totp: false } });
  });

  it('8. /mfa/disable on a TOTP-primary account that holds a passkey answers 409 and changes nothing', async () => {
    const fx = await passkeyPrimaryAccount();
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    await getTestDb().update(users).set({ mfaMethod: 'totp', mfaSecret: encryptMfaSecret(secret) }).where(eq(users.id, fx.user.id));
    const before = await readUser(fx.user.id);

    await forgetUsedTotpSteps(fx.user.id);
    const res = await post('/auth/mfa/disable', await tokenFor(fx), {
      code: await generate({ secret }), currentPassword: PASSWORD,
    }, await browserBindingCookie());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'factor_removal_required' });

    const after = await readUser(fx.user.id);
    expect(after).toMatchObject({
      mfaEnabled: true, mfaMethod: 'totp', mfaSecret: before.mfaSecret, mfaEpoch: before.mfaEpoch,
    });
    expect(after.mfaRecoveryCodes).toEqual(before.mfaRecoveryCodes);
  });

  it('8b. a passkey registered after the /mfa/disable pre-check makes the write lose with 409 and changes nothing', async () => {
    const fx = await passkeyPrimaryAccount();
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    // TOTP primary with NO passkey, so the pre-check passes.
    await getTestDb().delete(userPasskeys).where(eq(userPasskeys.userId, fx.user.id));
    await getTestDb().update(users).set({ mfaMethod: 'totp', mfaSecret: encryptMfaSecret(secret) }).where(eq(users.id, fx.user.id));
    const before = await readUser(fx.user.id);
    await forgetUsedTotpSteps(fx.user.id);
    const token = await tokenFor(fx);
    const code = await generate({ secret });
    const cookie = await browserBindingCookie();

    const barrier = await userRowBarrier(fx.user.id, { noKeyUpdate: true });
    const disable = await barrier.start(() => post('/auth/mfa/disable', token, { code, currentPassword: PASSWORD }, cookie));
    // The disable is parked at its write; a passkey lands now.
    await getTestDb().insert(userPasskeys).values({
      userId: fx.user.id, credentialId: `cred-late-${randomUUID()}`, publicKey: 'dGVzdC1wdWJsaWMta2V5', counter: 0,
      deviceType: 'singleDevice', backedUp: false, name: 'late',
    });
    await barrier.release();
    const res = await disable.response;

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'factor_removal_required' });
    const after = await readUser(fx.user.id);
    expect(after).toMatchObject({ mfaEnabled: true, mfaMethod: 'totp', mfaSecret: before.mfaSecret, mfaEpoch: before.mfaEpoch });
    expect(after.mfaRecoveryCodes).toEqual(before.mfaRecoveryCodes);
    expect(await activePasskeys(fx.user.id)).toHaveLength(1);
  });

  it('9. /mfa/totp/remove on the backup: primary stays passkey, secret cleared, codes untouched, epoch bumped', async () => {
    const fx = await passkeyPrimaryAccount();
    const { res } = await addBackup(fx);
    expect(res.status).toBe(200);
    const before = await readUser(fx.user.id);

    const grant = await passkeyStepUp(fx, 'remove_totp');
    const removal = await post('/auth/mfa/totp/remove', await tokenFor(fx), {
      currentPassword: PASSWORD, stepUpGrantId: grant,
    }, await browserBindingCookie());
    expect(removal.status).toBe(200);
    expect(await removal.json()).toMatchObject({ success: true, mfaMethod: 'passkey' });

    const after = await readUser(fx.user.id);
    expect(after).toMatchObject({ mfaEnabled: true, mfaMethod: 'passkey', mfaSecret: null, mfaEpoch: before.mfaEpoch + 1 });
    expect(after.mfaRecoveryCodes).toEqual(before.mfaRecoveryCodes);
  });

  it('10. /users/me totpEnrolled follows the SQL predicate for every factor shape', async () => {
    const fx = await passkeyPrimaryAccount();
    const enc = encryptMfaSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    const shapes: Array<[string, Partial<typeof users.$inferInsert>, boolean]> = [
      ['passkey only', { mfaEnabled: true, mfaMethod: 'passkey', mfaSecret: null }, false],
      ['passkey + backup', { mfaEnabled: true, mfaMethod: 'passkey', mfaSecret: enc }, true],
      ['TOTP primary', { mfaEnabled: true, mfaMethod: 'totp', mfaSecret: enc }, true],
      ['legacy enabled row with no method', { mfaEnabled: true, mfaMethod: null, mfaSecret: enc }, true],
      ['stale secret beside SMS', { mfaEnabled: true, mfaMethod: 'sms', mfaSecret: enc }, false],
      ['stale secret with MFA off', { mfaEnabled: false, mfaMethod: null, mfaSecret: enc }, false],
    ];
    const token = await tokenFor(fx);
    for (const [label, shape, expected] of shapes) {
      await getTestDb().update(users).set(shape).where(eq(users.id, fx.user.id));
      const me = await app.request('/users/me', { headers: { Authorization: `Bearer ${token}` } });
      expect(me.status, label).toBe(200);
      const body = await me.json() as Record<string, unknown>;
      expect(body.totpEnrolled, label).toBe(expected);
      expect(body, label).not.toHaveProperty('mfaSecret');
    }
  });
});
