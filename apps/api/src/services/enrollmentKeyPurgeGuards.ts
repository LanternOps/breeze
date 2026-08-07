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

/**
 * Single definition of the correlated subquery both exported guards wrap: the
 * `installer_bootstrap_tokens` rows pointing at the outer `enrollmentKeys` row
 * that are still redeemable — `expires_at` in the future AND
 * `consumed_count < max_usage`.
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
const liveUnexhaustedBootstrapTokenSubquery = () =>
  dbModule.db
    .select({ one: sql`1` })
    .from(installerBootstrapTokens)
    .where(
      and(
        eq(installerBootstrapTokens.parentEnrollmentKeyId, enrollmentKeys.id),
        gt(installerBootstrapTokens.expiresAt, new Date()),
        lt(installerBootstrapTokens.consumedCount, installerBootstrapTokens.maxUsage),
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
  notExists(liveUnexhaustedBootstrapTokenSubquery());

/**
 * The same correlated subquery in its POSITIVE form: true when the outer
 * `enrollmentKeys` row IS still backed by a live, unexhausted installer token.
 *
 * Used by the `GET /enrollment-keys?expired=false` filter (#3191) to keep such
 * a key VISIBLE past its parent's expiry, which is the same fact the purge
 * guard uses to keep it ALIVE past its parent's expiry. Derived from the one
 * subquery builder rather than restated so the two can never drift into
 * disagreeing about which keys are still backed by an installer — "Hide
 * expired" hiding a row that "Delete expired" deliberately refuses to delete is
 * exactly the contradiction #3191 reported.
 *
 * Agrees with the UI badge's `liveConsumed < liveMax` test (see
 * `InstallerTokenUsage` in `routes/enrollmentKeys.ts`) because per-token
 * `consumed_count` never exceeds `max_usage`, so a positive sum difference and
 * a per-row EXISTS pick out the same keys. That premise has NO DB CHECK behind
 * it — it is upheld by the conditional `consumed_count < max_usage` UPDATE in
 * `routes/installer.ts`; a second write path to that column would have to
 * preserve it. Two lesser seams, both benign on a read filter: the sums use
 * Postgres `now()` while this binds the API process clock, and the badge
 * additionally requires `max > 0` (a sum over ALL tokens) before it consults
 * the live pair at all.
 */
export const hasLiveUnexhaustedBootstrapToken = () =>
  exists(liveUnexhaustedBootstrapTokenSubquery());
