import { db } from '../db';
import { eq } from 'drizzle-orm';
import { enrollmentKeys } from '../db/schema/orgs';
import { installerBootstrapTokens } from '../db/schema/installerBootstrapTokens';
import {
  generateBootstrapToken,
  bootstrapTokenExpiresAt,
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
   * Absolute lifetime for this token, in minutes, as chosen by the admin in
   * the Add Device modal. Omitted → the 24h base from bootstrapTokenExpiresAt().
   * Bounds are enforced upstream by the route Zod schemas (1..525_600) AND,
   * as of fix round 3 (#2776), by a partner-cap clamp inside this function
   * (see below) — the schema bound alone says nothing about a partner's
   * OWN configured ceiling, which can be lower.
   */
  ttlMinutes?: number;
}

export interface IssuedBootstrapToken {
  id: string;
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
 *  - rejecting (400) an explicitly-chosen over-cap ttlMinutes BEFORE calling
 *    this (via assertTtlWithinCap) when there's an interactive caller to
 *    tell. This function only CLAMPS a defensive bound (never rejects) —
 *    see the cap comment below.
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
    .limit(1);
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
  const rawExpiresAt = input.ttlMinutes !== undefined
    ? new Date(Date.now() + input.ttlMinutes * 60 * 1000)
    : bootstrapTokenExpiresAt();

  // Defensive partner-cap bound (fix round 3, #2776) — a CLAMP, not a
  // rejection, deliberately: this function has no HTTP request to reject
  // with a 400, and by design it "delegates to its callers" for validation
  // (see the class doc above), which is exactly the contract that let one
  // caller slip through uncapped. Two of the three current callers
  // (POST /:id/bootstrap-token and the installer-link/installer-download
  // Windows paths) already reject an over-cap explicit ttlMinutes upstream
  // via assertTtlWithinCap, so for them this is a same-value no-op. The
  // THIRD caller — serveInstaller's UNAUTHENTICATED public-download / short-
  // link path — passes no ttlMinutes at all and had no cap consult anywhere
  // in its call chain before this fix, so the 24h bootstrapTokenExpiresAt()
  // base could exceed a partner's configured (lower) cap. Bounding it HERE,
  // once, means the contract stops depending on every future caller
  // remembering to check the cap itself.
  //
  // Pass `rawExpiresAt` through VERBATIM when the cap does not bind (fix
  // round 4, #2776).
  //
  // What the round-3 code actually did — the round-3 comment described this
  // backwards, claiming `Math.ceil` produced 1441 minutes. It cannot: the
  // quotient here is `requestedMinutes - elapsed/60000`, where `elapsed` is
  // the time between building `rawExpiresAt` and re-reading the clock on the
  // next line. That is strictly LESS than the requested minutes, so `ceil`
  // lands back on exactly 1440 and never above it. The real defect was the
  // unconditional REBUILD on the line after: `new Date(Date.now() + ...)` reads
  // the clock a third time, so the reconstructed expiry sat a few
  // MILLISECONDS past `rawExpiresAt`. Tiny, but it is drift in the lengthening
  // direction inside the function whose job is to bound lifetimes, and it
  // accumulated nowhere-visible. Keeping `rawExpiresAt` when the cap is
  // non-binding removes the round trip entirely, so there is no drift of
  // either sign.
  //
  // `floor` (with a 1-minute floor for sub-minute requests) rather than `ceil`
  // so the minute-quantised value handed to the cap never rounds a request UP
  // past what was asked for.
  //
  // KNOWN BOUNDARY (not a bug worth behaviour-changing, but do not claim the
  // clamp "only rewrites downwards"): because `rawTtlMinutes` floors, a cap
  // sitting exactly one minute below the request is NON-binding. Cap 1439 with
  // a 1440-minute request floors to 1439, `clampTtlToCap` returns 1439, the
  // `>=` test passes, and the token is issued at the full 1440 — up to 60
  // seconds OVER the cap. Bounded at <1 minute and irrelevant against the
  // hour-scale caps this feature exists for; the alternative (rebuilding from
  // the capped minutes) reintroduces the millisecond drift above on every
  // single issue, which is the worse trade.
  const rawTtlMinutes = Math.max(1, Math.floor((rawExpiresAt.getTime() - Date.now()) / 60_000));
  const cappedTtlMinutes = await clampTtlToCap(parent.orgId, rawTtlMinutes);
  const expiresAt = cappedTtlMinutes >= rawTtlMinutes
    ? rawExpiresAt
    : new Date(Date.now() + cappedTtlMinutes * 60 * 1000);

  const [row] = await db.insert(installerBootstrapTokens).values({
    token,
    orgId: parent.orgId,
    parentEnrollmentKeyId: parent.id,
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
