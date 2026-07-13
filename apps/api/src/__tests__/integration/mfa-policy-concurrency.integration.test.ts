import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import './setup';
import { getTestDb } from './setup';
import {
  createOrganization,
  createPartner,
  createRole,
  createUser,
  assignUserToOrganization,
  assignUserToPartner,
} from './db-utils';
import { organizations, partners, roles } from '../../db/schema';
import {
  lockMfaPolicyPartner,
  MfaPolicyConfigurationError,
  MfaPolicyResolutionError,
  resolveEffectiveMfaPolicy,
  validateOrganizationMfaPolicySettingsWrite,
  validatePartnerMfaPolicySettingsWrite,
} from '../../services/mfaPolicy';
import { lockMfaAssuranceState } from '../../services/mfaAssuranceLocks';
import { lockPartnerMfaLifecycleRows } from '../../services/partnerLifecycleLock';
import { withAuthLifecycleSystemTransaction } from '../../services/authLifecycle';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('MFA policy serialization against real PostgreSQL', () => {
  let partnerId: string;
  let orgId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const organization = await createOrganization({ partnerId: partner.id });
    partnerId = partner.id;
    orgId = organization.id;
    const broad = { security: { allowedMethods: { totp: true, passkey: true } } };
    const tdb = getTestDb();
    await tdb.update(partners).set({ settings: broad }).where(eq(partners.id, partnerId));
    await tdb.update(organizations).set({ settings: broad }).where(eq(organizations.id, orgId));
  });

  it('serializes a partner/org race and rejects the second now-incompatible write', async () => {
    const tdb = getTestDb();

    // Against the initial broad state, each proposal is independently valid.
    await tdb.transaction(async (tx) => {
      await validatePartnerMfaPolicySettingsWrite({
        tx,
        partnerId,
        settings: { security: { allowedMethods: { totp: true } } },
      });
    });
    await tdb.transaction(async (tx) => {
      await validateOrganizationMfaPolicySettingsWrite({
        tx,
        partnerId,
        orgId,
        settings: { security: { allowedMethods: { passkey: true } } },
      });
    });

    const firstLocked = deferred();
    const secondAttempted = deferred();

    const partnerWrite = tdb.transaction(async (tx) => {
      await lockMfaPolicyPartner(tx, partnerId);
      firstLocked.resolve();
      await secondAttempted.promise;
      await validatePartnerMfaPolicySettingsWrite({
        tx,
        partnerId,
        settings: { security: { allowedMethods: { totp: true } } },
      });
      await tx
        .update(partners)
        .set({ settings: { security: { allowedMethods: { totp: true } } } })
        .where(eq(partners.id, partnerId));
    });

    const organizationWrite = (async () => {
      await firstLocked.promise;
      return tdb.transaction(async (tx) => {
        secondAttempted.resolve();
        await validateOrganizationMfaPolicySettingsWrite({
          tx,
          partnerId,
          orgId,
          settings: { security: { allowedMethods: { passkey: true } } },
        });
        await tx
          .update(organizations)
          .set({ settings: { security: { allowedMethods: { passkey: true } } } })
          .where(eq(organizations.id, orgId));
      });
    })();

    await partnerWrite;
    await expect(organizationWrite).rejects.toBeInstanceOf(MfaPolicyConfigurationError);

    const [partner] = await tdb.select({ settings: partners.settings }).from(partners)
      .where(eq(partners.id, partnerId));
    const [organization] = await tdb.select({ settings: organizations.settings }).from(organizations)
      .where(eq(organizations.id, orgId));
    expect(partner?.settings).toEqual({ security: { allowedMethods: { totp: true } } });
    expect(organization?.settings).toEqual({
      security: { allowedMethods: { totp: true, passkey: true } },
    });
  });

  it('takes the MFA advisory lock before partner lifecycle user locks', async () => {
    const tdb = getTestDb();
    const user = await createUser({ partnerId });
    const role = await createRole({ scope: 'partner', partnerId });
    await assignUserToPartner(user.id, partnerId, role.id, 'all');

    const advisoryHeld = deferred();
    const releaseFactor = deferred();
    const factorMutation = tdb.transaction(async (tx) => {
      await lockMfaPolicyPartner(tx, partnerId);
      advisoryHeld.resolve();
      await releaseFactor.promise;
      await lockMfaAssuranceState(tx, { partnerId, userId: user.id });
    });
    await advisoryHeld.promise;

    const partnerMutation = withAuthLifecycleSystemTransaction((tx) =>
      lockPartnerMfaLifecycleRows(tx, partnerId)
    );
    void partnerMutation.catch(() => undefined);
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const rows = await tdb.execute(sql`
          SELECT count(*)::int AS blocked_count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND usename = 'breeze_app'
            AND wait_event_type = 'Lock'
            AND position('pg_advisory_xact_lock' in lower(query)) > 0
        `) as unknown as Array<{ blocked_count: number }>;
        if (Number(rows[0]?.blocked_count ?? 0) >= 1) break;
        if (attempt === 199) throw new Error('partner MFA lifecycle did not block on advisory lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // The combined partner mutation must not hold the user while waiting on
      // the advisory lock. Under users -> advisory, this probe times out and
      // releasing the factor creates the exact two-edge deadlock.
      await tdb.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '500ms'`);
        await tx.execute(sql`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`);
      });

      releaseFactor.resolve();
      await expect(Promise.all([factorMutation, partnerMutation])).resolves.toBeTruthy();
    } finally {
      releaseFactor.resolve();
      await Promise.allSettled([factorMutation, partnerMutation]);
    }
  });
});

describe('MFA policy real-driver role and corruption coverage', () => {
  it('accepts seeded global Partner Admin and Org Admin role shapes', async () => {
    const tdb = getTestDb();
    const partner = await createPartner();
    const organization = await createOrganization({ partnerId: partner.id });

    const partnerUser = await createUser({ partnerId: partner.id });
    const partnerRole = await createRole({ scope: 'partner', isSystem: true });
    await tdb.update(roles).set({ forceMfa: true }).where(eq(roles.id, partnerRole.id));
    await assignUserToPartner(partnerUser.id, partner.id, partnerRole.id, 'all');

    const orgUser = await createUser({ partnerId: partner.id, orgId: organization.id });
    const orgRole = await createRole({ scope: 'organization', isSystem: true });
    await tdb.update(roles).set({ forceMfa: true }).where(eq(roles.id, orgRole.id));
    await assignUserToOrganization(orgUser.id, organization.id, orgRole.id);

    await tdb.transaction(async (tx) => {
      await expect(resolveEffectiveMfaPolicy({
        tx,
        userId: partnerUser.id,
        roleId: partnerRole.id,
        partnerId: partner.id,
        orgId: null,
        scope: 'partner',
      })).resolves.toMatchObject({ required: true, sources: ['role'] });

      await expect(resolveEffectiveMfaPolicy({
        tx,
        userId: orgUser.id,
        roleId: orgRole.id,
        partnerId: partner.id,
        orgId: organization.id,
        scope: 'organization',
      })).resolves.toMatchObject({ required: true, sources: ['role'] });
    });
  });

  it('fails closed on malformed persisted settings and security containers', async () => {
    const tdb = getTestDb();
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    await assignUserToPartner(user.id, partner.id, role.id, 'all');

    for (const settings of ['corrupt-settings', ['security'], { security: 'corrupt-security' }]) {
      await tdb.update(partners).set({ settings }).where(eq(partners.id, partner.id));
      await tdb.transaction(async (tx) => {
        await expect(resolveEffectiveMfaPolicy({
          tx,
          userId: user.id,
          roleId: role.id,
          partnerId: partner.id,
          orgId: null,
          scope: 'partner',
        })).rejects.toBeInstanceOf(MfaPolicyResolutionError);
      });
    }
  });
});
