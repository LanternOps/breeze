import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { organizations, partners, users, userPasskeys, partnerUsers } from '../../db/schema';
import { setOrganizationSoftwareDownloadPolicy } from '../../services/softwareDownloadPolicy';
import { removeOrgFromPartnerOrder } from '../../services/orgOrdering';
import { setRiskProfile } from '../../modules/mcpInvites/tools/configureDefaults';
import { countMfaPolicyLockouts, lockMfaPolicySettings } from '../../services/mfaPolicyActivation';
import { createOrganization, createPartner, createUser, createRole, assignUserToOrganization } from './db-utils';
import { getTestDb } from './setup';

const denyTotp = { security: { allowedMethods: { totp: false } } };
const denySms = { security: { allowedMethods: { sms: false } } };
const denyBoth = { security: { allowedMethods: { totp: false, sms: false } } };

type Inventory = 'totp' | 'sms' | 'mixed' | 'passkey' | 'disabled-passkey' | 'none' | 'recovery';
async function fixture(inventory: Inventory, orgMember = false) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: orgMember ? org.id : null,
    withMembership: true, mfaEnabled: inventory !== 'none', email: `${randomUUID()}@example.com` });
  await getTestDb().update(users).set({
    mfaSecret: ['totp', 'mixed', 'disabled-passkey', 'recovery'].includes(inventory) ? 'fixture-secret' : null,
    mfaMethod: ['sms', 'mixed'].includes(inventory) ? 'sms' : inventory === 'passkey' ? 'passkey' : 'totp',
    phoneNumber: ['sms', 'mixed'].includes(inventory) ? '+12025550100' : null,
    mfaRecoveryCodes: inventory === 'recovery' ? ['fixture-recovery-hash'] : [],
  }).where(eq(users.id, user.id));
  if (['passkey', 'disabled-passkey'].includes(inventory)) {
    await getTestDb().insert(userPasskeys).values({ userId: user.id,
      credentialId: randomUUID(), publicKey: 'Zml4dHVyZQ==', counter: 0,
      deviceType: 'singleDevice', backedUp: false, name: 'Fixture',
      disabledAt: inventory === 'disabled-passkey' ? new Date() : null });
  }
  return { partner, org, user };
}

describe('MFA settings activation against real PostgreSQL and breeze_app', () => {
  it.each([
    ['totp', denyTotp, 1], ['totp', denySms, 0],
    ['sms', denySms, 1], ['sms', denyTotp, 0],
    ['mixed', denyTotp, 0], ['mixed', denyBoth, 1],
    ['passkey', denyBoth, 0], ['disabled-passkey', denyBoth, 1],
    ['none', denyBoth, 0], ['recovery', denyTotp, 1],
  ] as const)('%s inventory with %j counts %i newly stranded partner users', async (inventory, next, expected) => {
    const { partner } = await fixture(inventory);
    expect(await countMfaPolicyLockouts({ kind: 'partner', id: partner.id }, next)).toBe(expected);
  });

  it('counts inherited org restrictions through ambient user RLS without leaking another partner', async () => {
    const own = await fixture('totp', true);
    await fixture('totp', true);
    await fixture('totp');
    const actor = await createUser({ partnerId: own.partner.id, orgId: own.org.id, withMembership: true,
      email: `${randomUUID()}@example.com` });
    const result = await withDbAccessContext({ scope: 'organization', orgId: own.org.id,
      accessibleOrgIds: [own.org.id], accessiblePartnerIds: [], userId: actor.id }, () =>
      countMfaPolicyLockouts({ kind: 'partner', id: own.partner.id }, denyTotp));
    expect(result).toBe(1);
  });

  it('org changes use the partner allowedMethods as one locked field', async () => {
    const { partner, org } = await fixture('totp', true);
    await getTestDb().update(partners).set({ settings: { security: { allowedMethods: { sms: false } } } })
      .where(eq(partners.id, partner.id));
    expect(await countMfaPolicyLockouts({ kind: 'organization', id: org.id }, denyBoth)).toBe(0);
  });

  it('removing partner override detects newly exposed org restrictions', async () => {
    const { partner, org } = await fixture('totp', true);
    await getTestDb().update(partners).set({ settings: { security: { allowedMethods: { totp: true } } } })
      .where(eq(partners.id, partner.id));
    await getTestDb().update(organizations).set({ settings: denyTotp }).where(eq(organizations.id, org.id));
    expect(await countMfaPolicyLockouts({ kind: 'partner', id: partner.id }, {})).toBe(1);
  });

  it('unchanged broken policy does not block unrelated changes or repair', async () => {
    const { partner } = await fixture('totp');
    await getTestDb().update(partners).set({ settings: denyTotp }).where(eq(partners.id, partner.id));
    expect(await countMfaPolicyLockouts({ kind: 'partner', id: partner.id }, { ...denyTotp, timezone: 'UTC' })).toBe(0);
    expect(await countMfaPolicyLockouts({ kind: 'partner', id: partner.id }, {})).toBe(0);
  });

  it('org scope excludes sibling and partner memberships', async () => {
    const { partner, org } = await fixture('totp');
    const sibling = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: sibling.id, withMembership: true,
      mfaEnabled: true, email: `${randomUUID()}@example.com` });
    await getTestDb().update(users).set({ mfaSecret: 'fixture', mfaMethod: 'totp' }).where(eq(users.id, user.id));
    expect(await countMfaPolicyLockouts({ kind: 'organization', id: org.id }, denyBoth)).toBe(0);
  });

  it('fresh partner and organization have no enrolled inventory to strand', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    expect(await countMfaPolicyLockouts({ kind: 'partner', id: partner.id }, denyBoth)).toBe(0);
    expect(await countMfaPolicyLockouts({ kind: 'organization', id: org.id }, denyBoth)).toBe(0);
  });

  it('counts a user with partner and organization memberships once', async () => {
    const { partner, org, user } = await fixture('totp');
    const role = await createRole({ scope: 'organization', partnerId: partner.id, orgId: org.id });
    await assignUserToOrganization(user.id, org.id, role.id);
    expect(await countMfaPolicyLockouts({ kind: 'partner', id: partner.id }, denyTotp)).toBe(1);
  });

  it('caps affected counts at 1000 without returning identities', async () => {
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const inserted = await getTestDb().insert(users).values(Array.from({ length: 1001 }, () => ({
      partnerId: partner.id, email: `${randomUUID()}@example.com`, name: 'Fixture',
      status: 'active' as const, mfaEnabled: true, mfaSecret: 'fixture', mfaMethod: 'totp' as const,
    }))).returning({ id: users.id });
    await getTestDb().insert(partnerUsers).values(inserted.map((user) => ({
      partnerId: partner.id, userId: user.id, roleId: role.id,
    })));
    expect(await countMfaPolicyLockouts({ kind: 'partner', id: partner.id }, denyTotp)).toBe(1000);
  });

  it('runs with the unprivileged application role', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute<{ current_user: string; rolbypassrls: boolean }>(sql`
      SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    expect(rows[0]).toMatchObject({ current_user: 'breeze_app', rolbypassrls: false });
  });

  it.each(['order cleanup', 'risk profile'] as const)('%s preserves policy committed by a concurrent writer', async (writer) => {
    const partner = await createPartner();
    await getTestDb().update(partners).set({ settings: { organizationOrder: ['remove', 'keep'] } })
      .where(eq(partners.id, partner.id));
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => { locked = resolve; });
    const commit = new Promise<void>((resolve) => { release = resolve; });
    const first = withSystemDbAccessContext(async () => {
      await lockMfaPolicySettings({ kind: 'partner', id: partner.id });
      locked();
      await commit;
      await db.update(partners).set({ settings: { ...denyTotp, organizationOrder: ['remove', 'keep'] } })
        .where(eq(partners.id, partner.id));
    });
    await held;
    let completed = false;
    const second = (writer === 'order cleanup'
      ? removeOrgFromPartnerOrder(partner.id, 'remove')
      : withSystemDbAccessContext(() => setRiskProfile(partner.id, 'strict')))
      .then(() => { completed = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(completed).toBe(false);
    } finally { release(); }
    await Promise.all([first, second]);
    const [row] = await getTestDb().select().from(partners).where(eq(partners.id, partner.id));
    expect(row?.settings).toMatchObject(denyTotp);
    expect(row?.settings).toMatchObject(writer === 'order cleanup'
      ? { organizationOrder: ['keep'] } : { riskProfile: 'strict' });
  });

  it('software-policy writes preserve a concurrently committed org MFA policy', async () => {
    const { org } = await fixture('totp', true);
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => { locked = resolve; });
    const commit = new Promise<void>((resolve) => { release = resolve; });
    const first = withSystemDbAccessContext(async () => {
      await lockMfaPolicySettings({ kind: 'organization', id: org.id });
      locked();
      await commit;
      await db.update(organizations).set({ settings: denyTotp }).where(eq(organizations.id, org.id));
    });
    await held;
    let completed = false;
    const second = withSystemDbAccessContext(() => setOrganizationSoftwareDownloadPolicy(org.id,
      { version: 1, approvedPrivateOrigins: [] })).then(() => { completed = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(completed).toBe(false);
    } finally { release(); }
    await Promise.all([first, second]);
    const [row] = await getTestDb().select().from(organizations).where(eq(organizations.id, org.id));
    expect(row?.settings).toMatchObject({ ...denyTotp, softwareDownloadPolicy: { version: 1, approvedPrivateOrigins: [] } });
  });

  it('serializes partner and child settings through commit, observing the predecessor', async () => {
    const { partner, org } = await fixture('totp', true);
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => { locked = resolve; });
    const commit = new Promise<void>((resolve) => { release = resolve; });
    const first = withSystemDbAccessContext(async () => {
      await lockMfaPolicySettings({ kind: 'partner', id: partner.id });
      await db.update(partners).set({ settings: { security: { allowedMethods: { totp: true } } } })
        .where(eq(partners.id, partner.id));
      locked();
      await commit;
    });
    await held;
    let acquired = false;
    const second = withSystemDbAccessContext(async () => {
      await lockMfaPolicySettings({ kind: 'organization', id: org.id });
      acquired = true;
      return countMfaPolicyLockouts({ kind: 'organization', id: org.id }, denyBoth);
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(acquired).toBe(false);
    } finally { release(); }
    await first;
    expect(await second).toBe(0);
  });
});
