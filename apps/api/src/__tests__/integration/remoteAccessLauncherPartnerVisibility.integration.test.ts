/**
 * Real-Postgres integration coverage for the partner-axis RLS gap in the
 * remote-access launcher (#3419).
 *
 * The bug: `loadRemoteAccessLauncherContext` (routes/devices/core.ts) read
 * `partners.settings` — a partner-axis table whose only SELECT policy is
 * `breeze_has_partner_access(id)` (migrations/2026-04-11-partners-rls.sql) —
 * wrapped in a BARE `withSystemDbAccessContext`. That wrapper looks like an
 * escalation but is inert inside a request: `withDbAccessContext`
 * early-returns when a context store already exists (db/index.ts) and
 * authMiddleware has already opened one, so the read silently kept the
 * caller's own scope. `computeAccessiblePartnerIds` returns `[]` for
 * `scope === 'organization'` (middleware/auth.ts), so for an org-scoped
 * technician the join returned ZERO ROWS — without raising — and the
 * launcher reported `no_provider_configured` for a tenant that had a
 * provider configured. Both entry points are
 * `requireScope('organization', 'partner', 'system')`, so org scope is not a
 * hypothetical caller: it is the default one.
 *
 * A mocked-DB unit test cannot catch this. `core.remoteAccessLaunch.test.ts`
 * stages the partner row its own assertions then read back, with no RLS
 * evaluation anywhere; the pre-fix code passed every one of those tests.
 * Only a real Postgres connection through the `breeze_app` role, inside a
 * real org-scoped `withDbAccessContext` session, can tell the two apart.
 *
 * This file therefore reproduces the exact ambient context an org-scoped
 * HTTP request runs under (see enrollmentDefaultsPartnerCap.integration.test.ts,
 * the #2776 precedent this is modelled on) and asserts the launcher still
 * resolves the partner's provider from inside it.
 */
import './setup';

import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { organizations, partners } from '../../db/schema';
import { checkRemoteAccessLauncherAvailabilityForDevice } from '../../routes/devices/core';
import { readPartnerRemoteAccessSettings } from '../../services/remoteAccessProviders';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** Mirrors authMiddleware's computeAccessiblePartnerIds for scope 'organization': []. */
function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

const PROVIDER_ID = 'rustdesk';
const CUSTOM_FIELD_KEY = 'rustdesk_id';

/** A fully-configured provider: enabled, default, with a URL template. */
const CONFIGURED_PROVIDERS = {
  defaultProviderId: PROVIDER_ID,
  providers: [
    {
      id: PROVIDER_ID,
      name: 'RustDesk',
      urlTemplate: 'rustdesk://{id}?password={password}',
      customFieldKey: CUSTOM_FIELD_KEY,
      password: 'hunter2',
      enabled: true,
    },
  ],
};

/** The device custom_fields the provider above needs to resolve. */
const DEVICE_CUSTOM_FIELDS = { [CUSTOM_FIELD_KEY]: '294064193' };

const createdOrgIds: string[] = [];
const createdPartnerIds: string[] = [];

async function seedTenant(): Promise<{ partnerId: string; orgId: string }> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ids = await withSystemDbAccessContext(async () => {
    const [partner] = await db
      .insert(partners)
      .values({
        name: `Launcher Partner ${unique}`,
        slug: `launcher-partner-${unique}`,
        type: 'msp',
        plan: 'pro',
        status: 'active',
        settings: { remoteAccessProviders: CONFIGURED_PROVIDERS },
      })
      .returning({ id: partners.id });
    const [org] = await db
      .insert(organizations)
      .values({
        currencyCode: 'USD',
        partnerId: partner!.id,
        name: `Launcher Org ${unique}`,
        slug: `launcher-org-${unique}`,
        type: 'customer',
        status: 'active',
      })
      .returning({ id: organizations.id });
    return { partnerId: partner!.id, orgId: org!.id };
  });
  createdPartnerIds.push(ids.partnerId);
  createdOrgIds.push(ids.orgId);
  return ids;
}

afterEach(async () => {
  if (createdOrgIds.length === 0 && createdPartnerIds.length === 0) return;
  await withSystemDbAccessContext(async () => {
    for (const id of createdOrgIds) {
      await db.delete(organizations).where(eq(organizations.id, id));
    }
    for (const id of createdPartnerIds) {
      await db.delete(partners).where(eq(partners.id, id));
    }
  });
  createdOrgIds.length = 0;
  createdPartnerIds.length = 0;
});

describe('remote-access launcher — partner provider visibility under org-scoped RLS (#3419)', () => {
  runDb(
    'an org-scoped caller (accessiblePartnerIds: []) still resolves the partner-configured launcher',
    async () => {
      const { orgId } = await seedTenant();

      // The crux of the reproduction: call the resolver from INSIDE the same
      // kind of RLS context an org-scoped HTTP request runs under, not from
      // withSystemDbAccessContext. Pre-fix, the partner read ran against
      // whatever context was already ambient — here, the org-scoped one — so
      // the join returned nothing and this came back
      // { available: false, skipReason: 'no_provider_configured' }.
      const availability = await withDbAccessContext(orgContext(orgId), () =>
        checkRemoteAccessLauncherAvailabilityForDevice(orgId, DEVICE_CUSTOM_FIELDS),
      );

      expect(availability).toEqual({
        available: true,
        providerId: PROVIDER_ID,
        skipReason: null,
      });
    },
  );

  runDb(
    'the delegated partner read itself returns the providers under an org-scoped context',
    async () => {
      const { orgId } = await seedTenant();

      const providers = await withDbAccessContext(orgContext(orgId), () =>
        readPartnerRemoteAccessSettings(orgId),
      );

      expect(providers?.defaultProviderId).toBe(PROVIDER_ID);
      expect(providers?.providers?.map((p) => p.id)).toEqual([PROVIDER_ID]);
    },
  );

  runDb(
    'sanity check: the raw partners row IS invisible to that org-scoped context (proves the RLS premise, not just the fix)',
    async () => {
      const { orgId, partnerId } = await seedTenant();

      const rows = await withDbAccessContext(orgContext(orgId), () =>
        db.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)),
      );

      // If this ever starts returning the row, the premise of #3419 (and of
      // the escape the fix relies on) is gone — the partners RLS policy
      // itself changed, and this file needs re-evaluating, not green-lighting.
      expect(rows).toHaveLength(0);
    },
  );

  runDb(
    'negative control: a partner with NO providers configured still reports no_provider_configured',
    async () => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ids = await withSystemDbAccessContext(async () => {
        const [partner] = await db
          .insert(partners)
          .values({
            name: `Bare Partner ${unique}`,
            slug: `bare-partner-${unique}`,
            type: 'msp',
            plan: 'pro',
            status: 'active',
            settings: {},
          })
          .returning({ id: partners.id });
        const [org] = await db
          .insert(organizations)
          .values({
            currencyCode: 'USD',
            partnerId: partner!.id,
            name: `Bare Org ${unique}`,
            slug: `bare-org-${unique}`,
            type: 'customer',
            status: 'active',
          })
          .returning({ id: organizations.id });
        return { partnerId: partner!.id, orgId: org!.id };
      });
      createdPartnerIds.push(ids.partnerId);
      createdOrgIds.push(ids.orgId);

      // Discriminating control for the assertion above: it must be the
      // partner's real configuration that decides the answer, not the fix
      // hard-coding availability. A genuinely unconfigured tenant must still
      // report the same skip reason the BUG used to report for a configured
      // one — otherwise these tests would pass against a resolver that always
      // said "available".
      const availability = await withDbAccessContext(orgContext(ids.orgId), () =>
        checkRemoteAccessLauncherAvailabilityForDevice(ids.orgId, DEVICE_CUSTOM_FIELDS),
      );

      expect(availability).toEqual({
        available: false,
        providerId: null,
        skipReason: 'no_provider_configured',
      });
    },
  );
});

/**
 * AVAILABILITY (#2776 round 4, inherited via readWithPartnerAxisVisibility):
 * the escape is taken ONLY when it is actually needed. `withDbAccessContext`
 * opens a real `baseDb.transaction`, pinning one pooled connection for the
 * whole callback, and `runOutsideDbContext` exits the ALS store — so the
 * nested system context does not nest, it borrows a SECOND connection while
 * the first is still held. Since #3419 put this read on GET /devices/:id,
 * a system-scoped caller taking the escape needlessly would double-hold on a
 * hot path, and postgres-js has no acquire timeout.
 *
 * This asserts the MECHANISM, not the value: both code paths return the same
 * providers, so only transaction visibility can tell them apart. It writes
 * the partner+org inside an OPEN system transaction and calls the resolver
 * from inside that same transaction. Uncommitted rows are invisible to any
 * other connection, so a read on a SECOND connection sees nothing and the
 * expectation below fails loudly the moment the skip branch is removed.
 */
describe('remote-access launcher — no second pooled connection for a system-scoped caller', () => {
  runDb(
    'reads inside the caller’s own system transaction rather than on a second connection',
    async () => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const { availability, ids } = await withSystemDbAccessContext(async () => {
        const [partner] = await db
          .insert(partners)
          .values({
            name: `Ambient Launcher Partner ${unique}`,
            slug: `ambient-launcher-partner-${unique}`,
            type: 'msp',
            plan: 'pro',
            status: 'active',
            settings: { remoteAccessProviders: CONFIGURED_PROVIDERS },
          })
          .returning({ id: partners.id });
        const [org] = await db
          .insert(organizations)
          .values({
            currencyCode: 'USD',
            partnerId: partner!.id,
            name: `Ambient Launcher Org ${unique}`,
            slug: `ambient-launcher-org-${unique}`,
            type: 'customer',
            status: 'active',
          })
          .returning({ id: organizations.id });

        // Still INSIDE the transaction that wrote these rows, and still
        // uncommitted: only a read on this very connection can see them.
        const availability = await checkRemoteAccessLauncherAvailabilityForDevice(
          org!.id,
          DEVICE_CUSTOM_FIELDS,
        );
        return { availability, ids: { partnerId: partner!.id, orgId: org!.id } };
      });

      createdPartnerIds.push(ids.partnerId);
      createdOrgIds.push(ids.orgId);

      expect(availability.available).toBe(true);
      expect(availability.providerId).toBe(PROVIDER_ID);
    },
  );
});
