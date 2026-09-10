/**
 * Real PostgreSQL/Redis boundary checks for current MFA method policy at the
 * step-up grant sink. All identities and credentials are synthetic.
 */
import { generate, generateSecret } from 'otplib';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import './setup';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { organizations, partners, users } from '../../db/schema';
import { authRoutes } from '../../routes/auth';
import { encryptMfaTotpSecret } from '../../services/mfaSecretCrypto';
import { getRedis } from '../../services/redis';

async function createTotpStepUpFixture(
  totpAllowed: boolean,
  scope: 'organization' | 'partner' = 'organization',
) {
  const env = await setupTestEnvironment({ scope });
  const secret = generateSecret({ length: 20 });
  await getTestDb().update(users).set({
    mfaEnabled: true,
    mfaMethod: 'totp',
    mfaSecret: encryptMfaTotpSecret(secret),
  }).where(eq(users.id, env.user.id));
  const settings = {
    security: {
      requireMfa: true,
      allowedMethods: { totp: totpAllowed, sms: true },
    },
  };
  if (scope === 'partner') {
    await getTestDb().update(partners).set({ settings }).where(eq(partners.id, env.partner.id));
  } else {
    await getTestDb().update(organizations).set({ settings }).where(
      eq(organizations.id, env.organization.id),
    );
  }

  const app = new Hono();
  app.route('/auth', authRoutes);
  return { app, env, code: await generate({ secret }) };
}

async function postTotpStepUp(
  fixture: Awaited<ReturnType<typeof createTotpStepUpFixture>>,
) {
  return fixture.app.request('/auth/mfa/step-up', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${fixture.env.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ method: 'totp', code: fixture.code }),
  });
}

describe('MFA step-up live allowed-method policy', () => {
  it('denies a valid TOTP after tenant policy disables it and creates no grant', async () => {
    const fixture = await createTotpStepUpFixture(false);

    const response = await postTotpStepUp(fixture);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid credentials', message: 'Invalid credentials', code: 'mfa_proof_invalid' });
    await expect(getRedis()!.keys('mfa:stepup:*')).resolves.toEqual([]);
  });

  it('allows the positive control and persists the bound single-use grant', async () => {
    const fixture = await createTotpStepUpFixture(true);

    const response = await postTotpStepUp(fixture);

    expect(response.status).toBe(200);
    const body = await response.json() as { stepUpGrantId: string };
    expect(body.stepUpGrantId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(getRedis()!.get(`mfa:stepup:${body.stepUpGrantId}`)).resolves.toBeTruthy();
  });

  it('denies through a partner-scoped policy before consuming the factor', async () => {
    const fixture = await createTotpStepUpFixture(false, 'partner');

    const response = await postTotpStepUp(fixture);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid credentials', message: 'Invalid credentials', code: 'mfa_proof_invalid' });
    await expect(getRedis()!.keys('mfa:stepup:*')).resolves.toEqual([]);
  });
});
