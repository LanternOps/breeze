import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import './setup';
import { getTestDb } from './setup';
import { assignUserToPartner, createPartner, createRole, createUser } from './db-utils';
import { authRoutes } from '../../routes/auth';
import { hashRecoveryCode } from '../../routes/auth/helpers';
import { createPendingMfa } from '../../services/mfaAssurance';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';
import { closeRedis, getRedis } from '../../services/redis';
import { verifyToken } from '../../services/jwt';
import { auditLogs, refreshTokenFamilies, users } from '../../db/schema';

describe('single-use recovery-code login against real PostgreSQL and Redis', () => {
  afterAll(async () => {
    await closeRedis();
  });

  it('allows exactly one concurrent token response and removes exactly one stored hash', async () => {
    const tdb = getTestDb();
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const created = await createUser({ partnerId: partner.id, mfaEnabled: true });
    await assignUserToPartner(created.id, partner.id, role.id, 'all');
    const usedCode = 'ABCD-EF12';
    const otherCode = 'WXYZ-9876';
    const [user] = await tdb.update(users).set({
      mfaMethod: 'totp',
      mfaSecret: 'integration-encrypted-secret',
      mfaRecoveryCodes: [hashRecoveryCode(usedCode), hashRecoveryCode(otherCode)],
    }).where(eq(users.id, created.id)).returning();
    if (!user) throw new Error('Failed to seed recovery-code user');
    const oldFamilyId = await tdb.transaction((tx) => mintRefreshTokenFamily(user.id, { tx }));
    const tempToken = await createPendingMfa({
      userId: user.id,
      authEpoch: user.authEpoch,
      mfaEpoch: user.mfaEpoch,
      expectedStatus: 'active',
      roleId: role.id,
      orgId: null,
      partnerId: partner.id,
      scope: 'partner',
      policyRequired: false,
      policySources: [],
      allowedMethods: new Set(['totp', 'sms', 'passkey', 'recovery_code']),
      enrolledMethods: new Set(['totp', 'recovery_code']),
      primaryAuthenticationMethod: 'password',
      configuredMfaMethod: 'totp',
      primaryMfaMethod: 'totp',
    });
    const app = new Hono().route('/auth', authRoutes);
    const submit = () => app.request('/auth/mfa/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempToken, method: 'recovery_code', code: usedCode }),
    });

    const responses = await Promise.all([submit(), submit()]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    const winner = responses.find((response) => response.status === 200)!;
    const body = await winner.json() as { tokens: { accessToken: string } };
    const access = await verifyToken(body.tokens.accessToken);
    expect(access?.amr).toEqual(['password', 'recovery_code']);
    expect(responses.filter((response) => response.headers.has('set-cookie'))).toHaveLength(1);

    const [afterUser] = await tdb.select().from(users).where(eq(users.id, user.id));
    expect(afterUser?.mfaRecoveryCodes).toEqual([hashRecoveryCode(otherCode)]);
    expect(afterUser?.mfaEpoch).toBe(user.mfaEpoch + 1);
    const [oldFamily] = await tdb.select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, oldFamilyId));
    expect(oldFamily?.userId).toBe(user.id);
    expect(oldFamily?.revokedAt).not.toBeNull();
  });

  it('serializes two distinct pending tokens racing the same user and code', async () => {
    const tdb = getTestDb();
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const created = await createUser({ partnerId: partner.id, mfaEnabled: true });
    await assignUserToPartner(created.id, partner.id, role.id, 'all');
    const code = 'RACE-CODE';
    const [user] = await tdb.update(users).set({
      mfaMethod: 'totp', mfaSecret: 'integration-encrypted-secret',
      mfaRecoveryCodes: [hashRecoveryCode(code)],
    }).where(eq(users.id, created.id)).returning();
    if (!user) throw new Error('Failed to seed distinct-token race user');
    const oldFamilyId = await tdb.transaction((tx) => mintRefreshTokenFamily(user.id, { tx }));
    const pendingInput = {
      userId: user.id, authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch,
      expectedStatus: 'active' as const, roleId: role.id, orgId: null, partnerId: partner.id,
      scope: 'partner' as const, policyRequired: false, policySources: [] as const,
      allowedMethods: new Set(['totp', 'sms', 'passkey', 'recovery_code'] as const),
      enrolledMethods: new Set(['totp', 'recovery_code'] as const),
      primaryAuthenticationMethod: 'password' as const, configuredMfaMethod: 'totp' as const,
      primaryMfaMethod: 'totp' as const,
    };
    const [firstToken, secondToken] = await Promise.all([
      createPendingMfa(pendingInput), createPendingMfa(pendingInput),
    ]);
    const app = new Hono().route('/auth', authRoutes);
    const submit = (tempToken: string) => app.request('/auth/mfa/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempToken, method: 'recovery_code', code }),
    });

    const responses = await Promise.all([submit(firstToken), submit(secondToken)]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(responses.filter((response) => response.headers.has('set-cookie'))).toHaveLength(1);
    const [afterUser] = await tdb.select().from(users).where(eq(users.id, user.id));
    expect(afterUser?.mfaRecoveryCodes).toEqual([]);
    expect(afterUser?.mfaEpoch).toBe(user.mfaEpoch + 1);
    const families = await tdb.select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, user.id));
    expect(families.every((family) => family.userId === user.id)).toBe(true);
    expect(families.find((family) => family.familyId === oldFamilyId)?.revokedAt).not.toBeNull();
    expect(families.filter((family) => family.revokedAt === null)).toHaveLength(1);
  });

  it('burns an identifiable pending record before rejecting malformed input and audits redacted data', async () => {
    const tdb = getTestDb();
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const created = await createUser({ partnerId: partner.id, mfaEnabled: true });
    await assignUserToPartner(created.id, partner.id, role.id, 'all');
    const code = 'BURN-CODE';
    const [user] = await tdb.update(users).set({
      mfaMethod: 'totp', mfaSecret: 'integration-encrypted-secret',
      mfaRecoveryCodes: [hashRecoveryCode(code)],
    }).where(eq(users.id, created.id)).returning();
    if (!user) throw new Error('Failed to seed malformed recovery user');
    const tempToken = await createPendingMfa({
      userId: user.id, authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch,
      expectedStatus: 'active', roleId: role.id, orgId: null, partnerId: partner.id,
      scope: 'partner', policyRequired: false, policySources: [],
      allowedMethods: new Set(['totp', 'sms', 'passkey', 'recovery_code']),
      enrolledMethods: new Set(['totp', 'recovery_code']),
      primaryAuthenticationMethod: 'password', configuredMfaMethod: 'totp', primaryMfaMethod: 'totp',
    });
    const app = new Hono().route('/auth', authRoutes);
    const malformed = await app.request('/auth/mfa/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempToken, method: 'recovery_code' }),
    });
    expect(malformed.status).toBe(401);
    expect(await getRedis()!.exists(`mfa:pending:${tempToken}`)).toBe(0);
    const retry = await app.request('/auth/mfa/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempToken, method: 'recovery_code', code }),
    });
    expect(retry.status).toBe(401);
    const [afterUser] = await tdb.select().from(users).where(eq(users.id, user.id));
    expect(afterUser?.mfaRecoveryCodes).toEqual([hashRecoveryCode(code)]);
    let audit: typeof auditLogs.$inferSelect | undefined;
    for (let attempt = 0; attempt < 100 && !audit; attempt += 1) {
      [audit] = await tdb.select().from(auditLogs).where(eq(auditLogs.actorId, user.id));
      if (!audit) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(audit?.action).toBe('user.login.failed');
    expect(audit?.details).toMatchObject({
      method: 'recovery_code', reason: 'mfa_malformed_recovery_code',
    });
    expect(JSON.stringify(audit)).not.toContain(code);
    expect(JSON.stringify(audit)).not.toContain(hashRecoveryCode(code));
  });

  it('burns pending state and issues no token when the durable mutation rolls back', async () => {
    const tdb = getTestDb();
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const created = await createUser({ partnerId: partner.id, mfaEnabled: true });
    await assignUserToPartner(created.id, partner.id, role.id, 'all');
    const code = 'ROLL-BACK';
    const [user] = await tdb.update(users).set({
      mfaMethod: 'totp',
      mfaSecret: 'integration-encrypted-secret',
      mfaRecoveryCodes: [hashRecoveryCode(code)],
    }).where(eq(users.id, created.id)).returning();
    if (!user) throw new Error('Failed to seed rollback user');
    const familyId = await tdb.transaction((tx) => mintRefreshTokenFamily(user.id, { tx }));
    const tempToken = await createPendingMfa({
      userId: user.id, authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch,
      expectedStatus: 'active', roleId: role.id, orgId: null, partnerId: partner.id,
      scope: 'partner', policyRequired: false, policySources: [],
      allowedMethods: new Set(['totp', 'sms', 'passkey', 'recovery_code']),
      enrolledMethods: new Set(['totp', 'recovery_code']),
      primaryAuthenticationMethod: 'password', configuredMfaMethod: 'totp',
      primaryMfaMethod: 'totp',
    });
    await tdb.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION fail_recovery_epoch_update() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${user.id}'::uuid THEN
          RAISE EXCEPTION 'inject recovery rollback';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `));
    await tdb.execute(sql.raw(`
      CREATE TRIGGER fail_recovery_epoch_update_trigger
        BEFORE UPDATE OF mfa_epoch ON users
        FOR EACH ROW EXECUTE FUNCTION fail_recovery_epoch_update();
    `));
    let response: Response;
    try {
      const app = new Hono().route('/auth', authRoutes);
      response = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempToken, method: 'recovery_code', code }),
      });
    } finally {
      await tdb.execute(sql.raw('DROP TRIGGER IF EXISTS fail_recovery_epoch_update_trigger ON users'));
      await tdb.execute(sql.raw('DROP FUNCTION IF EXISTS fail_recovery_epoch_update()'));
    }

    expect(response!.status).toBe(503);
    const responseBody = await response!.json() as Record<string, unknown>;
    expect(responseBody).not.toHaveProperty('tokens');
    expect(response!.headers.get('set-cookie')).toBeNull();
    const redis = getRedis();
    expect(redis).not.toBeNull();
    expect(await redis!.exists(`mfa:pending:${tempToken}`)).toBe(0);

    const [afterUser] = await tdb.select().from(users).where(eq(users.id, user.id));
    const [afterFamily] = await tdb.select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, familyId));
    expect(afterUser?.mfaRecoveryCodes).toEqual([hashRecoveryCode(code)]);
    expect(afterUser?.mfaEpoch).toBe(user.mfaEpoch);
    expect(afterFamily?.userId).toBe(user.id);
    expect(afterFamily?.revokedAt).toBeNull();
  });
});
