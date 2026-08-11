/**
 * Real-Postgres coverage for the `GET /enrollment-keys?expired=` filter behind
 * the web UI's "Hide expired" toggle (#3191).
 *
 * #3039 (PR #3045) taught the row's STATUS BADGE (`getKeyStatus` in
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
 * guard honours. `hasLiveUnexhaustedCapacityToken()` /
 * `hasNoLiveUnexhaustedCapacityToken()` (what the filter uses) and
 * `hasNoLiveUnexhaustedBootstrapToken()` (what the purge uses) are wrappers
 * over ONE subquery builder in `services/enrollmentKeyPurgeGuards.ts`,
 * differing only in whether they restrict to `usage_kind = 'capacity'` — so
 * "Hide expired" can no longer hide a key that "Delete expired" deliberately
 * refuses to delete. The filter is the narrower of the two because it must
 * match the badge (#3034); the purge stays deliberately wider, so the residual
 * disagreement is always in the safe direction.
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
 *   (f) short-link child + live PER_DOWNLOAD token -> hidden: a download token
 *       is not device-slot capacity, so nothing aggregates, the badge is
 *       parent-only, and the filter must be too. Pins the deliberate asymmetry
 *       against the purge guard, which spares the key regardless of kind.
 *   (j) short-link child + live CAPACITY token   -> VISIBLE (#3034). Differs
 *       from (f) ONLY in `usage_kind`, which is what makes this pair the proof
 *       that the discriminator moved from the key to the token. The old
 *       `short_code IS NULL` gate hid both.
 *   (g) `expired=true` is the exact complement of `expired=false` — every key
 *       lands in exactly one, so no key is unreachable from both predicates.
 *   (h)/(i) MULTI-token keys, where the badge's SUM semantics and the filter's
 *       per-row EXISTS could diverge and a single-token fixture proves nothing.
 *
 * Three cases go beyond the filter itself, because the invariant is a RELATION
 * and the other half must not be taken on faith:
 *   - the badge's own input (`installerTokens` on the wire) is asserted from
 *     the SAME response, so a change to which tokens count can no longer flip a
 *     badge to Active while the filter keeps hiding the row. That is exactly
 *     what #3034 changed, and case (j) is the row it turned on;
 *   - partner and system scope, since the carve-out is a correlated EXISTS over
 *     a second RLS-forced table and a blind subquery would silently no-op;
 *   - a foreign-org token, since the subquery correlates only on
 *     `parent_enrollment_key_id` and leans entirely on RLS for tenant safety.
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
  token?: {
    expiresAt: Date;
    createdAt?: Date;
    maxUsage: number;
    consumedCount: number;
    /**
     * REQUIRED (#3034): what this token's max_usage MEANS. The list filter now
     * asks `hasLiveUnexhaustedCapacityToken`, so a fixture that left this to the
     * column DEFAULT (`legacy_unknown`) would be silently excluded and the case
     * would pass for the wrong reason. Every case states it.
     */
    usageKind: "capacity" | "per_download";
  };
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
        usageKind: opts.token.usageKind,
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

/** Adds a SECOND bootstrap token to an existing key (multi-token cases). */
async function attachToken(
  parentEnrollmentKeyId: string,
  opts: {
    orgId: string;
    siteId: string;
    unique: string;
    expiresAt: Date;
    createdAt?: Date;
    maxUsage: number;
    consumedCount: number;
    usageKind: "capacity" | "per_download";
  },
): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db.insert(installerBootstrapTokens).values({
      token: `expfilter-token-${opts.unique}`,
      orgId: opts.orgId,
      parentEnrollmentKeyId,
      siteId: opts.siteId,
      maxUsage: opts.maxUsage,
      consumedCount: opts.consumedCount,
      usageKind: opts.usageKind,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      expiresAt: opts.expiresAt,
    });
  });
}

/** A 10-char code from the real `shortCodeAlphabet`, derived from `unique`. */
function shortCodeLike(unique: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let hash = 0;
  for (const ch of unique) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    out += alphabet[hash % alphabet.length];
    hash = Math.floor(hash / alphabet.length) + i * 7 + 13;
  }
  return out;
}

function makeApp(): Hono {
  const app = new Hono();
  app.route('/enrollment-keys', enrollmentKeyRoutes);
  return app;
}

interface WireTokens {
  consumed: number;
  max: number;
  liveConsumed: number;
  liveMax: number;
}

interface ListResult {
  ids: string[];
  total: number;
  /** `installerTokens` per key id — the exact input `getKeyStatus` badges from. */
  tokens: Map<string, WireTokens | null>;
}

/**
 * Reproduces the badge's verdict from the SAME response the filter produced,
 * so the two halves of the invariant are checked against one payload rather
 * than one being taken on faith. Mirrors `getKeyStatus`'s token branch: a key
 * is Active-by-token when live capacity remains.
 */
function badgeReadsActiveFromTokens(t: WireTokens | null | undefined): boolean {
  return !!t && t.max > 0 && t.liveConsumed < t.liveMax;
}

async function listKeys(token: string, expired?: 'true' | 'false'): Promise<ListResult> {
  const params = new URLSearchParams({ limit: '100' });
  if (expired) params.set('expired', expired);
  const res = await makeApp().request(`/enrollment-keys?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  // Surface the body on failure — a bare `expect(200)` on an auth/permission
  // regression reports only the number and costs a debugging round-trip.
  if (res.status !== 200) throw new Error(`list failed ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as {
    data: Array<{ id: string; installerTokens: WireTokens | null }>;
    pagination: { total: number };
  };
  return {
    ids: body.data.map((row) => row.id),
    total: body.pagination.total,
    tokens: new Map(body.data.map((row) => [row.id, row.installerTokens])),
  };
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
      token: {
        expiresAt: LIVE_UNTIL(),
        maxUsage: 25,
        consumedCount: 3,
        usageKind: "capacity",
      },
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
        usageKind: "capacity",
      },
    }),
    consumedToken: await seedKey({
      orgId,
      siteId,
      unique: `${unique}-consumed`,
      token: {
        expiresAt: LIVE_UNTIL(),
        maxUsage: 5,
        consumedCount: 5,
        usageKind: "capacity",
      },
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
      // Drawn from `shortCodeAlphabet` (routes/enrollmentKeys.ts) rather than a
      // slice of `unique`, which contains characters the allocator can never
      // emit — the realism of this row is the whole point of case (f).
      shortCode: shortCodeLike(unique),
      unique: `${unique}-shortlink`,
      // A real public download: serveInstaller hardcodes maxUsage 1 and stamps
      // per_download, so this token is a CLICK, not a device slot.
      token: {
        expiresAt: LIVE_UNTIL(),
        maxUsage: 1,
        consumedCount: 0,
        usageKind: "per_download",
      },
    }),
    // (j) #3034 — the SAME short_code-bearing row, but the operator went on to
    // build an authenticated installer FROM it, minting a genuine 4-slot
    // capacity token. Under the old per-key `short_code` gate this row was
    // indistinguishable from the one above: both had their figure suppressed and
    // both were hidden. It must now badge Active and stay VISIBLE.
    shortLinkChildWithCapacity: await seedKey({
      orgId,
      siteId,
      shortCode: shortCodeLike(`${unique}-cap`),
      unique: `${unique}-shortlink-cap`,
      token: {
        expiresAt: LIVE_UNTIL(),
        maxUsage: 4,
        consumedCount: 1,
        usageKind: "capacity",
      },
    }),
  };

  // (h) MULTI-TOKEN. The badge sums across every token a key ever minted, while
  // the filter asks a per-row EXISTS; with one token per key that equivalence
  // is untestable because both reduce to the same row. Here an expired 10-slot
  // installer sits beside a live unused 1-slot one: sum semantics say
  // liveConsumed 0 < liveMax 1 -> Active, and only a predicate that applies the
  // `expires_at` cut per token agrees.
  const multiTokenId = await seedKey({
    orgId,
    siteId,
    unique: `${unique}-multi-dead`,
    token: {
      createdAt: CREATED_BEFORE_DEATH(),
      expiresAt: DEAD_SINCE(),
      maxUsage: 10,
      consumedCount: 0,
      usageKind: "capacity",
    },
  });
  await attachToken(multiTokenId, {
    orgId,
    siteId,
    unique: `${unique}-multi-live`,
    expiresAt: LIVE_UNTIL(),
    maxUsage: 1,
    consumedCount: 0,
    usageKind: "capacity",
  });

  // (i) MULTI-TOKEN, all live but all exhausted -> badge Exhausted, not Active.
  const multiExhaustedId = await seedKey({
    orgId,
    siteId,
    unique: `${unique}-multiex-a`,
    token: {
      expiresAt: LIVE_UNTIL(),
      maxUsage: 5,
      consumedCount: 5,
      usageKind: "capacity",
    },
  });
  await attachToken(multiExhaustedId, {
    orgId,
    siteId,
    unique: `${unique}-multiex-b`,
    expiresAt: LIVE_UNTIL(),
    maxUsage: 3,
    consumedCount: 3,
    usageKind: "capacity",
  });

  return { ...ids, multiToken: multiTokenId, multiExhausted: multiExhaustedId };
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
    expect(unfiltered.ids).toHaveLength(Object.keys(ids).length);
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
    // (f) short-link child whose only token is per_download: it is a live token,
    // and the PURGE guard would spare it, but it is not device-slot capacity —
    // so `installerTokens` is null on the wire, the badge is parent-only, and
    // the filter must agree. Pins the deliberate asymmetry against the purge.
    expect(visible.ids).not.toContain(ids.shortLinkChild);
    // (j) #3034 — same short_code shape, but backed by a live CAPACITY token.
    // The badge reads Active, so the filter must keep it visible. Under the old
    // `short_code IS NULL` gate this row was hidden, which is the bug.
    expect(visible.ids).toContain(ids.shortLinkChildWithCapacity);
    // (h) two tokens, one long-dead 10-slot + one live unused 1-slot -> Active.
    expect(visible.ids).toContain(ids.multiToken);
    // (i) two tokens, both live but both fully claimed -> not Active -> hidden.
    expect(visible.ids).not.toContain(ids.multiExhausted);

    // `total` drives the pager, so it must be filtered too, not just the page.
    expect(visible.total).toBe(visible.ids.length);
    expect(unfiltered.total).toBe(unfiltered.ids.length);
  });

  // The invariant is a RELATION between the badge and the filter, so checking
  // the filter alone leaves half of it on trust. This reads both off the SAME
  // payload: `installerTokens` is exactly what `getKeyStatus` badges from, so a
  // future change that flips a row's badge to Active without flipping the
  // filter — e.g. changing which `usage_kind` values the aggregate counts,
  // which is what #3034 did — fails HERE rather than silently reintroducing
  // #3191.
  runDb('no key whose wire payload reads Active is hidden by expired=false', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const env = await setupTestEnvironment({ scope: 'organization' });
    const ids = await seedMatrix(env, unique);

    const unfiltered = await listKeys(env.token);
    const visible = await listKeys(env.token, 'false');

    for (const [id, tokens] of unfiltered.tokens) {
      if (badgeReadsActiveFromTokens(tokens)) {
        expect(visible.ids).toContain(id);
      }
    }

    // Non-vacuity: the loop above must actually have judged something Active.
    const activeByToken = [...unfiltered.tokens].filter(([, t]) =>
      badgeReadsActiveFromTokens(t),
    );
    expect(activeByToken.length).toBeGreaterThan(0);

    // The rows the discriminator turns on, asserted explicitly rather than
    // implied.
    expect(badgeReadsActiveFromTokens(unfiltered.tokens.get(ids.liveToken))).toBe(true);
    // Only per-download tokens -> nothing aggregates -> null on the wire ->
    // badge falls through to parent expiry -> hidden.
    expect(unfiltered.tokens.get(ids.shortLinkChild)).toBeNull();
    // #3034: a capacity token under the SAME short_code shape DOES reach the
    // wire, and the badge reads Active off it. This is the pair that proves the
    // discriminator is per-token — the two rows differ only in `usage_kind`.
    expect(unfiltered.tokens.get(ids.shortLinkChildWithCapacity)).toEqual({
      consumed: 1,
      max: 4,
      liveConsumed: 1,
      liveMax: 4,
    });
    expect(
      badgeReadsActiveFromTokens(unfiltered.tokens.get(ids.shortLinkChildWithCapacity)),
    ).toBe(true);
  });

  // This predicate has now been missed on three separate code paths
  // (#2775 -> #2832 -> #3191), and it is a correlated EXISTS over a SECOND
  // RLS-forced table. Under partner scope the outer query resolves many orgs
  // and the subquery re-evaluates `breeze_has_org_access` per token; if it went
  // blind there the carve-out would silently no-op and #3191 would be back for
  // every MSP-scoped tech — with no other test failing.
  //
  // System scope is deliberately NOT exercised: `setupTestEnvironment` creates
  // no membership row for it, so a system-scope token fails `requirePermission`
  // (403) before it ever reaches this predicate. That is a harness limitation,
  // not a route one, and no other suite in the repo drives system scope through
  // it either.
  runDb('the carve-out survives partner scope, not just org scope', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const partnerEnv = await setupTestEnvironment({ scope: 'partner' });
    const partnerIds = await seedMatrix(partnerEnv, `${unique}-p`);

    const partnerVisible = await listKeys(partnerEnv.token, 'false');
    expect(partnerVisible.ids).toContain(partnerIds.liveToken);
    expect(partnerVisible.ids).toContain(partnerIds.multiToken);
    expect(partnerVisible.ids).not.toContain(partnerIds.deadToken);
    expect(partnerVisible.ids).not.toContain(partnerIds.shortLinkChild);
    // #3034 under partner scope too: the capacity subquery re-evaluates
    // `breeze_has_org_access` per token across many orgs, so a blind subquery
    // here would hide the row again for every MSP-scoped tech.
    expect(partnerVisible.ids).toContain(partnerIds.shortLinkChildWithCapacity);

    // The badge half, read off the partner-scope payload: the token aggregate
    // must survive the wider RLS context too, or the row would badge Expired
    // while the filter kept it visible.
    expect(badgeReadsActiveFromTokens(partnerVisible.tokens.get(partnerIds.liveToken))).toBe(
      true,
    );
  });

  // The subquery correlates ONLY on parent_enrollment_key_id — its tenant
  // safety is entirely RLS's job. A token stamped with a FOREIGN org must not
  // resurrect another tenant's expired key.
  runDb('a foreign-org token cannot keep a key visible', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const env = await setupTestEnvironment({ scope: 'organization' });
    const otherEnv = await setupTestEnvironment({ scope: 'organization' });

    const keyId = await seedKey({
      orgId: env.organization.id,
      siteId: env.site.id,
      unique: `${unique}-foreign`,
    });
    await attachToken(keyId, {
      orgId: otherEnv.organization.id,
      siteId: otherEnv.site.id,
      unique: `${unique}-foreign-token`,
      expiresAt: LIVE_UNTIL(),
      maxUsage: 5,
      consumedCount: 0,
      usageKind: "capacity",
    });

    const visible = await listKeys(env.token, 'false');
    expect(visible.ids).not.toContain(keyId);
  });

  runDb('(g) expired=true is the exact complement of expired=false', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const env = await setupTestEnvironment({ scope: 'organization' });
    const ids = await seedMatrix(env, unique);
    const all = Object.values(ids);

    const visible = await listKeys(env.token, 'false');
    const expired = await listKeys(env.token, 'true');

    // Partition: every seeded key in exactly one bucket, none in both, none in
    // neither. An API-contract property, not a UI one — the web client only
    // ever sends `expired=false` — but a key matched by neither predicate would
    // be unreachable for any consumer that does use both.
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
