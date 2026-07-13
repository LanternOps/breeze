import { afterAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, gte, sql } from 'drizzle-orm';
import './setup';
import { getTestDb } from './setup';
import { assignUserToPartner, createPartner, createRole, createUser } from './db-utils';
import { authRoutes } from '../../routes/auth';
import { hashRecoveryCode } from '../../routes/auth/helpers';
import { createPendingMfa } from '../../services/mfaAssurance';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';
import { closeRedis, getRedis } from '../../services/redis';
import { verifyToken } from '../../services/jwt';
import * as userSessionService from '../../services/userSession';
import { auditLogs, refreshTokenFamilies, users } from '../../db/schema';
import { createMfaBrowserTransitionFixture } from './mfa-browser-transition-fixture';

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
    const transition = await createMfaBrowserTransitionFixture();
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
      allowedMethods: new Set<'totp' | 'sms' | 'passkey' | 'recovery_code'>([
        'totp', 'sms', 'passkey', 'recovery_code',
      ]),
      enrolledMethods: new Set<'totp' | 'recovery_code'>(['totp', 'recovery_code']),
      primaryAuthenticationMethod: 'password',
      configuredMfaMethod: 'totp',
      primaryMfaMethod: 'totp',
      browserTransitionId: transition.browserTransitionId,
      browserGeneration: transition.browserGeneration,
    });
    const app = new Hono().route('/auth', authRoutes);
    const submit = () => app.request('/auth/mfa/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: transition.cookieHeader },
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
    const firstTransition = await createMfaBrowserTransitionFixture();
    const secondTransition = await createMfaBrowserTransitionFixture();
    const pendingInput = (transition: Awaited<ReturnType<typeof createMfaBrowserTransitionFixture>>) => ({
      userId: user.id, authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch,
      expectedStatus: 'active' as const, roleId: role.id, orgId: null, partnerId: partner.id,
      scope: 'partner' as const, policyRequired: false, policySources: [] as const,
      allowedMethods: new Set(['totp', 'sms', 'passkey', 'recovery_code'] as const),
      enrolledMethods: new Set(['totp', 'recovery_code'] as const),
      primaryAuthenticationMethod: 'password' as const, configuredMfaMethod: 'totp' as const,
      primaryMfaMethod: 'totp' as const,
      browserTransitionId: transition.browserTransitionId,
      browserGeneration: transition.browserGeneration,
    });
    const [firstToken, secondToken] = await Promise.all([
      createPendingMfa(pendingInput(firstTransition)), createPendingMfa(pendingInput(secondTransition)),
    ]);
    const app = new Hono().route('/auth', authRoutes);
    const submit = (tempToken: string, cookieHeader: string) => app.request('/auth/mfa/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ tempToken, method: 'recovery_code', code }),
    });

    const responses = await Promise.all([
      submit(firstToken, firstTransition.cookieHeader),
      submit(secondToken, secondTransition.cookieHeader),
    ]);

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
    const malformedTransition = await createMfaBrowserTransitionFixture();
    const wrongTransition = await createMfaBrowserTransitionFixture();
    const successTransition = await createMfaBrowserTransitionFixture();
    const pendingInput = (transition: Awaited<ReturnType<typeof createMfaBrowserTransitionFixture>>) => ({
      userId: user.id, authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch,
      expectedStatus: 'active', roleId: role.id, orgId: null, partnerId: partner.id,
      scope: 'partner', policyRequired: false, policySources: [],
      allowedMethods: new Set<'totp' | 'sms' | 'passkey' | 'recovery_code'>([
        'totp', 'sms', 'passkey', 'recovery_code',
      ]),
      enrolledMethods: new Set<'totp' | 'recovery_code'>(['totp', 'recovery_code']),
      primaryAuthenticationMethod: 'password', configuredMfaMethod: 'totp', primaryMfaMethod: 'totp',
      browserTransitionId: transition.browserTransitionId,
      browserGeneration: transition.browserGeneration,
    } as const);
    const [malformedToken, wrongToken, successToken] = await Promise.all([
      createPendingMfa(pendingInput(malformedTransition)),
      createPendingMfa(pendingInput(wrongTransition)),
      createPendingMfa(pendingInput(successTransition)),
    ]);
    const auditWindowStart = new Date();
    const app = new Hono().route('/auth', authRoutes);
    const malformed = await app.request('/auth/mfa/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: malformedTransition.cookieHeader },
      body: JSON.stringify({ tempToken: malformedToken, method: 'recovery_code' }),
    });
    expect(malformed.status).toBe(401);
    expect(await getRedis()!.exists(`mfa:pending:${malformedToken}`)).toBe(0);
    const malformedRetry = await app.request('/auth/mfa/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: malformedTransition.cookieHeader },
      body: JSON.stringify({ tempToken: malformedToken, method: 'recovery_code', code }),
    });
    expect(malformedRetry.status).toBe(401);
    const wrongCode = 'NOPE-0000';
    const wrong = await app.request('/auth/mfa/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: wrongTransition.cookieHeader },
      body: JSON.stringify({ tempToken: wrongToken, method: 'recovery_code', code: wrongCode }),
    });
    expect(wrong.status).toBe(401);
    const success = await app.request('/auth/mfa/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: successTransition.cookieHeader },
      body: JSON.stringify({ tempToken: successToken, method: 'recovery_code', code }),
    });
    expect(success.status).toBe(200);
    const replay = await app.request('/auth/mfa/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: successTransition.cookieHeader },
      body: JSON.stringify({ tempToken: successToken, method: 'recovery_code', code }),
    });
    expect(replay.status).toBe(401);
    const [afterUser] = await tdb.select().from(users).where(eq(users.id, user.id));
    expect(afterUser?.mfaRecoveryCodes).toEqual([]);
    let failureAudits: Array<typeof auditLogs.$inferSelect> = [];
    for (let attempt = 0; attempt < 100 && failureAudits.length < 4; attempt += 1) {
      failureAudits = await tdb.select().from(auditLogs)
        .where(and(
          eq(auditLogs.action, 'user.login.failed'),
          gte(auditLogs.timestamp, auditWindowStart),
        ));
      if (failureAudits.length < 4) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(failureAudits).toHaveLength(4);
    expect(failureAudits.map((audit) => (audit.details as any)?.reason).sort()).toEqual([
      'mfa_invalid_recovery_code', 'mfa_invalid_recovery_code',
      'mfa_invalid_recovery_code', 'mfa_malformed_recovery_code',
    ]);
    expect(failureAudits.every((audit) => (audit.details as any)?.method === 'recovery_code')).toBe(true);
    const auditJson = JSON.stringify(failureAudits);
    expect(auditJson).not.toContain(code);
    expect(auditJson).not.toContain(wrongCode);
    expect(auditJson).not.toContain(hashRecoveryCode(code));
  });

  it('revokes the newly owned family when post-commit binding fails', async () => {
    const tdb = getTestDb();
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const created = await createUser({ partnerId: partner.id, mfaEnabled: true });
    await assignUserToPartner(created.id, partner.id, role.id, 'all');
    const code = 'BIND-FAIL';
    const [user] = await tdb.update(users).set({
      mfaMethod: 'totp', mfaSecret: 'integration-encrypted-secret',
      mfaRecoveryCodes: [hashRecoveryCode(code)],
    }).where(eq(users.id, created.id)).returning();
    if (!user) throw new Error('Failed to seed bind-failure user');
    const oldFamilyId = await tdb.transaction((tx) => mintRefreshTokenFamily(user.id, { tx }));
    const transition = await createMfaBrowserTransitionFixture();
    const tempToken = await createPendingMfa({
      userId: user.id, authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch,
      expectedStatus: 'active', roleId: role.id, orgId: null, partnerId: partner.id,
      scope: 'partner', policyRequired: false, policySources: [],
      allowedMethods: new Set(['totp', 'sms', 'passkey', 'recovery_code']),
      enrolledMethods: new Set(['totp', 'recovery_code']),
      primaryAuthenticationMethod: 'password', configuredMfaMethod: 'totp', primaryMfaMethod: 'totp',
      browserTransitionId: transition.browserTransitionId,
      browserGeneration: transition.browserGeneration,
    });
    const bindFault = vi.spyOn(userSessionService, 'bindIssuedUserSession')
      .mockRejectedValueOnce(new Error('injected bind failure'));
    let response: Response;
    try {
      response = await new Hono().route('/auth', authRoutes).request('/auth/mfa/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: transition.cookieHeader },
        body: JSON.stringify({ tempToken, method: 'recovery_code', code }),
      });
    } finally {
      bindFault.mockRestore();
    }
    expect(response!.status).toBe(503);
    expect(response!.headers.get('set-cookie')).toBeNull();
    expect(await response!.json()).not.toHaveProperty('tokens');
    const families = await tdb.select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, user.id));
    expect(families).toHaveLength(2);
    expect(families.find((family) => family.familyId === oldFamilyId)?.revokedAt).not.toBeNull();
    const replacement = families.find((family) => family.familyId !== oldFamilyId);
    expect(replacement?.userId).toBe(user.id);
    expect(replacement?.revokedAt).not.toBeNull();
    const audits = await tdb.select().from(auditLogs).where(and(
      eq(auditLogs.action, 'user.login'),
      eq(auditLogs.actorId, user.id),
    ));
    expect(audits).toEqual([]);
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
    const transition = await createMfaBrowserTransitionFixture();
    const tempToken = await createPendingMfa({
      userId: user.id, authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch,
      expectedStatus: 'active', roleId: role.id, orgId: null, partnerId: partner.id,
      scope: 'partner', policyRequired: false, policySources: [],
      allowedMethods: new Set(['totp', 'sms', 'passkey', 'recovery_code']),
      enrolledMethods: new Set(['totp', 'recovery_code']),
      primaryAuthenticationMethod: 'password', configuredMfaMethod: 'totp',
      primaryMfaMethod: 'totp',
      browserTransitionId: transition.browserTransitionId,
      browserGeneration: transition.browserGeneration,
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
        headers: { 'Content-Type': 'application/json', Cookie: transition.cookieHeader },
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
