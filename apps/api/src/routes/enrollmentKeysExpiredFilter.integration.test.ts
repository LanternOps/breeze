/**
 * Real-Postgres coverage for the `GET /enrollment-keys?expired=` filter behind
 * the web UI's "Hide expired" toggle (#3191).
 *
 * #3045 taught the row's STATUS BADGE (`getKeyStatus` in
 * `apps/web/src/components/settings/EnrollmentKeyManager.tsx`) that once a
 * parent enrollment key is dead the row is judged by its installer tokens —
 * the things that actually enroll — so an Add-Device key whose 60-minute
 * parent aged out while its 30-day installer keeps working renders "Active".
 * The filter never got the same treatment: it tested `enrollment_keys.expires_at`
 * alone, so switching "Hide expired" on hid rows the very same page was
 * rendering as Active. Both Active and invisible.
 *
 * The invariant this suite pins, and the reason it is worth a real-DB suite:
 *
 *   NO key the badge would render "Active" is hidden by `?expired=false`.
 *
 * Concretely that means the filter honours the SAME live-token fact the purge
 * guard honours — `hasLiveUnexhaustedBootstrapToken()` /
 * `hasNoLiveUnexhaustedBootstrapToken()` are two wrappers over one subquery in
 * `services/enrollmentKeyPurgeGuards.ts` — so "Hide expired" can no longer hide
 * a key that "Delete expired" deliberately refuses to delete.
 *
 * Why real Postgres and not the mocked-`db` unit suites: `enrollmentKeys_list_create.test.ts`
 * mocks `../db` wholesale, so its `where()` returns whatever the test hands it
 * regardless of the predicate. It can assert the WHERE's SQL shape but can
 * never prove Postgres EVALUATES the correlated EXISTS per row — and per-row
 * evaluation against real token rows is the entire fix. The pagination `total`
 * assertions below are likewise only meaningful against a real COUNT.
 *
 * Cases:
 *   (a) expired parent + live unexhausted token  -> VISIBLE under expired=false
 *                                                   (the #3191 regression)
 *   (b) expired parent + token itself expired    -> hidden
 *   (c) expired parent + token fully consumed    -> hidden
 *   (d) expired parent, no tokens at all         -> hidden (pre-existing behaviour)
 *   (e) unexpired parent / never-expiring parent -> visible (pre-existing behaviour)
 *   (f) short-link child + live token            -> hidden, mirroring
 *       `reportsInstallerCapacity` (#3034): the API suppresses `installerTokens`
 *       for a short_code key, so its badge is parent-only and the filter must be
 *       too. Pins the deliberate asymmetry against the purge guard, which
 *       applies no such gate.
 *   (g) `expired=true` is the exact complement of `expired=false` — every key
 *       lands in exactly one, so nothing becomes unreachable from both toggles.
 *
 * Co-located with the route per the repo's test-placement convention, so it
 * must be hand-listed in BOTH `vitest.integration.config.ts` (`include`) and
 * `vitest.config.ts` (`exclude`). Miss either edit and it silently never runs
 * in CI, or reds the no-DB unit job on ECONNREFUSED.
 */
import '../__tests__/integration/setup';

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { db, withSystemDbAccessContext } from '../db';
import { enrollmentKeys, installerBootstrapTokens } from '../db/schema';
import { setupTestEnvironment, type TestEnvironment } from '../__tests__/integration/db-utils';
import { enrollmentKeyRoutes } from './enrollmentKeys';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** One day out — a modest stand-in for the 30-day/1-year links #2832 is about. */
const LIVE_UNTIL = () => new Date(Date.now() + 24 * 60 * 60 * 1000);
const DEAD_SINCE = () => new Date(Date.now() - 60 * 60 * 1000);
/** Backdated far enough that a DEAD_SINCE() expiry still satisfies expires_at > created_at. */
const CREATED_BEFORE_DEATH = () => new Date(Date.now() - 3 * 60 * 60 * 1000);

interface SeedOptions {
  orgId: string;
  siteId: string;
  unique: string;
  /** Minutes ago the PARENT key expired. `null` => never-expiring key. */
  parentExpiredMinutesAgo?: number | null;
  /** Minutes in the FUTURE the parent expires (mutually exclusive with the above). */
  parentExpiresInMinutes?: number;
  shortCode?: string;
  token?: { expiresAt: Date; createdAt?: Date; maxUsage: number; consumedCount: number };
}

/**
 * Seeds one key (+ optional bootstrap token) and returns its id.
 *
 * The token always takes the parent's `orgId`, exactly as
 * `installerBootstrapTokenIssuance.ts` does — load-bearing for the RLS
 * reasoning in the shared guard's docblock, since the EXISTS subquery is
 * evaluated inside the caller's org-scoped context and a token stamped with a
 * different org would be invisible to it.
 */
async function seedKey(opts: SeedOptions): Promise<string> {
  const expiresAt =
    opts.parentExpiresInMinutes !== undefined
      ? new Date(Date.now() + opts.parentExpiresInMinutes * 60 * 1000)
      : opts.parentExpiredMinutesAgo === null
        ? null
        : new Date(Date.now() - (opts.parentExpiredMinutesAgo ?? 60) * 60 * 1000);

  return withSystemDbAccessContext(async () => {
    const [key] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: opts.orgId,
        siteId: opts.siteId,
        name: `expired-filter ${opts.unique}`,
        key: `expfilter-key-${opts.unique}`,
        expiresAt,
        maxUsage: 25,
        ...(opts.shortCode ? { shortCode: opts.shortCode } : {}),
      })
      .returning({ id: enrollmentKeys.id });

    if (opts.token) {
      await db.insert(installerBootstrapTokens).values({
        token: `expfilter-token-${opts.unique}`,
        orgId: opts.orgId,
        parentEnrollmentKeyId: key!.id,
        siteId: opts.siteId,
        maxUsage: opts.token.maxUsage,
        consumedCount: opts.token.consumedCount,
        // `installer_bootstrap_tokens_expires_after_created` (DB CHECK) forbids
        // expires_at <= created_at, so an ALREADY-EXPIRED token has to be
        // backdated rather than just given a past expiry.
        ...(opts.token.createdAt ? { createdAt: opts.token.createdAt } : {}),
        expiresAt: opts.token.expiresAt,
      });
    }
    return key!.id;
  });
}

function makeApp(): Hono {
  const app = new Hono();
  app.route('/enrollment-keys', enrollmentKeyRoutes);
  return app;
}

interface ListResult {
  ids: string[];
  total: number;
}

async function listKeys(token: string, expired?: 'true' | 'false'): Promise<ListResult> {
  const params = new URLSearchParams({ limit: '100' });
  if (expired) params.set('expired', expired);
  const res = await makeApp().request(`/enrollment-keys?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: Array<{ id: string }>;
    pagination: { total: number };
  };
  return { ids: body.data.map((row) => row.id), total: body.pagination.total };
}

/**
 * Seeds the whole matrix into ONE fresh org so a single pair of requests can
 * assert both the membership of each bucket and their complementarity.
 * A fresh org per run also keeps `pagination.total` deterministic.
 */
async function seedMatrix(env: TestEnvironment, unique: string) {
  const orgId = env.organization.id;
  const siteId = env.site.id;
  const ids = {
    liveToken: await seedKey({
      orgId,
      siteId,
      unique: `${unique}-live`,
      token: { expiresAt: LIVE_UNTIL(), maxUsage: 25, consumedCount: 3 },
    }),
    deadToken: await seedKey({
      orgId,
      siteId,
      unique: `${unique}-deadtoken`,
      token: {
        createdAt: CREATED_BEFORE_DEATH(),
        expiresAt: DEAD_SINCE(),
        maxUsage: 25,
        consumedCount: 3,
      },
    }),
    consumedToken: await seedKey({
      orgId,
      siteId,
      unique: `${unique}-consumed`,
      token: { expiresAt: LIVE_UNTIL(), maxUsage: 5, consumedCount: 5 },
    }),
    noToken: await seedKey({ orgId, siteId, unique: `${unique}-notoken` }),
    unexpired: await seedKey({
      orgId,
      siteId,
      unique: `${unique}-unexpired`,
      parentExpiresInMinutes: 60,
    }),
    neverExpires: await seedKey({
      orgId,
      siteId,
      unique: `${unique}-never`,
      parentExpiredMinutesAgo: null,
    }),
    shortLinkChild: await seedKey({
      orgId,
      siteId,
      unique: `${unique}-shortlink`,
      shortCode: unique.slice(-10),
      token: { expiresAt: LIVE_UNTIL(), maxUsage: 1, consumedCount: 0 },
    }),
  };
  return ids;
}

describe('GET /enrollment-keys?expired= — live installer-token liveness (#3191, real Postgres)', () => {
  runDb('hides exactly the dead keys and keeps every badge-Active key visible', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const env = await setupTestEnvironment({ scope: 'organization' });
    const ids = await seedMatrix(env, unique);

    const unfiltered = await listKeys(env.token);
    const visible = await listKeys(env.token, 'false');

    // Sanity: the filter is actually narrowing something. Without this a
    // filter that matched every row would satisfy the (a)/(e) assertions.
    expect(unfiltered.ids).toHaveLength(7);
    expect(visible.ids.length).toBeLessThan(unfiltered.ids.length);

    // (a) THE REGRESSION: expired parent, live unexhausted installer. The badge
    // renders this "Active" (liveConsumed 3 < liveMax 25) — it must not be hidden.
    expect(visible.ids).toContain(ids.liveToken);

    // (e) untouched pre-existing behaviour.
    expect(visible.ids).toContain(ids.unexpired);
    expect(visible.ids).toContain(ids.neverExpires);

    // (b) the installer itself expired -> nothing can enroll -> stays hidden.
    expect(visible.ids).not.toContain(ids.deadToken);
    // (c) live installer but every slot claimed (consumed >= max) -> hidden.
    expect(visible.ids).not.toContain(ids.consumedToken);
    // (d) no installer ever minted -> parent expiry is the whole story.
    expect(visible.ids).not.toContain(ids.noToken);
    // (f) short-link child: `installerTokens` is suppressed on the wire for it
    // (#3034), so its badge is parent-only and the filter must agree — even
    // though a live token exists and the PURGE guard would spare it.
    expect(visible.ids).not.toContain(ids.shortLinkChild);

    // `total` drives the pager, so it must be filtered too, not just the page.
    expect(visible.total).toBe(visible.ids.length);
  });

  runDb('(g) expired=true is the exact complement of expired=false', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const env = await setupTestEnvironment({ scope: 'organization' });
    const ids = await seedMatrix(env, unique);
    const all = Object.values(ids);

    const visible = await listKeys(env.token, 'false');
    const expired = await listKeys(env.token, 'true');

    // Partition: every seeded key in exactly one bucket, none in both, none in
    // neither. A key reachable from neither toggle would be invisible to the
    // operator whichever way they set it.
    for (const id of all) {
      const inVisible = visible.ids.includes(id);
      const inExpired = expired.ids.includes(id);
      expect(inVisible !== inExpired).toBe(true);
    }
    expect(visible.ids.length + expired.ids.length).toBe(all.length);

    // And the live-installer key specifically is on the "not expired" side.
    expect(expired.ids).not.toContain(ids.liveToken);
    expect(expired.ids).toContain(ids.deadToken);
    expect(expired.total).toBe(expired.ids.length);
  });
});
