/**
 * Wisp W08 Task 6 (#9914; w00 A35, Review Focus 5) — the partner enable
 * switch against real Postgres: off pauses the partner's active grants with
 * 'partner_disabled' and leaves a user pause alone; on resumes only
 * 'partner_disabled'; another partner is untouched; a missing settings row
 * reads as enabled.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { wispGrants, wispPartnerNudgeSettings } from '../../db/schema';
import { getPartnerSettings, reconcilePartnerDisabled } from '../../services/wisp/partnerSettings';
import { createPartner, createUser } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const asSystem = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

beforeEach(() => vi.stubEnv('BREEZE_WISP_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());

async function grant(partnerId: string, userId: string, status: 'active' | 'paused', pausedReason: string | null = null) {
  return asSystem(async () => {
    const [g] = await db.insert(wispGrants).values({
      partnerId, orgId: null, grantorUserId: userId, status, pausedReason,
      pausedAt: status === 'paused' ? new Date() : null,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    } as typeof wispGrants.$inferInsert).returning({ id: wispGrants.id });
    return g!.id;
  });
}

const setEnabled = (partnerId: string, enabled: boolean) => asSystem(() => db.insert(wispPartnerNudgeSettings)
  .values({ partnerId, enabled })
  .onConflictDoUpdate({ target: wispPartnerNudgeSettings.partnerId, set: { enabled } }));

const states = async (ids: string[]) => {
  const rows = await asSystem(() => db.select({ id: wispGrants.id, status: wispGrants.status, reason: wispGrants.pausedReason })
    .from(wispGrants).where(inArray(wispGrants.id, ids)));
  return Object.fromEntries(rows.map((r) => [r.id, `${r.status}:${r.reason ?? '-'}`]));
};

describe('partner enable switch (real Postgres)', () => {
  it('a missing settings row reads as enabled', async () => {
    const p = await createPartner();
    expect((await asSystem(() => getPartnerSettings(p.id))).enabled).toBe(true);
  });

  it('off pauses active grants with partner_disabled and skips user_paused; on resumes only partner_disabled', async () => {
    const p = await createPartner();
    const other = await createPartner();
    // One live grant per (grantor, scope): a user each.
    const user = () => createUser({ partnerId: p.id, email: `wisp-switch-${randomUUID()}@wisp.test` });
    const [u1, u2, u3] = [await user(), await user(), await user()];
    const uo = await createUser({ partnerId: other.id, email: `wisp-switch-o-${randomUUID()}@wisp.test` });
    const active = await grant(p.id, u1.id, 'active');
    const userPaused = await grant(p.id, u2.id, 'paused', 'user_paused');
    const entitlementLost = await grant(p.id, u3.id, 'paused', 'entitlement_lost');
    const otherActive = await grant(other.id, uo.id, 'active');

    await setEnabled(p.id, false);
    expect(await reconcilePartnerDisabled(p.id)).toEqual({ paused: 1, resumed: 0 });
    expect(await states([active, userPaused, entitlementLost, otherActive])).toEqual({
      [active]: 'paused:partner_disabled',
      [userPaused]: 'paused:user_paused',
      [entitlementLost]: 'paused:entitlement_lost',
      [otherActive]: 'active:-',
    });
    // Idempotent: a second pass does nothing.
    expect(await reconcilePartnerDisabled(p.id)).toEqual({ paused: 0, resumed: 0 });

    await setEnabled(p.id, true);
    expect(await reconcilePartnerDisabled(p.id)).toEqual({ paused: 0, resumed: 1 });
    expect(await states([active, userPaused, entitlementLost])).toEqual({
      [active]: 'active:-',
      [userPaused]: 'paused:user_paused',
      [entitlementLost]: 'paused:entitlement_lost',
    });
    await asSystem(() => db.delete(wispGrants).where(eq(wispGrants.partnerId, p.id)));
  });
});
