import { db } from '../db';
import { eq } from 'drizzle-orm';
import { enrollmentKeys } from '../db/schema/orgs';
import { installerBootstrapTokens } from '../db/schema/installerBootstrapTokens';
import {
  generateBootstrapToken,
  bootstrapTokenTtlMinutes,
  clampBootstrapTokenTtlMinutes,
  hashBootstrapToken,
} from './installerBootstrapToken';
import { clampTtlToCap } from './enrollmentDefaults';

/**
 * What the `maxUsage` on a minted token MEANS (#3034) — see the `usageKind`
 * column docblock in `db/schema/installerBootstrapTokens.ts`.
 *
 * `legacy_unknown` is deliberately NOT assignable: it is a backfill/DEFAULT
 * value for rows whose mint path was never recorded, and no new token may claim
 * that it doesn't know its own provenance.
 */
export type BootstrapTokenUsageKind = "capacity" | "per_download";

export interface IssueBootstrapTokenInput {
  parentEnrollmentKeyId: string;
  /**
   * Creator user id, or null when the token is issued by an unauthenticated
   * path (e.g. the public /s/:code short-link installer download) whose parent
   * enrollment key may itself have no recorded creator. The created_by column
   * is a nullable uuid FK — pass null, never an empty string (an empty string
   * fails the uuid cast: `invalid input syntax for type uuid: ""`).
   */
  createdByUserId: string | null;
  /**
   * REQUIRED, and deliberately has no default (#3034). `maxUsage` alone is
   * ambiguous — the same integer is a device-slot budget on the authenticated
   * paths and a per-click constant on the public download path — and the read
   * side has no way to recover the difference after the fact. Forcing every
   * call site to state it is what stops a future mint path from silently
   * inheriting the wrong meaning, which is exactly how the `short_code` proxy
   * this replaces became wrong in both directions.
   */
  usageKind: BootstrapTokenUsageKind;
  maxUsage?: number;
  installerPlatform?: "windows" | "macos";
  /**
   * Absolute lifetime for this token, in minutes: the admin's pick in the
   * Add Device modal, or an installer link's remaining lifetime. Omitted →
   * the configured base from bootstrapTokenTtlMinutes() (7 days by default).
   * Interactive routes reject a pick above MAX_BOOTSTRAP_TOKEN_TTL_MINUTES
   * (30 days) or the partner cap with a 400 before calling this; inside this
   * function both are applied again as clamps (see below) — the schema bound
   * alone says nothing about a partner's OWN configured ceiling, which can be
   * lower.
   */
  ttlMinutes?: number;
}

export interface IssuedBootstrapToken {
  id: string;
  /**
   * The raw token. This return value is the ONLY place it exists — the row
   * stores just its keyed hash — so every caller must build the installer
   * (MSI filename, app bundle name, response body) from this value. A later
   * download cannot re-read it; it mints a new token instead.
   */
  token: string;
  expiresAt: Date;
  parentKeyName: string;
}

export class BootstrapTokenIssuanceError extends Error {
  constructor(public code: 'parent_not_found' | 'parent_expired' | 'parent_exhausted', message: string) {
    super(message);
    this.name = 'BootstrapTokenIssuanceError';
  }
}

/**
 * Issues a single-use bootstrap token tied to an existing parent enrollment
 * key. Used by both the standalone POST /enrollment-keys/:id/bootstrap-token
 * route AND the macOS installer download route — they were two duplicate
 * code paths in Plan A; this helper unifies them.
 *
 * Caller is responsible for:
 *  - access control (ensureOrgAccess on parentKey.orgId)
 *  - audit logging
 *  - rejecting (400) an explicitly-chosen ttlMinutes above the partner cap
 *    (assertTtlWithinCap) or above MAX_BOOTSTRAP_TOKEN_TTL_MINUTES BEFORE
 *    calling this, when there's an interactive caller to tell. This function
 *    only CLAMPS defensive bounds (never rejects) — see the comment below.
 *
 * Throws BootstrapTokenIssuanceError on parent-key validation failures so
 * the caller can map to its own HTTP shape.
 */
export async function issueBootstrapTokenForKey(
  input: IssueBootstrapTokenInput,
): Promise<IssuedBootstrapToken> {
  const [parent] = await db
    .select()
    .from(enrollmentKeys)
    .where(eq(enrollmentKeys.id, input.parentEnrollmentKeyId))
    .limit(1)
    // Rotation takes an UPDATE lock on this row. Holding SHARE through the
    // token INSERT makes issue-vs-rotate linearizable: either this token is
    // committed in the old epoch before rotation, or it snapshots the new one.
    .for('share');
  if (!parent) {
    throw new BootstrapTokenIssuanceError('parent_not_found', 'Enrollment key not found');
  }
  if (parent.expiresAt && new Date(parent.expiresAt) < new Date()) {
    throw new BootstrapTokenIssuanceError('parent_expired', 'Enrollment key has expired');
  }
  if (parent.maxUsage !== null && parent.usageCount >= parent.maxUsage) {
    throw new BootstrapTokenIssuanceError('parent_exhausted', 'Enrollment key usage exhausted');
  }

  const token = generateBootstrapToken();
  // The token gets a fresh, independent lifetime — it is NOT bounded by the
  // parent's remaining life. The parent created by the Add Device modal is a
  // deliberately transient 60-minute container (PR #739 review finding #1),
  // so capping to it made every installer die in an hour whatever the admin
  // picked (#2775). This mirrors the identical correction already made for
  // child enrollment keys — see CHILD_ENROLLMENT_KEY_TTL_MINUTES in
  // routes/enrollmentKeys.ts.
  //
  // Revocation does NOT depend on this cap: installer_bootstrap_tokens
  // .parent_enrollment_key_id is ON DELETE CASCADE, so deleting the parent
  // key still destroys every outstanding token immediately.
  //
  // Freshness at ISSUE time is still enforced by the caller via
  // parentKeyTooCloseToExpiry().
  //
  // ONE clamp site for the lifetime, in whole minutes: the caller's ttlMinutes
  // (an admin's pick, or an installer link's remaining life) or the configured
  // base, bounded to [1, MAX_BOOTSTRAP_TOKEN_TTL_MINUTES] (30 days). The
  // interactive routes already 400 an explicit pick above the maximum, so for
  // them this is a no-op; it binds for derived lifetimes, and keeps a
  // degenerate value (0, NaN) from producing an expired or Invalid Date.
  //
  // Then the partner-cap bound (fix round 3, #2776) — a CLAMP, not a
  // rejection, deliberately: this function has no HTTP request to reject
  // with a 400, and by design it "delegates to its callers" for validation
  // (see the doc above), which is exactly the contract that let one caller
  // slip through uncapped. The interactive callers (POST /:id/bootstrap-token
  // and the installer-download Windows/macOS paths) already reject an
  // over-cap explicit ttlMinutes upstream via assertTtlWithinCap, so for them
  // this is a same-value no-op. serveInstaller's UNAUTHENTICATED
  // public-download / short-link path passes a derived lifetime (or none) and
  // has no cap consult elsewhere in its call chain; bounding it HERE, once,
  // means the contract stops depending on every future caller remembering to
  // check the cap itself.
  //
  // The expiry is built from minutes with a single clock read after both
  // bounds, so the stored value is exactly the bounded lifetime — no
  // Date -> minutes -> Date round trip to drift or to let a cap one minute
  // below the request slip past.
  const requestedTtlMinutes = clampBootstrapTokenTtlMinutes(
    input.ttlMinutes ?? bootstrapTokenTtlMinutes(),
  );
  const ttlMinutes = await clampTtlToCap(parent.orgId, requestedTtlMinutes);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  // Only the keyed hash is persisted; the raw token is returned to the caller
  // exactly once, to be written into the installer it is serving. The legacy
  // plaintext `token` column is left NULL.
  const [row] = await db.insert(installerBootstrapTokens).values({
    tokenHash: hashBootstrapToken(token),
    orgId: parent.orgId,
    parentEnrollmentKeyId: parent.id,
    parentCredentialGeneration: parent.credentialGeneration,
    siteId: parent.siteId,
    maxUsage: input.maxUsage ?? 1,
    usageKind: input.usageKind,
    createdBy: input.createdByUserId,
    expiresAt,
    installerPlatform: input.installerPlatform ?? "macos",
  }).returning();
  if (!row) {
    throw new Error('installerBootstrapTokens insert returned no row');
  }

  return { id: row.id, token, expiresAt, parentKeyName: parent.name };
}
