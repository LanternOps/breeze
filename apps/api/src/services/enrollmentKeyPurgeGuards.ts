/**
 * Shared "is this key still backed by a live installer?" predicate for
 * `enrollment_keys`.
 *
 * THREE code paths ask that question, and they must all answer it the same way:
 *
 *   1. `jobs/enrollmentKeyCleanup.ts` — the nightly system-wide sweep, which
 *      only touches keys that expired more than `ENROLLMENT_KEY_PURGE_AFTER_DAYS`
 *      days ago (default 7).
 *   2. `routes/enrollmentKeys.ts` — `POST /enrollment-keys/purge-expired`, the
 *      on-demand tenant-scoped counterpart behind the web UI's "Delete expired"
 *      button, which has NO grace period: a key is eligible the instant it
 *      expires.
 *   3. `routes/enrollmentKeys.ts` — the `GET /enrollment-keys?expired=` filter
 *      behind the web UI's "Hide expired" toggle (#3191). Not a delete path, so
 *      the failure mode is inverted: instead of destroying a live installer it
 *      HID one, because the filter tested the parent's `expires_at` alone while
 *      the row's status badge had already been taught (#3039, PR #3045) to derive status
 *      from live token counts. The toggle hid rows it was itself rendering
 *      "Active".
 *
 * The exemption below started life inside (1) for #2775, was missed on (2) for
 * #2832 — the route was in fact the *faster* path to the same data loss
 * (60-minute parent expiry + one click, vs. 7 days) — and was missed again on
 * (3) for #3191. It lives here so a future change to the predicate cannot land
 * on one path and skip the others.
 */

import { and, eq, exists, gt, lt, notExists, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { enrollmentKeys, installerBootstrapTokens } from '../db/schema';
import { CAPACITY_USAGE_KIND } from '../db/schema/installerBootstrapTokens';

/**
 * Single definition of the correlated subquery every exported guard wraps: the
 * `installer_bootstrap_tokens` rows pointing at the outer `enrollmentKeys` row
 * that are still redeemable — `expires_at` in the future AND
 * `consumed_count < max_usage`.
 *
 * `capacityOnly` additionally restricts to `usage_kind = 'capacity'` (#3034).
 * The two scopes are NOT interchangeable, and which one a caller wants follows
 * from what it does with the answer:
 *
 *   - DELETE paths (the nightly sweep and `purge-expired`) pass `false` and
 *     consider tokens of EVERY kind, including `per_download` and
 *     `legacy_unknown`. Deleting a key destroys every outstanding token under it
 *     via ON DELETE CASCADE, which is irreversible, so this side stays maximally
 *     conservative — a per-download token is still a working installer somebody
 *     downloaded, and a `legacy_unknown` token is one whose provenance we simply
 *     never recorded. Neither is a licence to delete it.
 *   - The `?expired=` LIST FILTER passes `true`, because its job is to agree
 *     with the row's status badge, and the badge is derived from
 *     `installerTokens` — which `fetchInstallerTokenUsage` computes over
 *     capacity tokens alone. A filter reading a wider set than the badge is
 *     exactly the #3191 contradiction ("Hide expired" hiding a row it renders
 *     "Active"), just in the opposite direction.
 *
 * The residual disagreement is therefore always in the SAFE direction: the list
 * may call a per-download-only key dead while the purge still spares it. Never
 * the reverse.
 *
 * Built fresh per call, never hoisted to a module constant, for TWO reasons —
 * the first is a correctness one:
 *
 *   1. it binds `new Date()` (below). A module constant would freeze "now" at
 *      process boot, so a long-lived API process would judge every token
 *      against a stale clock — silently sparing keys from the purge forever
 *      and silently keeping dead keys visible in the list filter.
 *   2. it must read `dbModule.db` at call time — see the `vi.mock('../db')`
 *      note below.
 *
 * Anyone making this lazy behind a `db` getter satisfies (2) and reintroduces
 * (1). Keep both.
 */
const liveUnexhaustedBootstrapTokenSubquery = (capacityOnly: boolean) =>
  dbModule.db
    .select({ one: sql`1` })
    .from(installerBootstrapTokens)
    .where(
      and(
        eq(installerBootstrapTokens.parentEnrollmentKeyId, enrollmentKeys.id),
        gt(installerBootstrapTokens.expiresAt, new Date()),
        lt(installerBootstrapTokens.consumedCount, installerBootstrapTokens.maxUsage),
        ...(capacityOnly
          ? [eq(installerBootstrapTokens.usageKind, CAPACITY_USAGE_KIND)]
          : []),
      ),
    );

/**
 * Correlated NOT EXISTS guard (#2775, #2832): evaluates true — i.e. the outer
 * `enrollmentKeys` row is eligible for the purge — only when NO
 * `installer_bootstrap_tokens` row still points at it with both `expires_at`
 * in the future AND `consumed_count < max_usage` (a "live, unexhausted"
 * token). When such a token does exist this evaluates false, the AND'd outer
 * WHERE excludes the key, and it survives to a later purge once its last token
 * has expired or been fully consumed.
 *
 * Why the guard is needed at all: the Add Device modal's parent enrollment key
 * is a deliberately transient 60-minute container (PR #739 review finding #1),
 * while the `installer_bootstrap_tokens` row minted from it carries its OWN
 * independent TTL of up to a year — `routes/installer.ts` no longer clamps the
 * child to the parent's expiry. `installer_bootstrap_tokens.parent_enrollment_key_id`
 * is `ON DELETE CASCADE`, so purging that long-dead parent would silently
 * destroy an admin's still-valid 30-day/1-year installer link; redemption then
 * lands on the `no_row` branch in `routes/installer.ts` and the installer 404s.
 *
 * RLS note (route path): the subquery is evaluated inside whatever DB access
 * context the caller is running in, so on the request path it only sees
 * bootstrap tokens the caller's tenant context permits. That is safe rather
 * than a hole because `installerBootstrapTokenIssuance.ts` always stamps the
 * token with `orgId: parent.orgId` — a token is visible exactly when its
 * parent key is, so the guard can never be blinded to a token attached to a
 * key the caller is able to delete.
 *
 * Uses `dbModule.db` at call time (not a destructured import) so unit suites
 * that `vi.mock('../db')` see their stub. Matches the `exists`/`notExists`
 * correlated-subquery idiom in `services/vulnerabilityCorrelation.ts`.
 */
export const hasNoLiveUnexhaustedBootstrapToken = () =>
  notExists(liveUnexhaustedBootstrapTokenSubquery(false));

/**
 * CAPACITY-SCOPED pair, used by the `GET /enrollment-keys?expired=` filter
 * (#3191, rescoped by #3034). True when the outer `enrollmentKeys` row is still
 * backed by a live, unexhausted token whose `max_usage` is a real device-slot
 * budget.
 *
 * `hasLiveUnexhaustedCapacityToken` keeps such a key VISIBLE past its parent's
 * expiry; `hasNoLiveUnexhaustedCapacityToken` is its De Morgan complement for
 * the `?expired=true` branch. Both come from the ONE subquery builder above, so
 * the two branches of the filter cannot drift into overlapping or leaving a gap:
 *
 *   expired=true   →  parentExpired    AND NOT EXISTS(live capacity token)
 *   expired=false  →  parentNotExpired  OR     EXISTS(live capacity token)
 *
 * These replace the previous arrangement, where the filter used the all-token
 * guard and bolted an `isNull/isNotNull(short_code)` gate beside it to mirror
 * the read route's per-key suppression. That mirror is gone because the
 * suppression is gone: the discriminator now lives on the token, so the filter
 * can ask the same question the badge asks, directly.
 *
 * Agrees with the UI badge's `liveConsumed < liveMax` test (see
 * `InstallerTokenUsage` in `routes/enrollmentKeys.ts`) because per-token
 * `consumed_count` never exceeds `max_usage`, so a positive sum difference and
 * a per-row EXISTS pick out the same keys — and both are now computed over the
 * same capacity-only token set. That premise has NO DB CHECK behind it — it is
 * upheld by the conditional `consumed_count < max_usage` UPDATE in
 * `routes/installer.ts`; a second write path to that column would have to
 * preserve it. Two lesser seams, both benign on a read filter: the sums use
 * Postgres `now()` while this binds the API process clock, and the badge
 * additionally requires `max > 0` before it consults the live pair at all.
 */
export const hasLiveUnexhaustedCapacityToken = () =>
  exists(liveUnexhaustedBootstrapTokenSubquery(true));

export const hasNoLiveUnexhaustedCapacityToken = () =>
  notExists(liveUnexhaustedBootstrapTokenSubquery(true));
