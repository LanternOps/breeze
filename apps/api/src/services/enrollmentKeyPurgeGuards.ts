/**
 * Shared purge guards for `enrollment_keys`.
 *
 * There are TWO code paths that hard-delete expired enrollment keys, and they
 * must agree on what "safe to delete" means:
 *
 *   1. `jobs/enrollmentKeyCleanup.ts` — the nightly system-wide sweep, which
 *      only touches keys that expired more than `ENROLLMENT_KEY_PURGE_AFTER_DAYS`
 *      days ago (default 7).
 *   2. `routes/enrollmentKeys.ts` — `POST /enrollment-keys/purge-expired`, the
 *      on-demand tenant-scoped counterpart behind the web UI's "Delete expired"
 *      button, which has NO grace period: a key is eligible the instant it
 *      expires.
 *
 * The exemption below started life inside (1) for #2775 and was missed on (2)
 * for #2832 — the route was in fact the *faster* path to the same data loss
 * (60-minute parent expiry + one click, vs. 7 days). It lives here so a future
 * change to the predicate cannot land on one path and skip the other.
 */

import { and, eq, gt, lt, notExists, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { enrollmentKeys, installerBootstrapTokens } from '../db/schema';

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
  notExists(
    dbModule.db
      .select({ one: sql`1` })
      .from(installerBootstrapTokens)
      .where(
        and(
          eq(installerBootstrapTokens.parentEnrollmentKeyId, enrollmentKeys.id),
          gt(installerBootstrapTokens.expiresAt, new Date()),
          lt(installerBootstrapTokens.consumedCount, installerBootstrapTokens.maxUsage),
        ),
      ),
  );
