/**
 * Deploy-key management (#8318 wave D-1) against real Postgres + Redis.
 *
 * Proven here:
 *   - mint stores only the peppered hash, creates the holding org, normalizes
 *     the source CIDRs and measures the lifetime on the database clock;
 *   - eligibility refuses before anything is created (switch, trust state,
 *     billing payment stamp and veto);
 *   - at most two active, unexpired keys per (partner, image label), label
 *     compared case-insensitively — and two concurrent mints racing for the
 *     last slot admit exactly one (counted under the holding-area lock);
 *   - mint → rotate → revoke: the successor links to the old key, which stays
 *     active; a revoked key cannot be rotated; another partner's key is not
 *     found;
 *   - revoke expires exactly the still-parked devices the key parked, in the
 *     same call, and a repeat revoke re-runs the expiry;
 *   - a real step-up grant is consumed inside the mint transaction (single use);
 *   - the routes run end to end as self-managed DB context routes.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/deployKeyManagement.integration.test.ts
 */
import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createPartner, createUser, setupTestEnvironment } from './db-utils';
import { seedHoldingOrg, seedParkedDevice } from './unassignedPoolFixtures';
import {
  devicePoolAssignmentEvents,
  devices,
  organizations,
  partnerDeployKeys,
  partners,
  refreshTokenFamilies,
} from '../../db/schema';
import {
  listDeployKeys,
  mintDeployKey,
  revokeDeployKey,
  rotateDeployKey,
  type DeployKeyActor,
  type MintDeployKeyInput,
} from '../../services/deployKeys/manage';
import { hashDeployKey, isWellFormedDeployKey } from '../../services/deployKeys/keyFormat';
import {
  deployKeyMintResourceDigest,
  deployKeyRotateResourceDigest,
  mintStepUpGrant,
  type StepUpGrantBinding,
} from '../../services/mfaStepUpGrant';
import { UNASSIGNED_POOL_ORG_TYPE } from '../../services/unassignedPool/orgType';
import { preAssignmentRoutes } from '../../routes/preAssignment';
import { createAccessToken, type TokenPayload } from '../../services/jwt';

let partnerId: string;
let actor: DeployKeyActor;

const baseKey: MintDeployKeyInput = { name: 'Front desk', imageLabel: 'win11-2026q4', expiresInDays: 30, maxUsage: 100, maxParked: 10 };

async function seedSession(userId: string): Promise<string> {
  const familyId = randomUUID();
  await getTestDb().insert(refreshTokenFamilies).values({
    familyId, userId, absoluteExpiresAt: new Date(Date.now() + 86_400_000),
  });
  return familyId;
}

async function eligiblePartner() {
  const partner = await createPartner({ status: 'active' });
  await getTestDb().update(partners).set({ deployKeyEnrollmentEnabled: true }).where(eq(partners.id, partner.id));
  return partner;
}

async function actorFor(forPartnerId: string, overrides: Record<string, unknown> = {}): Promise<DeployKeyActor> {
  const user = await createUser({ partnerId: forPartnerId, email: `keys-${randomUUID()}@example.com` });
  return {
    partnerId: forPartnerId,
    auth: {
      scope: 'partner',
      partnerId: forPartnerId,
      partnerOrgAccess: 'all',
      user: { id: user.id, email: user.email, name: 'Admin' },
      token: { aep: user.authEpoch, mep: user.mfaEpoch, sid: randomUUID() },
      ...overrides,
    } as any,
  };
}

async function holdingOrgs(forPartnerId: string) {
  return getTestDb().select({ id: organizations.id }).from(organizations)
    .where(and(eq(organizations.partnerId, forPartnerId), eq(organizations.type, UNASSIGNED_POOL_ORG_TYPE)));
}

async function storedKey(id: string) {
  const [row] = await getTestDb().select().from(partnerDeployKeys).where(eq(partnerDeployKeys.id, id));
  return row!;
}

function okOrThrow<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

beforeEach(async () => {
  const partner = await eligiblePartner();
  partnerId = partner.id;
  actor = await actorFor(partnerId);
});

describe('mint', () => {
  it('stores only the peppered hash, creates the holding org, and returns the plaintext once', async () => {
    expect(await holdingOrgs(partnerId)).toEqual([]);
    const minted = okOrThrow(await mintDeployKey({ actor, key: { ...baseKey, sourceCidrs: ['10.0.0.5/24', '10.0.0.0/24', '2001:db8::1/32'] }, stepUp: null }));
    expect(isWellFormedDeployKey(minted.plaintextKey)).toBe(true);
    expect(minted.key).not.toHaveProperty('keyHash');

    const row = await storedKey(minted.key.id);
    expect(row.keyHash).toBe(hashDeployKey(minted.plaintextKey));
    expect(row.keyHash).not.toContain(minted.plaintextKey.slice(4));
    expect(row).toMatchObject({ partnerId, status: 'active', usageCount: 0, maxUsage: 100, maxParked: 10, createdBy: actor.auth.user.id, rotatedFromId: null });
    expect(row.sourceCidrs).toEqual(['10.0.0.0/24', '2001:db8::/32']);
    // Lifetime on the database clock: exactly 30 days after created_at.
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(30 * 86_400_000);

    expect(await holdingOrgs(partnerId)).toHaveLength(1);
  });

  it('accepts the 365-day ceiling (the lifetime CHECK compares on the same clock)', async () => {
    const minted = okOrThrow(await mintDeployKey({ actor, key: { ...baseKey, expiresInDays: 365, maxUsage: 1000, maxParked: 20 }, stepUp: null }));
    const row = await storedKey(minted.key.id);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(365 * 86_400_000);
  });

  it('refuses a selected-org actor before touching anything', async () => {
    const selected = await actorFor(partnerId, { partnerOrgAccess: 'selected' });
    expect(await mintDeployKey({ actor: selected, key: baseKey, stepUp: null })).toMatchObject({ ok: false, code: 'PARTNER_WIDE_WRITE_DENIED' });
    expect(await holdingOrgs(partnerId)).toEqual([]);
  });

  describe('eligibility', () => {
    const originalBilling = process.env.BREEZE_BILLING_URL;
    const restoreBilling = () => {
      if (originalBilling === undefined) delete process.env.BREEZE_BILLING_URL;
      else process.env.BREEZE_BILLING_URL = originalBilling;
    };

    it('refuses with the partner switch off, and creates no holding org', async () => {
      await getTestDb().update(partners).set({ deployKeyEnrollmentEnabled: false }).where(eq(partners.id, partnerId));
      expect(await mintDeployKey({ actor, key: baseKey, stepUp: null }))
        .toMatchObject({ ok: false, code: 'DEPLOY_KEY_NOT_ELIGIBLE', reason: 'enrollment_switch_off' });
      expect(await holdingOrgs(partnerId)).toEqual([]);
    });

    it.each(['probation', 'restricted'] as const)('refuses a %s partner', async (trustState) => {
      await getTestDb().update(partners).set({ trustState }).where(eq(partners.id, partnerId));
      expect(await mintDeployKey({ actor, key: baseKey, stepUp: null }))
        .toMatchObject({ ok: false, code: 'DEPLOY_KEY_NOT_ELIGIBLE', reason: 'partner_not_trusted' });
    });

    it('under billing, needs the payment stamp and honours the status veto', async () => {
      try {
        process.env.BREEZE_BILLING_URL = 'https://billing.example.test';
        expect(await mintDeployKey({ actor, key: baseKey, stepUp: null }))
          .toMatchObject({ ok: false, code: 'DEPLOY_KEY_NOT_ELIGIBLE', reason: 'payment_method_missing' });
        await getTestDb().update(partners).set({ paymentMethodAttachedAt: new Date(), billingSubscriptionStatus: 'canceled' }).where(eq(partners.id, partnerId));
        expect(await mintDeployKey({ actor, key: baseKey, stepUp: null }))
          .toMatchObject({ ok: false, code: 'DEPLOY_KEY_NOT_ELIGIBLE', reason: 'billing_status_contradicts_payment' });
        await getTestDb().update(partners).set({ billingSubscriptionStatus: null }).where(eq(partners.id, partnerId));
        expect(await mintDeployKey({ actor, key: baseKey, stepUp: null })).toMatchObject({ ok: true });
      } finally {
        restoreBilling();
      }
    });

    it('self-hosted (no billing URL) skips the payment clauses', async () => {
      try {
        delete process.env.BREEZE_BILLING_URL;
        await getTestDb().update(partners).set({ paymentMethodAttachedAt: null, billingSubscriptionStatus: 'canceled' }).where(eq(partners.id, partnerId));
        expect(await mintDeployKey({ actor, key: baseKey, stepUp: null })).toMatchObject({ ok: true });
      } finally {
        restoreBilling();
      }
    });

    it('refuses an unknown partner as not found', async () => {
      const ghost = { ...actor, partnerId: randomUUID() };
      expect(await mintDeployKey({ actor: ghost, key: baseKey, stepUp: null })).toMatchObject({ ok: false, code: 'PARTNER_NOT_FOUND' });
    });
  });
});

describe('two active keys per image', () => {
  it('refuses a third active key; the label compares case-insensitively; other images are independent', async () => {
    okOrThrow(await mintDeployKey({ actor, key: baseKey, stepUp: null }));
    okOrThrow(await mintDeployKey({ actor, key: { ...baseKey, imageLabel: 'WIN11-2026Q4' }, stepUp: null }));
    const third = await mintDeployKey({ actor, key: { ...baseKey, imageLabel: 'Win11-2026Q4' }, stepUp: null });
    expect(third).toMatchObject({ ok: false, code: 'ACTIVE_KEY_LIMIT_REACHED' });
    expect(await mintDeployKey({ actor, key: { ...baseKey, imageLabel: 'kiosk' }, stepUp: null })).toMatchObject({ ok: true });
    // Another partner's keys for the same label do not count.
    const other = await eligiblePartner();
    expect(await mintDeployKey({ actor: await actorFor(other.id), key: baseKey, stepUp: null })).toMatchObject({ ok: true });
  });

  it('revoked and expired keys free their slot', async () => {
    const a = okOrThrow(await mintDeployKey({ actor, key: baseKey, stepUp: null }));
    const b = okOrThrow(await mintDeployKey({ actor, key: baseKey, stepUp: null }));
    okOrThrow(await revokeDeployKey({ actor, deployKeyId: a.key.id }));
    okOrThrow(await mintDeployKey({ actor, key: baseKey, stepUp: null }));
    expect(await mintDeployKey({ actor, key: baseKey, stepUp: null })).toMatchObject({ ok: false, code: 'ACTIVE_KEY_LIMIT_REACHED' });
    // Age b past its expiry (keeping the lifetime CHECK true).
    await getTestDb().execute(sql`
      UPDATE partner_deploy_keys SET created_at = now() - interval '40 days', expires_at = now() - interval '10 days'
       WHERE id = ${b.key.id}::uuid`);
    expect(await mintDeployKey({ actor, key: baseKey, stepUp: null })).toMatchObject({ ok: true });
  });

  it('two concurrent mints racing for the last slot admit exactly one', async () => {
    okOrThrow(await mintDeployKey({ actor, key: baseKey, stepUp: null }));
    const results = await Promise.all([
      mintDeployKey({ actor, key: baseKey, stepUp: null }),
      mintDeployKey({ actor, key: { ...baseKey, imageLabel: baseKey.imageLabel.toUpperCase() }, stepUp: null }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ ok: false, code: 'ACTIVE_KEY_LIMIT_REACHED' })]);
    const counted = await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM partner_deploy_keys
       WHERE partner_id = ${partnerId}::uuid AND status = 'active'`) as unknown as Array<{ n: number }>;
    expect(counted[0]?.n).toBe(2);
  });

  it('three concurrent first mints (holding org not yet created) admit exactly two', async () => {
    const results = await Promise.all([0, 1, 2].map(() => mintDeployKey({ actor, key: baseKey, stepUp: null })));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ code: 'ACTIVE_KEY_LIMIT_REACHED' })]);
    expect(await holdingOrgs(partnerId)).toHaveLength(1);
  });
});

describe('mint → rotate → revoke', () => {
  it('rotates into a linked successor, keeps the old key active, then revokes both', async () => {
    const first = okOrThrow(await mintDeployKey({ actor, key: { ...baseKey, sourceCidrs: ['192.168.0.0/16'] }, stepUp: null }));
    const rotated = okOrThrow(await rotateDeployKey({ actor, deployKeyId: first.key.id, key: { expiresInDays: 90, maxParked: 4 }, stepUp: null }));
    expect(rotated.plaintextKey).not.toBe(first.plaintextKey);
    expect(rotated.rotatedFrom.id).toBe(first.key.id);
    const successor = await storedKey(rotated.key.id);
    expect(successor).toMatchObject({
      rotatedFromId: first.key.id,
      imageLabel: baseKey.imageLabel,
      name: baseKey.name,
      maxUsage: baseKey.maxUsage,
      maxParked: 4,
      sourceCidrs: ['192.168.0.0/16'],
      status: 'active',
    });
    expect(successor.keyHash).toBe(hashDeployKey(rotated.plaintextKey));
    expect((await storedKey(first.key.id)).status).toBe('active');

    // Two active for the image now: a further rotation (of either) is refused.
    expect(await rotateDeployKey({ actor, deployKeyId: rotated.key.id, key: { expiresInDays: 30 }, stepUp: null }))
      .toMatchObject({ ok: false, code: 'ACTIVE_KEY_LIMIT_REACHED' });

    const revoked = okOrThrow(await revokeDeployKey({ actor, deployKeyId: first.key.id }));
    expect(revoked).toMatchObject({ alreadyRevoked: false, expiry: { matched: 0, expired: 0, skipped: 0, failed: 0 } });
    expect(await storedKey(first.key.id)).toMatchObject({ status: 'revoked', revokedBy: actor.auth.user.id });
    expect((await storedKey(first.key.id)).revokedAt).toBeInstanceOf(Date);
    expect(await rotateDeployKey({ actor, deployKeyId: first.key.id, key: { expiresInDays: 30 }, stepUp: null }))
      .toMatchObject({ ok: false, code: 'DEPLOY_KEY_REVOKED' });

    // The successor rotates again (sourceCidrs: null clears the list).
    const again = okOrThrow(await rotateDeployKey({ actor, deployKeyId: rotated.key.id, key: { expiresInDays: 30, sourceCidrs: null }, stepUp: null }));
    expect((await storedKey(again.key.id)).sourceCidrs).toBeNull();

    const listed = okOrThrow(await listDeployKeys(actor));
    expect(listed.keys.map((k) => k.id)).toEqual([again.key.id, rotated.key.id, first.key.id]);
    expect(JSON.stringify(listed.keys)).not.toMatch(/keyHash/);
    expect(listed.keys.every((k) => k.expired === false)).toBe(true);
  });

  it('another partner\'s key is not found for rotate or revoke, and never listed', async () => {
    const other = await eligiblePartner();
    const otherActor = await actorFor(other.id);
    const theirs = okOrThrow(await mintDeployKey({ actor: otherActor, key: baseKey, stepUp: null }));
    expect(await rotateDeployKey({ actor, deployKeyId: theirs.key.id, key: { expiresInDays: 30 }, stepUp: null }))
      .toMatchObject({ ok: false, code: 'DEPLOY_KEY_NOT_FOUND' });
    expect(await revokeDeployKey({ actor, deployKeyId: theirs.key.id })).toMatchObject({ ok: false, code: 'DEPLOY_KEY_NOT_FOUND' });
    expect((await storedKey(theirs.key.id)).status).toBe('active');
    expect(okOrThrow(await listDeployKeys(actor)).keys).toEqual([]);
  });
});

describe('revoke expires what the key parked', () => {
  it('expires exactly the still-parked devices the key enrolled, and a repeat revoke re-runs the expiry', async () => {
    const pool = await seedHoldingOrg(partnerId);
    const key = okOrThrow(await mintDeployKey({ actor, key: baseKey, stepUp: null }));
    const otherKey = okOrThrow(await mintDeployKey({ actor, key: { ...baseKey, imageLabel: 'kiosk' }, stepUp: null }));
    const enrolled = async (device: { id: string; agentId: string }, deployKeyId: string) => {
      await getTestDb().insert(devicePoolAssignmentEvents).values({
        partnerId, deviceId: device.id, deviceAgentId: device.agentId, eventType: 'enrolled',
        toOrgId: pool.orgId, deployKeyId, deployKeyName: baseKey.name, parkedAt: new Date(),
      });
    };
    const a = await seedParkedDevice(pool.orgId, pool.siteId);
    const b = await seedParkedDevice(pool.orgId, pool.siteId);
    const untouched = await seedParkedDevice(pool.orgId, pool.siteId);
    await enrolled(a, key.key.id);
    await enrolled(b, key.key.id);
    await enrolled(untouched, otherKey.key.id);

    const revoked = okOrThrow(await revokeDeployKey({ actor, deployKeyId: key.key.id }));
    expect(revoked.alreadyRevoked).toBe(false);
    expect(revoked.expiry).toEqual({ matched: 2, expired: 2, skipped: 0, failed: 0 });
    for (const d of [a, b]) {
      const [row] = await getTestDb().select({ status: devices.status }).from(devices).where(eq(devices.id, d.id));
      expect(row!.status).toBe('decommissioned');
      const ledger = await getTestDb().select().from(devicePoolAssignmentEvents).where(and(
        eq(devicePoolAssignmentEvents.deviceId, d.id), eq(devicePoolAssignmentEvents.eventType, 'expired')));
      expect(ledger).toEqual([expect.objectContaining({ deployKeyId: key.key.id, fromOrgId: pool.orgId })]);
    }
    const [other] = await getTestDb().select({ status: devices.status }).from(devices).where(eq(devices.id, untouched.id));
    expect(other!.status).not.toBe('decommissioned');
    expect((await storedKey(otherKey.key.id)).status).toBe('active');

    const repeat = okOrThrow(await revokeDeployKey({ actor, deployKeyId: key.key.id }));
    expect(repeat.alreadyRevoked).toBe(true);
    expect(repeat.expiry).toEqual({ matched: 2, expired: 0, skipped: 2, failed: 0 });
  });
});

describe('step-up inside the mint and rotate transactions', () => {
  it('consumes a real grant once; a replay is refused and writes nothing', async () => {
    const sid = await seedSession(actor.auth.user.id);
    const auth = { ...actor.auth, token: { ...actor.auth.token, sid } } as any;
    const withSession: DeployKeyActor = { auth, partnerId };
    const binding: StepUpGrantBinding = {
      userId: auth.user.id, operation: 'deploy_key_mint', authEpoch: auth.token.aep, mfaEpoch: auth.token.mep,
      sid, resourceDigest: deployKeyMintResourceDigest({ partnerId, imageLabel: baseKey.imageLabel }),
    };
    const grantId = (await mintStepUpGrant(binding))!;
    okOrThrow(await mintDeployKey({ actor: withSession, key: baseKey, stepUp: { grantId, binding } }));
    expect(await mintDeployKey({ actor: withSession, key: baseKey, stepUp: { grantId, binding } }))
      .toMatchObject({ ok: false, code: 'STEP_UP_REQUIRED' });
    expect(okOrThrow(await listDeployKeys(actor)).keys).toHaveLength(1);
  });

  it('a revoked session refuses the rotate grant', async () => {
    const sid = await seedSession(actor.auth.user.id);
    const auth = { ...actor.auth, token: { ...actor.auth.token, sid } } as any;
    const withSession: DeployKeyActor = { auth, partnerId };
    const first = okOrThrow(await mintDeployKey({ actor: withSession, key: baseKey, stepUp: null }));
    const binding: StepUpGrantBinding = {
      userId: auth.user.id, operation: 'deploy_key_rotate', authEpoch: auth.token.aep, mfaEpoch: auth.token.mep,
      sid, resourceDigest: deployKeyRotateResourceDigest({ partnerId, deployKeyId: first.key.id }),
    };
    const grantId = (await mintStepUpGrant(binding))!;
    await getTestDb().update(refreshTokenFamilies).set({ revokedAt: new Date(), revokedReason: 'logout' })
      .where(eq(refreshTokenFamilies.familyId, sid));
    expect(await rotateDeployKey({ actor: withSession, deployKeyId: first.key.id, key: { expiresInDays: 30 }, stepUp: { grantId, binding } }))
      .toMatchObject({ ok: false, code: 'STEP_UP_REQUIRED' });
    expect(okOrThrow(await listDeployKeys(actor)).keys).toHaveLength(1);
  });
});

describe('HTTP routes — self-managed DB context, end to end', () => {
  it('lists, mints, rotates and revokes through the real routes with real step-up grants', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    await getTestDb().update(partners).set({ deployKeyEnrollmentEnabled: true }).where(eq(partners.id, env.partner.id));
    const sid = await seedSession(env.user.id);
    const payload: Omit<TokenPayload, 'type'> = {
      sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: null,
      partnerId: env.partner.id, scope: 'partner', mfa: true, aep: 1, mep: 1, sid,
    };
    const token = await createAccessToken(payload);
    const app = new Hono();
    app.route('/api/v1/pre-assignment', preAssignmentRoutes);
    const call = (method: string, path: string, body?: unknown) => app.request(`/api/v1/pre-assignment${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const grant = async (operation: 'deploy_key_mint' | 'deploy_key_rotate', resourceDigest: string) =>
      (await mintStepUpGrant({ userId: env.user.id, operation, authEpoch: 1, mfaEpoch: 1, sid, resourceDigest }))!;

    const empty = await call('GET', '/deploy-keys');
    expect(empty.status, await empty.clone().text()).toBe(200);
    expect(await empty.json()).toEqual({ deployKeys: [] });

    const noGrant = await call('POST', '/deploy-keys', { ...baseKey });
    expect(noGrant.status).toBe(403);

    const mint = await call('POST', '/deploy-keys', {
      ...baseKey,
      stepUpGrant: await grant('deploy_key_mint', deployKeyMintResourceDigest({ partnerId: env.partner.id, imageLabel: baseKey.imageLabel })),
    });
    expect(mint.status, await mint.clone().text()).toBe(201);
    const minted = await mint.json() as { deployKey: { id: string }; key: string };
    expect(isWellFormedDeployKey(minted.key)).toBe(true);

    const rotate = await call('POST', `/deploy-keys/${minted.deployKey.id}/rotate`, {
      expiresInDays: 60,
      stepUpGrant: await grant('deploy_key_rotate', deployKeyRotateResourceDigest({ partnerId: env.partner.id, deployKeyId: minted.deployKey.id })),
    });
    expect(rotate.status, await rotate.clone().text()).toBe(201);
    const rotated = await rotate.json() as { deployKey: { id: string; rotatedFromId: string } };
    expect(rotated.deployKey.rotatedFromId).toBe(minted.deployKey.id);

    const revoke = await call('POST', `/deploy-keys/${minted.deployKey.id}/revoke`);
    expect(revoke.status, await revoke.clone().text()).toBe(200);
    expect(await revoke.json()).toMatchObject({ alreadyRevoked: false, deployKey: { status: 'revoked' }, expiry: { matched: 0 } });

    const list = await call('GET', '/deploy-keys');
    const listed = (await list.json() as { deployKeys: Array<{ id: string; status: string }> }).deployKeys;
    expect(listed.map((k) => [k.id, k.status])).toEqual([[rotated.deployKey.id, 'active'], [minted.deployKey.id, 'revoked']]);
    expect(JSON.stringify(listed)).not.toMatch(/keyHash|bdk_/);
  });
});
