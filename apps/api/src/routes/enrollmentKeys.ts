import { Hono } from "hono";
import type { Context } from "hono";
import { zValidator } from '../lib/validation';
import { z } from "zod";
import { and, eq, ne, sql, desc, inArray, lt, isNull, isNotNull, or, asc } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { db, withSystemDbAccessContext } from "../db";
import { enrollmentKeys, organizations } from "../db/schema";
import { sites } from "../db/schema/orgs";
import {
  installerBootstrapTokens,
  CAPACITY_USAGE_KIND,
} from "../db/schema/installerBootstrapTokens";
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
  type AuthContext,
} from "../middleware/auth";
import { userRateLimit } from "../middleware/userRateLimit";
import { randomBytes } from "crypto";
import { createAuditLogAsync } from "../services/auditService";
import { ANONYMOUS_ACTOR_ID } from "../services/auditEvents";
import { PERMISSIONS } from "../services/permissions";
import { hashEnrollmentKey, hashEnrollmentKeyCandidates } from "../services/enrollmentKeySecurity";
import {
  getTrustedClientIp,
  getTrustedClientIpOrUndefined,
  rateLimitIpKey,
} from "../services/clientIp";
import {
  buildMacosInstallerZip,
  fetchRegularMsi,
  assertMacosInstallerPkgsReachable,
  fetchMacosInstallerAppZip,
  serveWindowsBootstrapMsi,
} from "../services/installerBuilder";
import { renameAppInZip } from "../services/installerAppZip";
import {
  InstallerFilenameHostError,
  macosBundleApiHost,
  windowsFilenameApiHost,
} from "../services/installerFilenameHost";
import {
  issueBootstrapTokenForKey,
  BootstrapTokenIssuanceError,
} from "../services/installerBootstrapTokenIssuance";
import { assertTtlWithinCap, clampTtlToCap } from "../services/enrollmentDefaults";
import { getDefaultEnrollmentKeyTtlMinutes } from "../services/enrollmentKeyTtlDefault";
import {
  hasLiveUnexhaustedCapacityToken,
  hasNoLiveUnexhaustedCapacityToken,
  hasNoLiveUnexhaustedBootstrapToken,
} from "../services/enrollmentKeyPurgeGuards";
import { captureException } from "../services/sentry";

// ============================================================
// Signing-spend caps for the authenticated installer endpoint.
// These bound how many costly MSI-sign / child-key operations
// a single user or a single parent enrollment key can trigger.
// ============================================================

/** Max authenticated installer-signing requests per user per hour. */
const INSTALLER_SIGN_USER_LIMIT = 10;
/** Max authenticated installer-signing requests per parent enrollment key per hour. */
const INSTALLER_SIGN_KEY_LIMIT = 30;
/** Sliding window (seconds) for both authenticated signing-spend caps. */
const INSTALLER_SIGN_WINDOW_SECONDS = 60 * 60; // 1 hour

/**
 * Narrow `Buffer | null` to `Buffer`, throwing an actionable error when
 * null. Replaces non-null assertions so a future code change that adds a
 * new platform without updating the fetch site produces a clear error
 * instead of an opaque `Cannot read property of null` deep inside the
 * installer-builder functions.
 */
function ensureBuffer(buf: Buffer | null, context: string): Buffer {
  if (!buf) {
    throw new Error(`Internal error: binary buffer not fetched (${context})`);
  }
  return buf;
}

export const enrollmentKeyRoutes = new Hono();

// ============================================
// Helper Functions
// ============================================

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

// 30 days by default: techs stage installers through deploy tooling and expect
// them to keep working well past the download day. Must stay in step with
// PRODUCT_DEFAULT_ENROLLMENT_TTL_MINUTES (packages/shared enrollmentDefaults).
//
// Sourced from the shared enrollmentKeyTtlDefault.ts (#4126 follow-up) so the
// Partner-API provisioning route (services/enrollmentKeySecurity.ts) and the
// installer child-key redemption route (routes/installer.ts) can never drift
// from this route's fallback again — both used to hard-code their own
// (smaller) numbers.
const DEFAULT_ENROLLMENT_KEY_TTL_MINUTES = getDefaultEnrollmentKeyTtlMinutes();

// Child enrollment keys (installer downloads, installer-link downloads, and
// short-link redemptions) get a fresh, independent TTL rather than inheriting
// the parent's remaining lifetime. The previous "inherit parentKey.expiresAt"
// behaviour made installers DOA whenever the parent was near expiry at
// download time — a minute-59 download against a 60-minute parent produced a
// child good for only 60 seconds. 30 days by default, overridable.
const CHILD_ENROLLMENT_KEY_TTL_MINUTES = envInt(
  "CHILD_ENROLLMENT_KEY_TTL_MINUTES",
  60 * 24 * 30,
);

// Parent keys that are within this window of expiry are refused as installer
// sources. Prevents a race where the admin-side parent is already live on
// this side of the API but the install on a remote device fires 30 seconds
// later, after the parent expired.
const INSTALLER_PARENT_MIN_REMAINING_SECONDS = envInt(
  "INSTALLER_PARENT_MIN_REMAINING_SECONDS",
  60,
);

function generateEnrollmentKey(): string {
  return randomBytes(32).toString("hex"); // 64-char hex string
}

/**
 * Fresh absolute expiry for a child enrollment key, measured from *now*
 * (mint time), independent of the parent's remaining lifetime. This is the
 * #410/#413/#414 anti-DOA property: a child minted from a near-expiry parent
 * still gets a full window. `ttlMinutes`, when supplied, is the admin's
 * per-link choice from the Add Device modal; absent it, the deployment
 * default applies.
 */
function freshChildExpiresAt(ttlMinutes?: number): Date {
  const minutes = ttlMinutes ?? CHILD_ENROLLMENT_KEY_TTL_MINUTES;
  return new Date(Date.now() + minutes * 60 * 1000);
}

/**
 * Guard against building an installer from a parent key whose remaining
 * lifetime is so short the child would already be dead by the time the
 * installer reaches the target machine. Callers that hit this should
 * surface the returned error directly.
 */
function parentKeyTooCloseToExpiry(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  const remainingMs = expiresAt.getTime() - Date.now();
  return remainingMs < INSTALLER_PARENT_MIN_REMAINING_SECONDS * 1000;
}

/**
 * Bootstrap-token TTL derived from an installer link's remaining lifetime
 * (#3038). A Windows MSI downloaded from a share link embeds a bootstrap
 * token, and that token — not the link — is what the eventual install
 * redeems. Minting it with the 24h base while the link the admin configured
 * lives for 30 days silently discards the admin's expiry choice: installs
 * from a day-1 download die after hour 24 with an unexplained 404 (the same
 * silent-discard trap as #2775, resurfaced on the download path).
 *
 * So: the token inherits the link's remaining lifetime at download time —
 * never MORE than the link has left (floored to minutes, minimum 1 so the
 * `expires_at > created_at` CHECK on installer_bootstrap_tokens always
 * holds), and clamped to the partner's `maxEnrollmentLinkTtlMinutes` cap
 * inside issueBootstrapTokenForKey. A link with no expiry returns undefined
 * → the conservative 24h base, NOT an unbounded token.
 */
function installerLinkRemainingTtlMinutes(
  linkExpiresAt: Date | null,
): number | undefined {
  if (!linkExpiresAt) return undefined;
  const remainingMinutes = Math.floor(
    (linkExpiresAt.getTime() - Date.now()) / 60_000,
  );
  return Math.max(1, remainingMinutes);
}

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(query.limit ?? "50", 10) || 50),
  );
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(
  orgId: string,
  auth: Pick<
    AuthContext,
    "scope" | "orgId" | "accessibleOrgIds" | "canAccessOrg"
  >,
) {
  if (auth.scope === "organization") {
    return auth.orgId === orgId;
  }
  if (auth.scope === "partner") {
    return auth.canAccessOrg(orgId);
  }
  return true;
}

function writeEnrollmentKeyAudit(
  c: any,
  auth: { user: { id: string; email?: string } },
  event: {
    orgId: string;
    action: string;
    keyId?: string;
    keyName?: string;
    details?: Record<string, unknown>;
  },
): void {
  createAuditLogAsync({
    orgId: event.orgId,
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: event.action,
    resourceType: "enrollment_key",
    resourceId: event.keyId,
    resourceName: event.keyName,
    details: event.details,
    ipAddress: getTrustedClientIpOrUndefined(c),
    userAgent: c.req.header("user-agent"),
    result: "success",
  });
}

// fetchRegularMsi and the macOS installer helpers live in installerBuilder.ts

const shortCodeAlphabet =
  "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
const generateShortCode = customAlphabet(shortCodeAlphabet, 10);

export async function allocateShortCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateShortCode();
    const [existing] = await db
      .select({ id: enrollmentKeys.id })
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.shortCode, code))
      .limit(1);
    if (!existing) return code;
  }
  throw new Error("Failed to allocate unique short code after 5 attempts");
}

// ============================================
// Short-code redemption (used by /i/ invite landing + download routes)
// ============================================

export interface PeekedShortCode {
  /** Parent short-link row id (enrollmentKeys.id whose shortCode matched). */
  id: string;
  orgId: string;
  siteId: string;
}

export interface RedeemedShortCode {
  /** Id of the freshly minted single-use child enrollment key. */
  id: string;
  /** Parent short-link row id (enrollmentKeys.id whose shortCode matched). */
  parentId: string;
  /** Owning org of the child key (matches the parent). */
  orgId: string;
  /** Site id baked into the installer. */
  siteId: string;
  /** Raw enrollment token (plaintext) to embed in the installer. Never stored. */
  rawKey: string;
  /** Optional pre-shared secret hash if configured on the parent. */
  keySecretHash: string | null;
}

/**
 * Look up a short code without consuming a slot. Used by the `/i/:shortCode`
 * landing page so loading the page doesn't burn a use. Returns the parent
 * row id + org/site for joins (e.g. marking `deployment_invites.clickedAt`).
 * Returns `null` for unknown / expired codes.
 */
export async function peekShortCode(
  shortCode: string,
): Promise<PeekedShortCode | null> {
  if (!shortCode || shortCode.length > 12) return null;
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({
        id: enrollmentKeys.id,
        orgId: enrollmentKeys.orgId,
        siteId: enrollmentKeys.siteId,
        expiresAt: enrollmentKeys.expiresAt,
        maxUsage: enrollmentKeys.maxUsage,
        usageCount: enrollmentKeys.usageCount,
      })
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.shortCode, shortCode))
      .limit(1);
    if (!row) return null;
    if (!row.orgId || !row.siteId) return null;
    if (row.expiresAt && new Date(row.expiresAt) < new Date()) return null;
    if (row.maxUsage !== null && row.usageCount >= row.maxUsage) return null;
    return { id: row.id, orgId: row.orgId, siteId: row.siteId };
  });
}

/**
 * Redeem a short code: look up the parent short-link row, validate it's
 * still claimable (not expired, under maxUsage), mint a fresh single-use
 * child enrollment key, and atomically claim a slot on the parent.
 *
 * Returns `null` for any failure case (unknown code, expired, used up),
 * matching the "just 404 it" posture of the landing page. Callers that
 * want to distinguish reasons should use {@link publicShortLinkRoutes}
 * directly.
 *
 * Unlike the `/s/:code` path, this does NOT require the parent row to
 * have `installerPlatform` set — MCP-invite short codes are OS-agnostic
 * and the `/i/` landing page lets the recipient pick their OS.
 */
export async function redeemShortCode(
  shortCode: string,
): Promise<RedeemedShortCode | null> {
  if (!shortCode || shortCode.length > 12) return null;

  return withSystemDbAccessContext(async () => {
    const [parent] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.shortCode, shortCode))
      .limit(1);

    if (!parent) return null;
    if (parent.expiresAt && new Date(parent.expiresAt) < new Date())
      return null;
    if (!parent.siteId || !parent.orgId) return null;

    const rawKey = generateEnrollmentKey();
    const tokenHash = hashEnrollmentKey(rawKey);
    // Clamp (never reject — no interactive caller here) the child's default
    // TTL to the partner cap (fix round 3, #2776): the cap bounds KEY
    // LIFETIME, not just interactively-chosen input, so this MCP-invite
    // redemption path must not hand out a child key longer-lived than the
    // partner allows just because it uses the server-constant default.
    const cappedTtlMinutes = await clampTtlToCap(parent.orgId, CHILD_ENROLLMENT_KEY_TTL_MINUTES);

    const [child] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: parent.orgId,
        siteId: parent.siteId,
        name: `${parent.name} (invite download)`,
        key: tokenHash,
        keySecretHash: parent.keySecretHash,
        maxUsage: 1,
        expiresAt: freshChildExpiresAt(cappedTtlMinutes),
        createdBy: null,
        installerPlatform: parent.installerPlatform,
      })
      .returning();

    if (!child) return null;

    // Atomic slot claim against the parent. Drop the child if the parent
    // was already at its cap — prevents orphan rows when a popular invite
    // is clicked concurrently.
    const claimed = await db
      .update(enrollmentKeys)
      .set({ usageCount: sql`${enrollmentKeys.usageCount} + 1` })
      .where(
        and(
          eq(enrollmentKeys.id, parent.id),
          parent.maxUsage !== null
            ? lt(enrollmentKeys.usageCount, parent.maxUsage)
            : sql`true`,
        ),
      )
      .returning({ id: enrollmentKeys.id });

    if (claimed.length === 0) {
      await db
        .delete(enrollmentKeys)
        .where(eq(enrollmentKeys.id, child.id))
        .catch(() => {});
      return null;
    }

    return {
      id: child.id,
      parentId: parent.id,
      orgId: parent.orgId,
      siteId: parent.siteId,
      rawKey,
      keySecretHash: parent.keySecretHash,
    };
  });
}

// ============================================
// Child enrollment key helper (used by MCP bootstrap invite flow)
// ============================================

export interface MintChildEnrollmentKeyInput {
  /** Partner id — used to resolve the partner's default org/site if orgId/siteId not supplied. */
  partnerId: string;
  /** Optional explicit org. Defaults to the partner's first organization (by createdAt asc). */
  orgId?: string;
  /** Optional explicit site. Defaults to the org's first site (by createdAt asc). */
  siteId?: string;
  /** Child key TTL. Defaults to CHILD_ENROLLMENT_KEY_TTL_MINUTES. */
  expiresInSeconds?: number;
  /** maxUsage on the child key. Defaults to 1. */
  maxUsage?: number;
  /** Display name suffix for the child key. */
  nameSuffix?: string;
  /** Optional installer platform to persist on the row. */
  installerPlatform?: "windows" | "macos" | null;
}

export interface MintChildEnrollmentKeyResult {
  id: string;
  orgId: string;
  siteId: string;
  shortCode: string;
  rawKey: string;
  expiresAt: Date;
}

/**
 * Mint a single-use (or N-use) child enrollment key, allocate a short-code,
 * and return the raw token + metadata. Used by the MCP bootstrap invite flow
 * (`send_deployment_invites`) but shaped as a general helper so other callers
 * can reuse it without going through the MFA-gated HTTP route.
 *
 * Resolves the partner's default org + site when `orgId` / `siteId` are
 * omitted. Raises when the partner has no org or no site yet — both are
 * guaranteed by `createPartner`, so this path is only hit for pathologically
 * incomplete tenants.
 */
export async function mintChildEnrollmentKey(
  input: MintChildEnrollmentKeyInput,
): Promise<MintChildEnrollmentKeyResult> {
  let orgId = input.orgId;
  if (!orgId) {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      // The hidden 'quick_support' org may be the partner's oldest org — a child
      // enrollment key must never default into it.
      .where(and(eq(organizations.partnerId, input.partnerId), ne(organizations.type, 'quick_support')))
      .orderBy(asc(organizations.createdAt))
      .limit(1);
    if (!org) {
      throw new Error(
        `mintChildEnrollmentKey: partner ${input.partnerId} has no organizations`,
      );
    }
    orgId = org.id;
  }

  // Clamp (never reject — this is a non-interactive helper with no HTTP
  // request to surface a 400 to) the requested lifetime to the partner cap
  // (fix round 3, #2776). This function is an exported, general-purpose
  // helper — its only current caller (send_deployment_invites) hardcodes a
  // 7-day server constant, but leaving the bound here (rather than trusting
  // every caller to remember it) is what stops the next caller that threads
  // a truly dynamic value through `expiresInSeconds` from reopening the
  // exact escalation this whole plan exists to close.
  // FLOOR, not ceil, with a 1-minute floor (fix round 4, #2776): the minute
  // conversion feeds `expiresAt` directly, so rounding UP would LENGTHEN a
  // sub-minute lifetime (90s -> 120s) in the very function this cap exists to
  // bound. Rounding down can only shorten, which is the fail-closed direction;
  // the max(1, ...) keeps a 1-59s request from collapsing to an
  // already-expired key.
  const rawTtlMinutes = Math.max(
    1,
    Math.floor((input.expiresInSeconds ?? CHILD_ENROLLMENT_KEY_TTL_MINUTES * 60) / 60),
  );
  const cappedTtlMinutes = await clampTtlToCap(orgId, rawTtlMinutes);

  let siteId = input.siteId;
  if (!siteId) {
    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.orgId, orgId))
      .orderBy(asc(sites.createdAt))
      .limit(1);
    if (!site) {
      throw new Error(`mintChildEnrollmentKey: org ${orgId} has no sites`);
    }
    siteId = site.id;
  }

  const rawKey = generateEnrollmentKey();
  const keyHash = hashEnrollmentKey(rawKey);
  const shortCode = await allocateShortCode();
  const expiresAt = new Date(Date.now() + cappedTtlMinutes * 60 * 1000);

  const [row] = await db
    .insert(enrollmentKeys)
    .values({
      orgId,
      siteId,
      name: input.nameSuffix ? `mcp-invite ${input.nameSuffix}` : "mcp-invite",
      key: keyHash,
      maxUsage: input.maxUsage ?? 1,
      expiresAt,
      createdBy: null,
      shortCode,
      installerPlatform: input.installerPlatform ?? null,
    })
    .returning();

  if (!row) {
    throw new Error("mintChildEnrollmentKey: insert returned no row");
  }

  return { id: row.id, orgId, siteId, shortCode, rawKey, expiresAt };
}

// ============================================
// Validation Schemas
// ============================================

const listEnrollmentKeysSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().guid().optional(),
  expired: z.enum(["true", "false"]).optional(),
});

// ttlMinutes caps at 525_600 (365 days = 365 * 24 * 60), matching the UI's
// "1 year" option exactly. Caller supplies either ttlMinutes or an explicit
// expiresAt; if both are absent the handler falls back to
// DEFAULT_ENROLLMENT_KEY_TTL_MINUTES. Sending both is rejected so the
// resolved expiry is unambiguous. "Never expires" is not exposed here
// pending the partner-level cap (max ttl) that gates it.
const MAX_TTL_MINUTES = 525_600;

// `.strict()` on every write schema: unknown keys surface as a Zod
// `unrecognized_keys` issue (HTTP 400 via zValidator) instead of being
// silently dropped. A common foot-gun is a caller sending `maxUses` when
// the canonical field is `maxUsage` — without strict mode the request
// returned 201 with `maxUsage: 1` (the default), masking the typo.
// Closes #945.
const createEnrollmentKeySchema = z.object({
  orgId: z.string().guid().optional(),
  siteId: z.string().guid().optional(),
  name: z.string().min(1).max(255),
  maxUsage: z.number().int().min(1).max(100000).optional(),
  expiresAt: z.string().datetime().optional(),
  ttlMinutes: z.number().int().min(1).max(MAX_TTL_MINUTES).optional(),
}).strict().refine(
  (data) => !(data.expiresAt !== undefined && data.ttlMinutes !== undefined),
  { message: 'Pass either ttlMinutes or expiresAt, not both', path: ['ttlMinutes'] }
);

const rotateEnrollmentKeySchema = z.object({
  maxUsage: z.number().int().min(1).max(100000).nullable().optional(),
  expiresAt: z.string().datetime().optional(),
}).strict();

// ttlMinutes here sets the lifetime of the *child* key — the downloaded
// installer / shared short-link the admin actually distributes. Measured
// fresh from mint time (see freshChildExpiresAt). Absent → deployment
// default. Same 365-day cap as createEnrollmentKeySchema.
const installerQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(100000).optional(),
  ttlMinutes: z.coerce.number().int().min(1).max(MAX_TTL_MINUTES).optional(),
});

const installerLinkSchema = z.object({
  platform: z.enum(["windows", "macos"]),
  count: z.number().int().min(1).max(100000).optional(),
  ttlMinutes: z.number().int().min(1).max(MAX_TTL_MINUTES).optional(),
}).strict();

function sanitizeEnrollmentKey(
  enrollmentKey: typeof enrollmentKeys.$inferSelect,
) {
  const { key, ...safeRecord } = enrollmentKey;
  return safeRecord;
}

/**
 * Installer device capacity minted from a key, aggregated across its
 * `installer_bootstrap_tokens` rows.
 *
 * Why this exists (#2992): on the modern download paths — Windows, and macOS
 * in its default app-bundle mode — the installer routes create NO child
 * enrollment key. They issue a bootstrap token whose `max_usage` IS the device
 * count the operator asked for, and mint a single-use child key lazily, one per
 * device, at redemption. So the enrollment_keys row the Enrollment Keys page
 * renders knows nothing about the installer, and `usage_count / max_usage`
 * showed "0 / 1" for an installer built for X devices.
 *
 * Read-side by design. The obvious alternative — writing the device count into
 * the parent's `max_usage` — is wrong: `max_usage` is an ENFORCED enrollment
 * budget (`/agents/enroll` matches on `usage_count < max_usage`, and the
 * short-link and MCP-invite paths atomically claim `usage_count` against it),
 * so it would widen a live credential to fix a display string.
 *
 * Counts DEVICE SLOTS, not installers: a key that produced two 5-device
 * downloads reports max 10, not 2.
 *
 * NOT reported for every key. `fetchInstallerTokenUsage` counts only tokens
 * stamped `usage_kind = 'capacity'` (#3034), so a key backed solely by
 * per-download or legacy-unknown tokens aggregates to nothing and both read
 * routes render `installerTokens: null`.
 */
export interface InstallerTokenUsage {
  /** Σ consumed_count — devices that have actually redeemed an installer. */
  consumed: number;
  /** Σ max_usage — total device slots those installers were minted for. */
  max: number;
  /**
   * Σ consumed_count over UNEXPIRED tokens only (`expires_at > now()`).
   * Additive (#3039) — `consumed`/`max` keep their all-tokens semantics so
   * existing consumers are untouched.
   */
  liveConsumed: number;
  /**
   * Σ max_usage over UNEXPIRED tokens only. Together with `liveConsumed` this
   * carries token liveness without a second query:
   *
   *   - `liveMax === 0`               → every installer from this key is dead
   *     (a "0 / 7" total is seven slots nothing can ever redeem again);
   *   - `liveConsumed < liveMax`      → at least one live, unexhausted token —
   *     the EXACT predicate `services/enrollmentKeyPurgeGuards.ts` uses to
   *     spare a key from the purge (per-token `consumed_count` never exceeds
   *     `max_usage`, so the sum comparison and the per-row EXISTS agree);
   *   - `liveConsumed >= liveMax > 0` → unexpired installers exist but every
   *     slot is claimed.
   *
   * The UI derives the row's effective status from these instead of the
   * transient parent key's own expiry (an Add-Device parent lives 60 minutes;
   * the installer minted from it can live a year).
   */
  liveMax: number;
}

/**
 * Batched lookup of installer capacity for the keys on one list page.
 *
 * WHAT IS COUNTED (#2992 review round 2, corrected by #3034): only tokens
 * stamped `usage_kind = 'capacity'`. Two flows parent
 * `installer_bootstrap_tokens` and their `max_usage` means different things:
 *
 *   (a) The AUTHENTICATED paths — `GET /:id/installer/:platform` (both
 *       platforms) and `POST /:id/bootstrap-token` — mint ONE token whose
 *       `max_usage` IS the device count the operator picked. Σ max_usage is a
 *       real budget; this is the case the whole feature exists for.
 *   (b) The PUBLIC download paths — `/s/:code` and the handle-based
 *       `public-download` route, both via `serveInstaller` — mint a hardcoded
 *       `maxUsage: 1` token per click. Σ max_usage there is "downloads so far",
 *       not capacity: a 7-device link clicked 3 times would render `3 / 7` from
 *       the key row and `Installer devices 0 / 3` underneath it — a second,
 *       smaller-looking N/M that grows on every click and never reaches 7, with
 *       the `3` in each line meaning something different (claims vs downloads).
 *
 * WHY THE DISCRIMINATOR IS PER-TOKEN. This gate used to live on the KEY, as
 * `reportsInstallerCapacity(key) === !key.shortCode`, suppressing the figure for
 * any short_code-bearing row. That proxy was wrong in BOTH directions (#3034):
 *
 *   - false suppression — the authenticated routes above accept ANY key id the
 *     caller can reach, including an installer-link child (a visible row on the
 *     Enrollment Keys page). Building an installer FROM that child produced a
 *     genuine `max_usage > 1` capacity token that the gate then hid;
 *   - false reporting — `/s/:code` mints a FRESH download key that carries NO
 *     short_code and then serves a per-download token against it, so those rows
 *     were never suppressed at all.
 *
 * No property of the parent key separates the two flows, so the meaning is
 * recorded on the token at mint time instead (see `usageKind` in
 * `db/schema/installerBootstrapTokens.ts`) and enforced here, in the WHERE
 * clause. That also removes the old two-gate arrangement: there is no longer an
 * app-layer restatement that could drift from the query, because the query IS
 * the discriminator and it cannot be bypassed by widening the id set.
 *
 * `legacy_unknown` rows (pre-#3034 single-slot tokens, and the column DEFAULT)
 * are excluded alongside `per_download`: unknown provenance must degrade to
 * showing nothing rather than to a possibly-click-counting number.
 *
 * Suppressed API-side, not in the UI, deliberately: the wire field should only
 * ever be populated when it genuinely denotes device-slot capacity, so a second
 * consumer (portal, AI tool, export) can't rediscover the same confusion.
 *
 * A key with no capacity tokens simply aggregates to zero rows and gets no map
 * entry, which the callers render as `installerTokens: null` — the same shape as
 * a key that never built an installer at all.
 *
 * Deliberately a SECOND query rather than a leftJoin onto the list select:
 * `installer_bootstrap_tokens` is 1:N per parent key (nothing constrains it to
 * one, and every download from the same key mints another), so joining it would
 * fan the page out into duplicate key rows and corrupt the pagination the caller
 * was handed. Bounded by page size — at most `limit` (<= 100) ids, served by
 * idx_installer_bootstrap_tokens_parent.
 *
 * Aggregation rule for a key with SEVERAL tokens: SUM across all of them,
 * including expired ones. Summing (rather than "most recent") means a key that
 * produced three installers reports the whole picture instead of hiding the
 * first two; including expired tokens keeps the number STABLE — a live "3 / 7"
 * would otherwise silently flip back to the parent's own "0 / 1" the moment the
 * token aged out, even though those three devices really did enroll.
 *
 * The totals report slots USED of slots MINTED and make no redeemability
 * claim; the live* pair (#3039) carries that claim separately, as FILTERed
 * sums over unexpired tokens in the same grouped query. Both are needed: a
 * bootstrap token gets a fresh lifetime independent of its parent (see
 * installerBootstrapTokenIssuance), and the Add-Device parent is a 60-minute
 * container, so an installer routinely outlives the key it was minted from —
 * without the live pair a fully-expired installer's "0 / 7" reads as seven
 * usable slots, and the row badge (parent expiry) contradicts the capacity
 * line.
 *
 * RLS: `installer_bootstrap_tokens` is a shape-1 (direct org_id) table with
 * enabled + forced policies (`2026-04-19-a-installer-bootstrap-tokens.sql`), so
 * this SELECT is org-filtered by Postgres in the request context on top of the
 * app-layer `inArray` on ids the caller already proved access to.
 *
 * Never throws. This is cosmetic enrichment on a read that worked before it
 * existed, so a failed aggregate degrades to "no installer info" rather than
 * blanking the operator's whole Enrollment Keys page.
 *
 * The nested `db.transaction` is load-bearing, not decoration — a bare
 * try/catch here does NOT work. Request handlers run inside
 * withDbAccessContext's postgres.js `sql.begin`, whose scope attaches
 * `q.catch(e => uncaughtError ||= e)` to every query and re-throws the
 * original error at COMMIT even when the callback resolved. Swallowing the
 * error would still 500 the page, just without the route's own context (#2189;
 * see dbSavepointErrorIsolation.integration.test.ts). A nested transaction
 * becomes `sql.savepoint`, which gets its own scope and rolls back to the
 * savepoint — leaving the outer transaction healthy and its uncaughtError
 * unset. The query MUST be issued on `tx`: the ambient `db` proxy resolves via
 * AsyncLocalStorage to the OUTER transaction and would reintroduce the clobber.
 */
export async function fetchInstallerTokenUsage(
  keyIds: string[],
  c?: Context,
): Promise<Map<string, InstallerTokenUsage>> {
  const usage = new Map<string, InstallerTokenUsage>();
  if (keyIds.length === 0) return usage;

  try {
    const rows = await db.transaction((tx) =>
      tx
        .select({
          parentEnrollmentKeyId: installerBootstrapTokens.parentEnrollmentKeyId,
          consumed: sql<number>`coalesce(sum(${installerBootstrapTokens.consumedCount}), 0)`,
          max: sql<number>`coalesce(sum(${installerBootstrapTokens.maxUsage}), 0)`,
          // Liveness cut (#3039): same sums restricted to unexpired tokens.
          // `expires_at` is NOT NULL on this table, so `> now()` is the whole
          // predicate — see InstallerTokenUsage for how the pair encodes the
          // purge-guard's live-token condition.
          liveConsumed: sql<number>`coalesce(sum(${installerBootstrapTokens.consumedCount}) filter (where ${installerBootstrapTokens.expiresAt} > now()), 0)`,
          liveMax: sql<number>`coalesce(sum(${installerBootstrapTokens.maxUsage}) filter (where ${installerBootstrapTokens.expiresAt} > now()), 0)`,
        })
        .from(installerBootstrapTokens)
        .where(
          and(
            inArray(installerBootstrapTokens.parentEnrollmentKeyId, keyIds),
            // The whole discriminator (#3034) — see the docblock. Anything not
            // provably a device-slot budget is excluded, so a group that has
            // only per-download / legacy-unknown tokens yields no row at all.
            eq(installerBootstrapTokens.usageKind, CAPACITY_USAGE_KIND),
          ),
        )
        .groupBy(installerBootstrapTokens.parentEnrollmentKeyId),
    );

    for (const row of rows) {
      usage.set(row.parentEnrollmentKeyId, {
        consumed: Number(row.consumed),
        max: Number(row.max),
        liveConsumed: Number(row.liveConsumed),
        liveMax: Number(row.liveMax),
      });
    }
  } catch (err) {
    console.error("[enrollment-keys] installer usage aggregate failed:", err);
    captureException(err, c);
    return new Map();
  }
  return usage;
}

const idParamSchema = z.object({ id: z.string().guid() });

// ============================================
// Routes
// ============================================

enrollmentKeyRoutes.use("*", authMiddleware);

// GET /enrollment-keys - List enrollment keys (org-scoped)
enrollmentKeyRoutes.get(
  "/",
  requireScope("organization", "partner", "system"),
  requirePermission(
    PERMISSIONS.ORGS_READ.resource,
    PERMISSIONS.ORGS_READ.action,
  ),
  zValidator("query", listEnrollmentKeysSchema),
  async (c) => {
    const auth = c.get("auth");
    const query = c.req.valid("query");
    const { page, limit, offset } = getPagination(query);

    const conditions: ReturnType<typeof eq>[] = [];

    if (auth.scope === "organization") {
      if (!auth.orgId) {
        return c.json({ error: "Organization context required" }, 403);
      }
      conditions.push(eq(enrollmentKeys.orgId, auth.orgId));
    } else if (auth.scope === "partner") {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: "Access to this organization denied" }, 403);
        }
        conditions.push(eq(enrollmentKeys.orgId, query.orgId));
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) {
          return c.json({ data: [], pagination: { page, limit, total: 0 } });
        }
        conditions.push(
          inArray(enrollmentKeys.orgId, orgIds) as ReturnType<typeof eq>,
        );
      }
    } else if (auth.scope === "system") {
      if (query.orgId) {
        conditions.push(eq(enrollmentKeys.orgId, query.orgId));
      }
    }

    // Filter by expired status.
    //
    // The invariant (#3191): NO key the row's status badge renders "Active" may
    // be hidden by `expired=false`. #3039 (PR #3045) taught that badge
    // (`getKeyStatus`, EnrollmentKeyManager.tsx) that once the parent key is
    // dead the row is judged by its installer tokens — the things that actually
    // enroll — so an Add-Device key whose 60-minute parent aged out while its
    // year-long installer keeps working renders "Active". This filter still
    // tested `expires_at` alone, so "Hide expired" hid rows the same page was
    // calling Active: both Active and invisible.
    //
    // The carve-out is `hasLiveUnexhaustedCapacityToken()`, the positive form
    // of the capacity-scoped guard. It shares ONE subquery builder with the
    // all-kind guard that spares a key from `purge-expired`
    // (services/enrollmentKeyPurgeGuards.ts), differing only in the
    // `usage_kind` predicate — which is what stops the page claiming a key is
    // expired while the delete path insists it is not.
    // It is the SQL counterpart of the badge's `liveConsumed < liveMax` — the
    // test that makes the badge say "Active" — modulo two documented seams:
    // the guard binds the API process clock while the live* sums use Postgres
    // `now()`, and the sum-vs-EXISTS equality relies on `consumed_count`
    // never exceeding `max_usage`, which no DB CHECK enforces (it is upheld by
    // the conditional UPDATE in routes/installer.ts). Both are sub-second /
    // theoretical seams on a read filter, not correctness holes.
    //
    // Scope note: this filter models EXPIRY, not the badge's third state.
    // `usage_count >= max_usage` ("Exhausted", amber) has never been part of
    // `?expired=` and still isn't — an exhausted-but-unexpired key stays listed
    // exactly as before. Correcting the expiry axis alone is sufficient for the
    // invariant: the badge is "Active" ONLY IF the parent is live or a live
    // unexhausted token exists, and both of those now keep the row visible.
    // (Not "iff" — the converse fails for the cases in the next paragraph,
    // where the badge falls back to parent expiry despite a live token.)
    //
    // Scoped to CAPACITY tokens (#3034). This used to be the all-token guard
    // plus an `isNull(short_code)` gate bolted on to mirror the read route's
    // per-key suppression; both the suppression and its mirror are gone, and the
    // guard now asks the same question the badge asks — is a live, unexhausted
    // DEVICE-SLOT token attached? — so the two cannot disagree by construction.
    // The purge guard still spans EVERY token kind, and should: suppressing a
    // confusing capacity NUMBER is cosmetic, whereas deleting a key out from
    // under a live installer is irreversible, so the delete path stays maximally
    // conservative. The residual disagreement is therefore always in the safe
    // direction — the list may call a per-download-only key dead while the purge
    // spares it, never the reverse.
    //
    // Caveat on the invariant: it holds whenever the `installerTokens`
    // enrichment succeeds. `fetchInstallerTokenUsage` deliberately degrades to
    // an empty Map on failure (logged + captureException), which drops every
    // row's badge back to parent expiry while this WHERE clause — which cannot
    // degrade — keeps live-token rows visible. In that window the page can show
    // an "Expired"-badged row under "Hide expired". Loud in Sentry, and
    // strictly better than the alternative of degrading the row SET.
    //
    // The two branches are exact complements: same `NOW()` on both sides (a
    // JS-clock `lt()` here would drift against the `NOW()` below and let a key
    // land in both buckets or neither), and `expires_at IS NULL` never
    // satisfies `<`, hence the explicit isNull.
    //
    // Both guards are built INSIDE their branch. Not a query-cost concern —
    // `db.select()` only shapes a lazy builder — but (1) the subquery binds
    // `new Date()` per call, so hoisting it would freeze "now", and (2) the
    // mocked list suites stub `../db/schema` without `installerBootstrapTokens`
    // and `db.select` as a bare `vi.fn()`, so building it on every unfiltered
    // request would throw there.
    if (query.expired === "true") {
      conditions.push(
        and(
          sql`${enrollmentKeys.expiresAt} < NOW()`,
          // De Morgan of the carve-out below, expressed with the guard's
          // already-existing negative form rather than a `not()` wrapper, so
          // both branches read as the same shared predicate.
          hasNoLiveUnexhaustedCapacityToken(),
        ) as ReturnType<typeof eq>,
      );
    } else if (query.expired === "false") {
      conditions.push(
        or(
          isNull(enrollmentKeys.expiresAt),
          sql`${enrollmentKeys.expiresAt} >= NOW()`,
          hasLiveUnexhaustedCapacityToken(),
        ) as ReturnType<typeof eq>,
      );
    }

    const whereCondition =
      conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(enrollmentKeys)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    const keyList = await db
      .select()
      .from(enrollmentKeys)
      .where(whereCondition)
      .orderBy(desc(enrollmentKeys.createdAt), desc(enrollmentKeys.id))
      .limit(limit)
      .offset(offset);

    // Installer capacity for this page only (#2992) — see
    // fetchInstallerTokenUsage for why this is a second keyed query and not a
    // join. `null` for a key that never minted a capacity installer, so the UI
    // can fall back to the key's own counters (correct for CLI / plain keys,
    // where usage_count is what actually gets claimed).
    //
    // Every key on the page is passed in (#3034). There is no longer a per-key
    // pre-filter to apply: which tokens count is decided per TOKEN inside the
    // query, and no property of the key predicts it — the authenticated build
    // routes accept a short-link child id, and /s/:code mints a short_code-LESS
    // download key. Widening the id set is harmless precisely because the
    // discriminator is in the WHERE clause rather than restated out here, so a
    // key with nothing but per-download tokens simply gets no group back.
    const installerUsage = await fetchInstallerTokenUsage(
      keyList.map((keyRecord) => keyRecord.id),
      c,
    );

    return c.json({
      data: keyList.map((keyRecord) => ({
        ...sanitizeEnrollmentKey(keyRecord),
        installerTokens: installerUsage.get(keyRecord.id) ?? null,
      })),
      pagination: { page, limit, total },
    });
  },
);

// POST /enrollment-keys - Create new enrollment key
enrollmentKeyRoutes.post(
  "/",
  requireScope("organization", "partner", "system"),
  requirePermission(
    PERMISSIONS.ORGS_WRITE.resource,
    PERMISSIONS.ORGS_WRITE.action,
  ),
  userRateLimit("enroll-write", 10, 60),
  requireMfa(),
  zValidator("json", createEnrollmentKeySchema),
  async (c) => {
    const auth = c.get("auth");
    const data = c.req.valid("json");
    let orgId = data.orgId;

    if (auth.scope === "organization") {
      if (!auth.orgId) {
        return c.json({ error: "Organization context required" }, 403);
      }
      if (data.orgId && data.orgId !== auth.orgId) {
        return c.json(
          { error: "Can only create enrollment keys for your organization" },
          403,
        );
      }
      orgId = auth.orgId;
    } else if (auth.scope === "partner") {
      if (!orgId) {
        const singleOrg = auth.accessibleOrgIds?.[0];
        if (auth.accessibleOrgIds?.length === 1 && singleOrg) {
          orgId = singleOrg;
        } else {
          return c.json(
            {
              error:
                "orgId is required when partner has multiple organizations",
            },
            400,
          );
        }
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: "Access to this organization denied" }, 403);
      }
    } else if (!orgId) {
      return c.json({ error: "orgId is required" }, 400);
    }

    // Reject (never clamp) a caller-supplied TTL above the partner cap
    // (fix round 1, #2776 task 3.4). This route has TWO paths to an expiry —
    // `ttlMinutes` and an explicit `expiresAt` — and createEnrollmentKeySchema's
    // refine guarantees only one is ever set. Both must be checked: capping
    // only `ttlMinutes` would leave `expiresAt` as a wide-open bypass (a
    // parent enrollment key is itself an enrollment credential). For the
    // `expiresAt` path there's no ttlMinutes to check directly, so the implied
    // duration from now is computed and checked against the same cap; Math.ceil
    // rounds UP so a request timed to land exactly at the cap is never
    // rejected by wall-clock rounding, while a value that's genuinely over the
    // cap is never rounded down into passing.
    const impliedTtlMinutes = data.ttlMinutes !== undefined
      ? data.ttlMinutes
      : data.expiresAt !== undefined
        ? Math.ceil((new Date(data.expiresAt).getTime() - Date.now()) / 60_000)
        : undefined;
    const capError = await assertTtlWithinCap(orgId, impliedTtlMinutes);
    if (capError) return c.json({ error: capError }, 400);

    // Verify siteId belongs to the target org (if provided)
    if (data.siteId) {
      const [site] = await db
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, data.siteId), eq(sites.orgId, orgId)))
        .limit(1);
      if (!site) {
        return c.json(
          { error: "siteId does not belong to the specified org" },
          400,
        );
      }
    }

    const rawKey = generateEnrollmentKey();
    const keyHash = hashEnrollmentKey(rawKey);
    // ttlMinutes preferred wire format (timezone math stays server-side);
    // explicit expiresAt remains accepted for callers that need it.
    const expiresAt = data.ttlMinutes !== undefined
      ? new Date(Date.now() + data.ttlMinutes * 60 * 1000)
      : data.expiresAt
        ? new Date(data.expiresAt)
        : new Date(Date.now() + DEFAULT_ENROLLMENT_KEY_TTL_MINUTES * 60 * 1000);
    const maxUsage = data.maxUsage ?? 1;

    const [enrollmentKey] = await db
      .insert(enrollmentKeys)
      .values({
        orgId,
        siteId: data.siteId ?? null,
        name: data.name,
        key: keyHash,
        maxUsage,
        expiresAt,
        createdBy: auth.user.id,
      })
      .returning();

    if (!enrollmentKey) {
      return c.json({ error: "Failed to create enrollment key" }, 500);
    }

    writeEnrollmentKeyAudit(c, auth, {
      orgId: enrollmentKey.orgId,
      action: "enrollment_key.create",
      keyId: enrollmentKey.id,
      keyName: enrollmentKey.name,
      details: {
        siteId: enrollmentKey.siteId,
        maxUsage: enrollmentKey.maxUsage,
        expiresAt: enrollmentKey.expiresAt,
      },
    });

    return c.json(
      {
        ...sanitizeEnrollmentKey(enrollmentKey),
        key: rawKey,
      },
      201,
    );
  },
);

// POST /enrollment-keys/purge-expired - Bulk hard-delete all expired
// enrollment keys visible to the caller (org/partner/system scoped, same as
// the GET / list route). Keys with expiresAt IS NULL are never matched by
// the `lt` condition below and are therefore never deleted.
//
// Hard delete is NOT unconditionally safe (#2832): installer_bootstrap_tokens
// and deployment_invites both carry ON DELETE CASCADE against
// enrollment_keys, and for bootstrap tokens that cascade is exactly the
// problem. The Add Device modal's parent key is a transient 60-minute
// container, while the bootstrap token minted from it keeps its own
// independent TTL of up to a year — so a key becomes purge-eligible here one
// hour after creation while its installer link is still live for another 30
// days. This route has no grace period at all (unlike the nightly sweep's
// 7 days), which makes it the FASTEST path to that data loss: one click on
// the web UI's "Delete expired" button. The `hasNoLiveUnexhaustedBootstrapToken()`
// condition below is therefore load-bearing, and is shared verbatim with
// jobs/enrollmentKeyCleanup.ts via services/enrollmentKeyPurgeGuards.ts.
//
// deployment_invites needs no such exemption — it has no independent expiry,
// so an invite is redeemable exactly while its enrollment key is (#2821,
// pinned by cases (e)-(h) of jobs/enrollmentKeyCleanup.integration.test.ts).
//
// Registered BEFORE the /:id-parameterized routes (GET /:id, POST
// /:id/rotate, DELETE /:id, etc.) so "purge-expired" is never captured as an
// :id param.
enrollmentKeyRoutes.post(
  "/purge-expired",
  requireScope("organization", "partner", "system"),
  requirePermission(
    PERMISSIONS.ORGS_WRITE.resource,
    PERMISSIONS.ORGS_WRITE.action,
  ),
  userRateLimit("enroll-write", 10, 60),
  requireMfa(),
  async (c) => {
    const auth = c.get("auth");

    const conditions: ReturnType<typeof eq>[] = [];

    if (auth.scope === "organization") {
      if (!auth.orgId) {
        return c.json({ error: "Organization context required" }, 403);
      }
      conditions.push(eq(enrollmentKeys.orgId, auth.orgId));
    } else if (auth.scope === "partner") {
      const orgIds = auth.accessibleOrgIds ?? [];
      if (orgIds.length === 0) {
        return c.json({ success: true, deletedCount: 0 });
      }
      conditions.push(
        inArray(enrollmentKeys.orgId, orgIds) as ReturnType<typeof eq>,
      );
    }
    // scope === "system": no org restriction — purge across all orgs.

    // The FIRST CONJUNCT of the condition the list route builds for
    // ?expired=true. expiresAt IS NULL never satisfies `lt`, so never-expiring
    // keys are never touched. The list route pairs it with the same live-token
    // exemption used below, so "Hide expired" and "Delete expired" now agree
    // about which keys are dead (#3191) — with one deliberate asymmetry,
    // documented at that filter: the list route's exemption counts only
    // CAPACITY tokens, because it must match the badge, which is derived from
    // the same capacity-only aggregate. This delete path counts tokens of every
    // kind — a per-download token is still a working installer somebody
    // downloaded, and a legacy-unknown one is merely a token whose provenance
    // was never recorded (#3034). That leaves the residual disagreement pinned
    // in the SAFE direction — the list may call a per-download-only key dead
    // while this route spares it (visible symptom: "Delete expired" reporting a
    // lower deletedCount than the operator expected), never the reverse, which
    // would be data loss.
    conditions.push(
      lt(enrollmentKeys.expiresAt, new Date()) as ReturnType<typeof eq>,
    );

    // #2832: exempt any key still backing a live, unexhausted installer
    // bootstrap token — see the route's header comment above and the shared
    // guard's docblock. Without this, "Delete expired" cascades away
    // 30-day/1-year installer links whose 60-minute parent key aged out.
    conditions.push(
      hasNoLiveUnexhaustedBootstrapToken() as ReturnType<typeof eq>,
    );

    const deletedRows = await db
      .delete(enrollmentKeys)
      .where(and(...conditions))
      .returning({ id: enrollmentKeys.id });
    const deletedCount = deletedRows.length;

    // Bulk purge can span multiple orgs (partner/system scope), so this
    // calls createAuditLogAsync directly rather than the writeEnrollmentKeyAudit
    // helper, which requires a single event.orgId (mirrors the direct-call
    // pattern already used for enrollment_key.installer_build_failed above).
    createAuditLogAsync({
      orgId: auth.scope === "organization" ? auth.orgId : null,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: "enrollment_key.purge_expired",
      resourceType: "enrollment_key",
      details: { deletedCount },
      ipAddress: getTrustedClientIpOrUndefined(c),
      userAgent: c.req.header("user-agent"),
      result: "success",
    });

    return c.json({ success: true, deletedCount });
  },
);

// GET /enrollment-keys/:id - Get enrollment key details
enrollmentKeyRoutes.get(
  "/:id",
  requireScope("organization", "partner", "system"),
  requirePermission(
    PERMISSIONS.ORGS_READ.resource,
    PERMISSIONS.ORGS_READ.action,
  ),
  async (c) => {
    const auth = c.get("auth");
    const keyId = c.req.param("id")!;

    const [enrollmentKey] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, keyId))
      .limit(1);

    if (!enrollmentKey) {
      return c.json({ error: "Enrollment key not found" }, 404);
    }

    const hasAccess = await ensureOrgAccess(enrollmentKey.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: "Access denied" }, 403);
    }

    // Same shape as the list route so a caller doesn't have to special-case
    // which endpoint it read the key from (#2992). Both routes now hand the key
    // id straight to the aggregate and let the per-token `usage_kind` filter
    // decide (#3034) — there is no per-key branch left for the two to disagree
    // about.
    const installerUsage = await fetchInstallerTokenUsage([enrollmentKey.id], c);

    return c.json({
      ...sanitizeEnrollmentKey(enrollmentKey),
      installerTokens: installerUsage.get(enrollmentKey.id) ?? null,
    });
  },
);

// POST /enrollment-keys/:id/rotate - Rotate enrollment key material in-place
enrollmentKeyRoutes.post(
  "/:id/rotate",
  requireScope("organization", "partner", "system"),
  requirePermission(
    PERMISSIONS.ORGS_WRITE.resource,
    PERMISSIONS.ORGS_WRITE.action,
  ),
  userRateLimit("enroll-write", 10, 60),
  requireMfa(),
  zValidator("json", rotateEnrollmentKeySchema),
  async (c) => {
    const auth = c.get("auth");
    const keyId = c.req.param("id")!;
    const data = c.req.valid("json");

    const [existingKey] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, keyId))
      .limit(1);

    if (!existingKey) {
      return c.json({ error: "Enrollment key not found" }, 404);
    }

    const hasAccess = await ensureOrgAccess(existingKey.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: "Access denied" }, 403);
    }

    // Reject (never clamp) a caller-supplied expiresAt above the partner cap
    // (fix round 2, #2776 task 3.4). rotateEnrollmentKeySchema has no
    // ttlMinutes field — only expiresAt — so there is only one path to gate
    // here. Rotation re-mints the key value via generateEnrollmentKey(), so
    // leaving this uncapped would let a caller bound by a short cap create a
    // key at the cap and immediately rotate it past it — a complete bypass
    // of the ceiling. An omitted expiresAt falls back to the existing key's
    // own (already-validated) expiresAt below, which is not a newly-chosen
    // value, so there's nothing to check in that case.
    const impliedTtlMinutes = data.expiresAt !== undefined
      ? Math.ceil((new Date(data.expiresAt).getTime() - Date.now()) / 60_000)
      : undefined;
    const capError = await assertTtlWithinCap(existingKey.orgId, impliedTtlMinutes);
    if (capError) return c.json({ error: capError }, 400);

    const rawKey = generateEnrollmentKey();
    const keyHash = hashEnrollmentKey(rawKey);
    const expiresAt = data.expiresAt
      ? new Date(data.expiresAt)
      : existingKey.expiresAt;
    const maxUsage =
      data.maxUsage !== undefined ? data.maxUsage : existingKey.maxUsage;

    const [rotatedKey] = await db
      .update(enrollmentKeys)
      .set({
        key: keyHash,
        usageCount: 0,
        expiresAt,
        maxUsage,
      })
      .where(eq(enrollmentKeys.id, keyId))
      .returning();

    if (!rotatedKey) {
      return c.json({ error: "Failed to rotate enrollment key" }, 500);
    }

    writeEnrollmentKeyAudit(c, auth, {
      orgId: rotatedKey.orgId,
      action: "enrollment_key.rotate",
      keyId: rotatedKey.id,
      keyName: rotatedKey.name,
      details: {
        previousUsageCount: existingKey.usageCount,
        previousMaxUsage: existingKey.maxUsage,
        nextMaxUsage: rotatedKey.maxUsage,
        previousExpiresAt: existingKey.expiresAt,
        nextExpiresAt: rotatedKey.expiresAt,
      },
    });

    return c.json({
      ...sanitizeEnrollmentKey(rotatedKey),
      key: rawKey,
    });
  },
);

// DELETE /enrollment-keys/:id - Delete enrollment key (hard delete)
enrollmentKeyRoutes.delete(
  "/:id",
  requireScope("organization", "partner", "system"),
  requirePermission(
    PERMISSIONS.ORGS_WRITE.resource,
    PERMISSIONS.ORGS_WRITE.action,
  ),
  userRateLimit("enroll-write", 10, 60),
  requireMfa(),
  async (c) => {
    const auth = c.get("auth");
    const keyId = c.req.param("id")!;

    const [existingKey] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, keyId))
      .limit(1);

    if (!existingKey) {
      return c.json({ error: "Enrollment key not found" }, 404);
    }

    const hasAccess = await ensureOrgAccess(existingKey.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: "Access denied" }, 403);
    }

    await db.delete(enrollmentKeys).where(eq(enrollmentKeys.id, keyId));

    writeEnrollmentKeyAudit(c, auth, {
      orgId: existingKey.orgId,
      action: "enrollment_key.delete",
      keyId: existingKey.id,
      keyName: existingKey.name,
      details: {
        usageCount: existingKey.usageCount,
        maxUsage: existingKey.maxUsage,
      },
    });

    return c.json({
      success: true,
      message: "Enrollment key deleted successfully",
    });
  },
);

// ============================================
// GET /:id/installer/:platform - Download pre-configured installer
// ============================================

enrollmentKeyRoutes.get(
  "/:id/installer/:platform",
  requireScope("organization", "partner", "system"),
  requirePermission(
    PERMISSIONS.ORGS_WRITE.resource,
    PERMISSIONS.ORGS_WRITE.action,
  ),
  requireMfa(),
  zValidator("query", installerQuerySchema),
  async (c) => {
    const auth = c.get("auth");
    const keyId = c.req.param("id")!;
    const platform = c.req.param("platform");
    const { count: childMaxUsage = 1, ttlMinutes: childTtlMinutes } =
      c.req.valid("query");

    if (platform !== "windows" && platform !== "macos") {
      return c.json(
        { error: 'Invalid platform. Must be "windows" or "macos".' },
        400,
      );
    }

    // Look up parent enrollment key
    const [parentKey] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, keyId))
      .limit(1);

    if (!parentKey) {
      return c.json({ error: "Enrollment key not found" }, 404);
    }

    // Verify org access
    const hasAccess = await ensureOrgAccess(parentKey.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: "Access denied" }, 403);
    }

    // Reject (never clamp) a caller-supplied TTL above the partner cap.
    // Must run after the parent key load — parentKey.orgId is required.
    const capError = await assertTtlWithinCap(parentKey.orgId, childTtlMinutes);
    if (capError) return c.json({ error: capError }, 400);

    // Verify key is still usable
    if (parentKey.expiresAt && new Date(parentKey.expiresAt) < new Date()) {
      return c.json({ error: "Enrollment key has expired" }, 410);
    }
    if (
      parentKey.maxUsage !== null &&
      parentKey.usageCount >= parentKey.maxUsage
    ) {
      return c.json({ error: "Enrollment key usage exhausted" }, 410);
    }
    if (parentKeyTooCloseToExpiry(parentKey.expiresAt)) {
      return c.json(
        {
          error:
            "Parent enrollment key expires too soon to build an installer — regenerate the key with a longer TTL",
        },
        410,
      );
    }

    // Require siteId on the parent key
    if (!parentKey.siteId) {
      return c.json(
        { error: "Enrollment key must have a siteId to generate installers" },
        400,
      );
    }

    // Determine server URL (no header fallback — prevent host header injection)
    const serverUrl = process.env.PUBLIC_API_URL || process.env.API_URL;
    if (!serverUrl) {
      return c.json(
        { error: "Server URL not configured (set PUBLIC_API_URL or API_URL)" },
        500,
      );
    }

    // Global enrollment secret (per-key secrets can't be recovered from hash)
    const globalSecret = process.env.AGENT_ENROLLMENT_SECRET || "";
    if (!globalSecret && parentKey.keySecretHash) {
      console.warn(
        "[installer] AGENT_ENROLLMENT_SECRET not configured but parent key has a secret hash — agents may fail to enroll",
      );
    }

    // ----------------------------------------------------------------
    // macOS — new app-bundle path (bootstrap token + renamed app zip)
    // Runs before the legacy binary fetch and child key creation.
    // Falls through to the legacy path when:
    //   (a) caller passed ?legacy=1, OR
    //   (b) the installer-app asset is not yet published on GitHub.
    // ----------------------------------------------------------------
    // Why a macOS download fell through to the legacy zip — recorded in the
    // legacy path's audit details so operators can tell "working as designed"
    // (explicit-legacy, nonstandard-host) from an asset-pipeline regression
    // (asset-unavailable, rename-failed).
    let macosLegacyFallbackReason:
      | "explicit-legacy"
      | "nonstandard-host"
      | "asset-unavailable"
      | "rename-failed"
      | null = null;

    if (platform === "macos") {
      const wantLegacy = c.req.query("legacy") === "1";
      // The app-bundle installer carries the API host in its bundle filename /
      // bootstrap.json, and the installer app only accepts a bare https host —
      // no port, no scheme (FilenameTokenParser.swift). A self-hosted server
      // on a nonstandard port could download the bundle but never enroll
      // through it (#2341), so fall through to the legacy zip below, which
      // embeds the full server URL.
      const bundleApiHost = macosBundleApiHost(serverUrl);
      if (wantLegacy) {
        macosLegacyFallbackReason = "explicit-legacy";
      } else if (!bundleApiHost) {
        macosLegacyFallbackReason = "nonstandard-host";
      }
      const appZip = macosLegacyFallbackReason
        ? null
        : await fetchMacosInstallerAppZip();
      if (!appZip && !macosLegacyFallbackReason) {
        macosLegacyFallbackReason = "asset-unavailable";
      }

      if (appZip && bundleApiHost) {
        // New path — bootstrap token + renamed app zip. No child enrollment key
        // is created here; the bootstrap endpoint creates it lazily on consume.
        let issued;
        try {
          issued = await issueBootstrapTokenForKey({
            parentEnrollmentKeyId: parentKey.id,
            createdByUserId: auth.user.id,
            // Authenticated build: childMaxUsage is the operator's device count,
            // so this token's max_usage is a real device-slot budget (#3034).
            // True regardless of whether parentKey happens to be a short-link
            // child — that is precisely the case the old per-key gate hid.
            usageKind: "capacity",
            maxUsage: childMaxUsage,
            ttlMinutes: childTtlMinutes,
          });
        } catch (err) {
          if (err instanceof BootstrapTokenIssuanceError) {
            if (err.code === "parent_not_found")
              return c.json({ error: err.message }, 404);
            return c.json({ error: err.message }, 410);
          }
          throw err;
        }

        // The bootstrap token is carried in TWO places, by design:
        //   1. the app bundle's own filename — `Breeze Installer [TOKEN@host].app`
        //   2. a sibling `Breeze Installer.bootstrap.json`
        // The Swift installer prefers the JSON (FilenameTokenParser.load), but
        // macOS App Translocation (Gatekeeper path randomization) copies ONLY
        // the .app bundle to a read-only randomized path when a quarantined app
        // is launched in place — stranding the sibling JSON and breaking the
        // install ("This installer needs its original filename", #2544). The
        // token lives INSIDE the bundle name, so it travels through
        // translocation and the filename fallback keeps the installer working.
        // Keeping the JSON preserves the clean, translocation-free read for the
        // common case (app moved to /Applications, quarantine cleared, etc.).
        const newAppName = `Breeze Installer [${issued.token}@${bundleApiHost}].app`;
        const bootstrapPayloadName = "Breeze Installer.bootstrap.json";

        let renamedZip: Buffer | undefined;
        try {
          renamedZip = await renameAppInZip(appZip, {
            oldAppName: "Breeze Installer.app",
            newAppName,
            extraFiles: [
              {
                path: bootstrapPayloadName,
                data: JSON.stringify({
                  token: issued.token,
                  apiHost: bundleApiHost,
                }),
                mode: 0o600,
              },
            ],
          });
        } catch (err) {
          console.error(
            "[installer] renameAppInZip failed, falling back to legacy zip",
            {
              parentKeyId: parentKey.id,
              tokenId: issued.id, // orphaned bootstrap token — will expire normally
              error: err instanceof Error ? err.message : String(err),
            },
          );
          // The fallback still hands the user a working installer, so without
          // a Sentry event a systemic rename regression (e.g. a corrupted
          // release asset) would be invisible until someone reads raw logs.
          captureException(err, c);
          macosLegacyFallbackReason = "rename-failed";
          // Fall through to legacy path — do NOT return.
        }

        if (renamedZip) {
          writeEnrollmentKeyAudit(c, auth, {
            orgId: parentKey.orgId,
            action: "enrollment_key.installer_download",
            keyId: parentKey.id,
            keyName: parentKey.name,
            details: {
              platform,
              mode: "app-bundle",
              tokenId: issued.id,
              count: childMaxUsage,
            },
          });

          c.header("Content-Type", "application/zip");
          // Stable, token-free download name. Finder names the extracted folder
          // after this, and the single-use token stays out of the ZIP filename,
          // Content-Disposition, and any proxy access logs — it rides inside the
          // bundle name / bootstrap.json instead.
          c.header(
            "Content-Disposition",
            `attachment; filename="breeze-agent-macos-installer.zip"`,
          );
          c.header("Content-Length", String(renamedZip.length));
          c.header("Cache-Control", "no-store");
          return c.body(renamedZip as unknown as ArrayBuffer);
        }
      }

      // Falls through to legacy path below.
    }

    // ----------------------------------------------------------------
    // Windows — static signed MSI + bootstrap token in the filename.
    // No per-customer signing, no child key here; the bootstrap endpoint
    // mints the child key lazily on consume (mirrors the macOS path above).
    // ----------------------------------------------------------------
    if (platform === "windows") {
      // Encode the filename host BEFORE issuing a bootstrap token, so a URL
      // that can never enroll (non-https, host not expressible in a Windows
      // filename) fails loudly with the reason instead of serving an MSI
      // that silently installs unenrolled — and doesn't burn a token (#2341).
      let apiHost: string;
      try {
        apiHost = windowsFilenameApiHost(serverUrl);
      } catch (err) {
        if (err instanceof InstallerFilenameHostError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }

      let issued;
      try {
        issued = await issueBootstrapTokenForKey({
          parentEnrollmentKeyId: parentKey.id,
          createdByUserId: auth.user.id,
          // Authenticated build — see the macOS branch above (#3034).
          usageKind: "capacity",
          maxUsage: childMaxUsage,
          ttlMinutes: childTtlMinutes,
          installerPlatform: "windows",
        });
      } catch (err) {
        if (err instanceof BootstrapTokenIssuanceError) {
          if (err.code === "parent_not_found")
            return c.json({ error: err.message }, 404);
          return c.json({ error: err.message }, 410);
        }
        throw err;
      }

      let msi: Buffer;
      try {
        msi = await fetchRegularMsi();
      } catch (err) {
        console.error("[installer] failed to fetch signed MSI:", err);
        captureException(err, c);
        return c.json({ error: "MSI not available" }, 503);
      }

      // Build the response BEFORE the audit write — serveWindowsBootstrapMsi
      // throws on a non-encoded host (defense in depth, #2341), and the audit
      // trail must not record a download that never happened.
      const response = serveWindowsBootstrapMsi(c, {
        msi,
        token: issued.token,
        apiHost,
      });

      writeEnrollmentKeyAudit(c, auth, {
        orgId: parentKey.orgId,
        action: "enrollment_key.installer_download",
        keyId: parentKey.id,
        keyName: parentKey.name,
        details: {
          platform,
          mode: "bootstrap-msi",
          tokenId: issued.id,
          count: childMaxUsage,
        },
      });

      return response;
    }

    // Signing-spend cap — enforce BEFORE child key creation or any signing
    // operation so an authenticated user cannot drive unbounded (costly,
    // rate-limited-upstream) signing calls. Two overlapping caps:
    //   1. Per-user:       INSTALLER_SIGN_USER_LIMIT / INSTALLER_SIGN_WINDOW_SECONDS
    //   2. Per-parent-key: INSTALLER_SIGN_KEY_LIMIT  / INSTALLER_SIGN_WINDOW_SECONDS
    // Both fail closed on Redis errors to prevent a Redis outage from
    // disabling the cap.
    {
      const { getRedis } = await import("../services");
      const { rateLimiter } = await import("../services/rate-limit");
      const redis = getRedis();
      if (!redis) {
        console.error(
          "[installer] sign-spend rate-limit unavailable: redis client missing",
        );
        return c.json({ error: "Service temporarily unavailable" }, 503);
      }

      // Per-user cap
      const userResult = await rateLimiter(
        redis,
        `rl:installer-sign:user:${auth.user.id}`,
        INSTALLER_SIGN_USER_LIMIT,
        INSTALLER_SIGN_WINDOW_SECONDS,
      );
      if (!userResult.allowed) {
        return c.json(
          {
            error:
              "Installer signing rate limit reached. Try again later.",
            retryAfter: userResult.resetAt.toISOString(),
          },
          429,
        );
      }

      // Per-parent-key cap (reuses the same bucket as the public route so
      // combined public + authenticated spend is bounded together).
      const keyResult = await rateLimiter(
        redis,
        `install-sign:${parentKey.id}`,
        INSTALLER_SIGN_KEY_LIMIT,
        INSTALLER_SIGN_WINDOW_SECONDS,
      );
      if (!keyResult.allowed) {
        return c.json(
          {
            error:
              "Installer signing rate limit reached for this enrollment key. Try again later.",
            retryAfter: keyResult.resetAt.toISOString(),
          },
          429,
        );
      }
    }

    // The partner cap bounds KEY LIFETIME, not merely caller-supplied input
    // (#2776 fix round 3 ruling). `assertTtlWithinCap` above already 400s an
    // EXPLICIT over-cap childTtlMinutes, but it returns null for `undefined`
    // by design — so an admin who simply OMITS ttlMinutes used to take the
    // uncapped CHILD_ENROLLMENT_KEY_TTL_MINUTES server constant (1440), which
    // is 24x a 60-minute partner cap, on the two most-used download routes.
    // Clamp the fallback too. Deliberately unconditional rather than
    // `childTtlMinutes ?? await clampTtlToCap(...)`: this plan produced six
    // one-at-a-time cap gaps precisely because each site assumed some other
    // site had already checked. Costs one extra settings read on the explicit
    // path, where it is a same-value no-op.
    //
    // The child's TTL is FRESH from mint time, never the parent's remaining
    // lifetime — otherwise late-in-life parents produce DOA installers.
    const childExpiresAt = freshChildExpiresAt(
      await clampTtlToCap(
        parentKey.orgId,
        childTtlMinutes ?? CHILD_ENROLLMENT_KEY_TTL_MINUTES,
      ),
    );

    const rawChildKey = generateEnrollmentKey();
    const childKeyHash = hashEnrollmentKey(rawChildKey);
    const shortCode = await allocateShortCode();

    const [childKey] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: parentKey.orgId,
        siteId: parentKey.siteId,
        name: `${parentKey.name} (installer${childMaxUsage > 1 ? ` x${childMaxUsage}` : ""})`,
        key: childKeyHash,
        keySecretHash: parentKey.keySecretHash,
        maxUsage: childMaxUsage,
        expiresAt: childExpiresAt,
        createdBy: auth.user.id,
        shortCode,
        installerPlatform: platform,
      })
      .returning();

    if (!childKey) {
      return c.json({ error: "Failed to generate installer key" }, 500);
    }

    // Build the macOS installer — wrap in try/catch to clean up orphaned child key on failure.
    // Windows early-returns above; this block is macOS-only.
    try {
      // macOS — install.sh downloads the architecture-matched pkg at install
      // time, so no binary is bundled here (one zip serves Intel + Apple Silicon).
      const zipBuffer = await buildMacosInstallerZip({
        serverUrl,
        enrollmentKey: rawChildKey,
        enrollmentSecret: globalSecret,
        siteId: parentKey.siteId,
      });

      writeEnrollmentKeyAudit(c, auth, {
        orgId: parentKey.orgId,
        action: "enrollment_key.installer_download",
        keyId: parentKey.id,
        keyName: parentKey.name,
        details: {
          platform,
          childKeyId: childKey.id,
          shortCode,
          count: childMaxUsage,
          ...(macosLegacyFallbackReason
            ? { fallbackReason: macosLegacyFallbackReason }
            : {}),
        },
      });

      c.header("Content-Type", "application/zip");
      c.header(
        "Content-Disposition",
        'attachment; filename="breeze-agent-macos.zip"',
      );
      c.header("Content-Length", String(zipBuffer.length));
      c.header("Cache-Control", "no-store");
      return c.body(zipBuffer as unknown as ArrayBuffer);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[installer] Build failed:", detail);
      captureException(err, c);

      // Audit the failure so it's traceable
      createAuditLogAsync({
        orgId: parentKey.orgId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: "enrollment_key.installer_build_failed",
        resourceType: "enrollment_key",
        resourceId: parentKey.id,
        resourceName: parentKey.name,
        details: {
          platform,
          childKeyId: childKey.id,
          count: childMaxUsage,
          error: detail,
        },
        ipAddress: getTrustedClientIpOrUndefined(c),
        userAgent: c.req.header("user-agent"),
        result: "failure",
      });

      await db
        .delete(enrollmentKeys)
        .where(eq(enrollmentKeys.id, childKey.id))
        .catch((cleanupErr) => {
          console.error(
            "[installer] Failed to clean up orphaned child key:",
            childKey.id,
            cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
          );
        });

      // Route is MFA-gated + org-write permission — safe to surface the
      // underlying error so admins debugging a misconfigured signing
      // service get actionable signal instead of an opaque 500.
      return c.json({ error: "Failed to build installer", detail }, 500);
    }
  },
);

// ============================================
// POST /:id/bootstrap-token — issue a single-use installer bootstrap token
// ============================================

const bootstrapTokenBodySchema = z.object({
  maxUsage: z.number().int().min(1).max(1000).default(1),
  ttlMinutes: z.number().int().min(1).max(MAX_TTL_MINUTES).optional(),
}).strict();

enrollmentKeyRoutes.post(
  "/:id/bootstrap-token",
  requireScope("organization", "partner", "system"),
  requirePermission(
    PERMISSIONS.ORGS_WRITE.resource,
    PERMISSIONS.ORGS_WRITE.action,
  ),
  userRateLimit("enroll-write", 10, 60),
  requireMfa(),
  zValidator("param", idParamSchema),
  zValidator("json", bootstrapTokenBodySchema),
  async (c) => {
    const auth = c.get("auth");
    const { id: keyId } = c.req.valid("param");
    const { maxUsage, ttlMinutes } = c.req.valid("json");

    const [parent] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, keyId))
      .limit(1);

    if (!parent) {
      return c.json({ error: "Enrollment key not found" }, 404);
    }

    const hasAccess = await ensureOrgAccess(parent.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: "Access denied" }, 403);
    }

    // Reject (never clamp) a caller-supplied TTL above the partner cap.
    const capError = await assertTtlWithinCap(parent.orgId, ttlMinutes);
    if (capError) return c.json({ error: capError }, 400);

    if (parentKeyTooCloseToExpiry(parent.expiresAt)) {
      return c.json(
        {
          error:
            "Parent enrollment key expires too soon to build an installer — regenerate the key with a longer TTL",
        },
        410,
      );
    }

    try {
      const {
        id: tokenId,
        token,
        expiresAt,
      } = await issueBootstrapTokenForKey({
        parentEnrollmentKeyId: parent.id,
        createdByUserId: auth.user.id,
        // Authenticated issuance: the caller states the device count in the
        // request body, so max_usage is a device-slot budget (#3034).
        usageKind: "capacity",
        maxUsage,
        ttlMinutes,
      });

      writeEnrollmentKeyAudit(c, auth, {
        orgId: parent.orgId,
        action: "enrollment_key.bootstrap_token_issued",
        keyId: parent.id,
        keyName: parent.name,
        details: { maxUsage, tokenId },
      });

      return c.json({ token, expiresAt: expiresAt.toISOString(), maxUsage });
    } catch (err) {
      if (err instanceof BootstrapTokenIssuanceError) {
        if (err.code === "parent_not_found")
          return c.json({ error: err.message }, 404);
        return c.json({ error: err.message }, 410);
      }
      throw err;
    }
  },
);

// ============================================
// POST /:id/installer-link - Generate a public download link
// ============================================

enrollmentKeyRoutes.post(
  "/:id/installer-link",
  requireScope("organization", "partner", "system"),
  requirePermission(
    PERMISSIONS.ORGS_WRITE.resource,
    PERMISSIONS.ORGS_WRITE.action,
  ),
  userRateLimit("enroll-write", 10, 60),
  requireMfa(),
  zValidator("json", installerLinkSchema),
  async (c) => {
    const auth = c.get("auth");
    const keyId = c.req.param("id")!;
    const {
      platform,
      count: childMaxUsage = 1,
      ttlMinutes: childTtlMinutes,
    } = c.req.valid("json");

    // Look up parent enrollment key
    const [parentKey] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, keyId))
      .limit(1);

    if (!parentKey) {
      return c.json({ error: "Enrollment key not found" }, 404);
    }

    // Verify org access
    const hasAccess = await ensureOrgAccess(parentKey.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: "Access denied" }, 403);
    }

    // Reject (never clamp) a caller-supplied TTL above the partner cap.
    const capError = await assertTtlWithinCap(parentKey.orgId, childTtlMinutes);
    if (capError) return c.json({ error: capError }, 400);

    // Verify key is still usable
    if (parentKey.expiresAt && new Date(parentKey.expiresAt) < new Date()) {
      return c.json({ error: "Enrollment key has expired" }, 410);
    }
    if (
      parentKey.maxUsage !== null &&
      parentKey.usageCount >= parentKey.maxUsage
    ) {
      return c.json({ error: "Enrollment key usage exhausted" }, 410);
    }
    if (parentKeyTooCloseToExpiry(parentKey.expiresAt)) {
      return c.json(
        {
          error:
            "Parent enrollment key expires too soon to build an installer link — regenerate the key with a longer TTL",
        },
        410,
      );
    }

    // Require siteId on the parent key
    if (!parentKey.siteId) {
      return c.json(
        {
          error:
            "Enrollment key must have a siteId to generate installer links",
        },
        400,
      );
    }

    // For macOS, validate that both architecture PKGs are reachable before
    // creating a child key — prevents links that 500 on every click.
    // Windows uses the bootstrap path (no signing dependency), so no probe needed.
    if (platform === "macos") {
      try {
        await assertMacosInstallerPkgsReachable();
      } catch (err) {
        console.error(
          `[installer-link] pre-flight check failed for ${platform}:`,
          err,
        );
        captureException(err, c);
        return c.json(
          { error: "macOS PKG not reachable" },
          503,
        );
      }
    }

    // The partner cap bounds KEY LIFETIME, not merely caller-supplied input
    // (#2776 fix round 3 ruling). `assertTtlWithinCap` above already 400s an
    // EXPLICIT over-cap childTtlMinutes, but it returns null for `undefined`
    // by design — so an admin who simply OMITS ttlMinutes used to take the
    // uncapped CHILD_ENROLLMENT_KEY_TTL_MINUTES server constant (1440), which
    // is 24x a 60-minute partner cap, on the two most-used download routes.
    // Clamp the fallback too. Deliberately unconditional rather than
    // `childTtlMinutes ?? await clampTtlToCap(...)`: this plan produced six
    // one-at-a-time cap gaps precisely because each site assumed some other
    // site had already checked. Costs one extra settings read on the explicit
    // path, where it is a same-value no-op.
    //
    // The child's TTL is FRESH from mint time, never the parent's remaining
    // lifetime — otherwise late-in-life parents produce DOA installers.
    const childExpiresAt = freshChildExpiresAt(
      await clampTtlToCap(
        parentKey.orgId,
        childTtlMinutes ?? CHILD_ENROLLMENT_KEY_TTL_MINUTES,
      ),
    );

    const rawChildKey = generateEnrollmentKey();
    const childKeyHash = hashEnrollmentKey(rawChildKey);
    const shortCode = await allocateShortCode();

    const [childKey] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: parentKey.orgId,
        siteId: parentKey.siteId,
        name: `${parentKey.name} (link${childMaxUsage > 1 ? ` x${childMaxUsage}` : ""})`,
        key: childKeyHash,
        keySecretHash: parentKey.keySecretHash,
        maxUsage: childMaxUsage,
        expiresAt: childExpiresAt,
        createdBy: auth.user.id,
        shortCode,
        installerPlatform: platform,
      })
      .returning();

    if (!childKey) {
      return c.json({ error: "Failed to generate installer link" }, 500);
    }

    // Build public URL
    const serverUrl = process.env.PUBLIC_API_URL || process.env.API_URL;
    if (!serverUrl) {
      return c.json(
        { error: "Server URL not configured (set PUBLIC_API_URL or API_URL)" },
        500,
      );
    }

    // Issue a one-time download handle so the raw token never appears in the URL.
    const { issueDownloadHandle } = await import("../services/downloadHandle");
    const handle = await issueDownloadHandle(rawChildKey);

    const publicUrl = `${serverUrl.replace(/\/$/, "")}/api/v1/enrollment-keys/public-download/${platform}?h=${handle}`;
    const shortUrl = `${serverUrl.replace(/\/$/, "")}/s/${shortCode}`;

    // Audit log
    writeEnrollmentKeyAudit(c, auth, {
      orgId: parentKey.orgId,
      action: "enrollment_key.installer_link_created",
      keyId: parentKey.id,
      keyName: parentKey.name,
      details: {
        platform,
        childKeyId: childKey.id,
        shortCode,
        count: childMaxUsage,
      },
    });

    return c.json({
      url: publicUrl,
      shortUrl,
      expiresAt: childKey.expiresAt,
      maxUsage: childMaxUsage,
      platform,
      childKeyId: childKey.id,
    });
  },
);

// ============================================
// POST /:id/download-handle - Exchange key for a one-time handle.
// Moves the raw token out of the public URL; the handle survives ~5 min and is single-use.
// ============================================

enrollmentKeyRoutes.post(
  "/:id/download-handle",
  requireScope("organization", "partner", "system"),
  requirePermission(
    PERMISSIONS.ORGS_WRITE.resource,
    PERMISSIONS.ORGS_WRITE.action,
  ),
  userRateLimit("enroll-handle", 30, 60),
  zValidator("param", idParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id: keyId } = c.req.valid("param");
    const body = (await c.req.json().catch(() => ({}))) as {
      rawToken?: string;
    };
    if (!body.rawToken || typeof body.rawToken !== "string") {
      return c.json({ error: "rawToken is required" }, 400);
    }

    // Ownership check: caller must own the key row.
    const [row] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, keyId))
      .limit(1);
    if (!row) return c.json({ error: "Not found" }, 404);

    // Verify org access.
    const hasAccess = await ensureOrgAccess(row.orgId, auth);
    if (!hasAccess) return c.json({ error: "Not found" }, 404);

    // Verify the raw token matches the stored hash. Accept legacy-pepper hashes
    // for keys created before ENROLLMENT_KEY_PEPPER was mandatory.
    if (!hashEnrollmentKeyCandidates(body.rawToken).includes(row.key)) {
      return c.json({ error: "Invalid token" }, 400);
    }

    const { issueDownloadHandle } = await import("../services/downloadHandle");
    const handle = await issueDownloadHandle(body.rawToken);
    return c.json({ handle });
  },
);

// ============================================
// Public routes (no auth middleware)
// ============================================

// checkInstallerSignSpend gates the (expensive) installer-signing path with
// a per-(short-code OR enrollment-key id) bucket, on top of the per-IP cap
// applied separately by callers. Without this, an attacker rotating source
// IPs can exhaust the signing service / storage budget for a single key by
// staying under the per-IP limit on each IP.
//
// Returns a Response on rate-limit hit or Redis failure (fail-closed), or
// `null` to indicate "allowed — proceed with signing". 30 requests per hour
// per bucket.
export async function checkInstallerSignSpend(
  c: Context,
  bucketId: string,
): Promise<Response | null> {
  try {
    const { getRedis } = await import("../services");
    const { rateLimiter } = await import("../services/rate-limit");
    const redis = getRedis();
    if (!redis) {
      console.error(
        "[public-installer] sign-spend rate-limit unavailable: redis client missing",
      );
      return c.json({ error: "Service temporarily unavailable" }, 503);
    }
    const rateResult = await rateLimiter(
      redis,
      `install-sign:${bucketId}`,
      30,
      3600,
    );
    if (!rateResult.allowed) {
      return c.json(
        {
          error:
            "Installer signing rate limit reached for this enrollment link. Try again later.",
        },
        429,
      );
    }
    return null;
  } catch (err) {
    console.error(
      "[public-installer] sign-spend rate-limit check failed (failing closed):",
      err instanceof Error ? err.message : err,
    );
    return c.json({ error: "Service temporarily unavailable" }, 503);
  }
}

// serveInstaller is the shared helper for both public-download and short-link routes.
// `rawToken` is the plaintext enrollment key to embed in the installer.
// `keyRow`  is the already-resolved enrollment key row (for validation and usage tracking).
// `signSpendBucketChecked` — when true, the caller has already debited the
// per-(short-code OR enrollment-key id) signing budget (i.e. the /s/:code
// path debited against the short code before the atomic claim). When false
// (public-download path), we debit here using `keyRow.id` as the bucket key.
// `linkExpiresAt` — the expiry of the installer LINK the requester followed,
// which bounds the Windows bootstrap token's lifetime (#3038). Defaults to
// `keyRow.expiresAt` because on the public-download path `keyRow` IS the
// installer-link child key; the /s/:code path must pass the short-link row's
// expiry explicitly, since its `keyRow` is a freshly-minted download key
// whose 24h TTL says nothing about the link the admin configured.
async function serveInstaller(
  c: Context,
  keyRow: typeof enrollmentKeys.$inferSelect,
  platform: "windows" | "macos",
  rawToken: string,
  cleanupOnFailure = false,
  signSpendBucketChecked = false,
  linkExpiresAt: Date | null = keyRow.expiresAt,
): Promise<Response> {
  // Use getTrustedClientIp so spoofed `X-Forwarded-For` from untrusted
  // clients does not let an attacker open unlimited rate-limit buckets.
  // The 'unknown' fallback bucket is intentional fail-safe behavior:
  // multiple unknown-IP requests share one bucket and rate-limit together.
  const ip = getTrustedClientIp(c, "unknown");

  // Rate limit by IP (10 per minute). Fail CLOSED on Redis errors —
  // an attacker who can DoS Redis must NOT be able to disable the
  // limiter on this public endpoint.
  try {
    const { getRedis } = await import("../services");
    const { rateLimiter } = await import("../services/rate-limit");
    const redis = getRedis();
    if (!redis) {
      console.error(
        "[public-installer] rate-limit unavailable: redis client missing",
      );
      return c.json({ error: "Service temporarily unavailable" }, 503);
    }
    const rateResult = await rateLimiter(
      redis,
      `public-installer:${rateLimitIpKey(ip)}`,
      10,
      60,
    );
    if (!rateResult.allowed) {
      return c.json(
        { error: "Too many requests. Please try again later." },
        429,
      );
    }
  } catch (err) {
    console.error(
      "[public-installer] rate-limit check failed (failing closed):",
      err instanceof Error ? err.message : err,
    );
    return c.json({ error: "Service temporarily unavailable" }, 503);
  }

  // Per-enrollment-key signing-spend cap (30/hour). Skipped when the caller
  // already debited the bucket against a short-code (see /s/:code).
  if (!signSpendBucketChecked) {
    const denied = await checkInstallerSignSpend(c, keyRow.id);
    if (denied) return denied;
  }

  // Validate key is still usable
  if (keyRow.expiresAt && new Date(keyRow.expiresAt) < new Date()) {
    return c.json({ error: "This download link has expired" }, 410);
  }
  if (keyRow.maxUsage !== null && keyRow.usageCount >= keyRow.maxUsage) {
    return c.json(
      { error: "This download link has been used the maximum number of times" },
      410,
    );
  }
  if (parentKeyTooCloseToExpiry(keyRow.expiresAt)) {
    // Public/unauthenticated path — no parent-key detail (name, id) in the
    // response, matching the other rejection messages in this function.
    return c.json(
      { error: "This download link is expiring too soon to build an installer" },
      410,
    );
  }
  if (!keyRow.siteId) {
    return c.json({ error: "Invalid enrollment key configuration" }, 400);
  }

  // Determine server URL
  const serverUrl = process.env.PUBLIC_API_URL || process.env.API_URL;
  if (!serverUrl) {
    return c.json({ error: "Server URL not configured" }, 500);
  }

  const globalSecret = process.env.AGENT_ENROLLMENT_SECRET || "";

  // ----------------------------------------------------------------
  // Windows — bootstrap path: issue a single-use bootstrap token,
  // fetch the static signed MSI, and embed the token in the filename.
  // No per-customer signing and no child key created here.
  // ----------------------------------------------------------------
  if (platform === "windows") {
    // Encode the filename host BEFORE issuing a bootstrap token, so a URL
    // that can never enroll (non-https, host not expressible in a Windows
    // filename) fails loudly with the reason instead of serving an MSI
    // that silently installs unenrolled — and doesn't burn a token (#2341).
    let apiHost: string;
    try {
      apiHost = windowsFilenameApiHost(serverUrl);
    } catch (err) {
      if (err instanceof InstallerFilenameHostError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    let issued;
    try {
      issued = await issueBootstrapTokenForKey({
        parentEnrollmentKeyId: keyRow.id,
        // created_by is a nullable uuid FK; a key created by an unauthenticated
        // path has no creator. Pass null — `?? ""` made Postgres reject the
        // insert with `invalid input syntax for type uuid: ""` (500 on /s/:code).
        createdByUserId: keyRow.createdBy ?? null,
        // The ONLY per-download mint site (#3034). Both public flows reach it —
        // /s/:code (whose keyRow is a freshly-minted, short_code-LESS download
        // key) and the download-handle route (whose keyRow IS the short-link
        // child). maxUsage is a hardcoded 1 per click, so summing these counts
        // downloads, not device slots, and they must never reach the capacity
        // figure. Note neither flow is identifiable from the parent key alone —
        // which is why the discriminator is recorded here rather than inferred.
        usageKind: "per_download",
        maxUsage: 1,
        // The token inherits the installer link's remaining lifetime (#3038).
        // This path has no per-request TTL picker — the admin already chose
        // the expiry when the link was generated, and the token minted into
        // the downloaded MSI must honor that choice, not silently fall back
        // to the 24h base (which killed every install after hour 24 of a
        // 30-day link). undefined (no link expiry) keeps the 24h base;
        // issueBootstrapTokenForKey clamps to the partner cap either way.
        ttlMinutes: installerLinkRemainingTtlMinutes(linkExpiresAt),
        installerPlatform: "windows",
      });
    } catch (err) {
      if (err instanceof BootstrapTokenIssuanceError) {
        if (err.code === "parent_not_found")
          return c.json({ error: err.message }, 404);
        return c.json({ error: err.message }, 410);
      }
      throw err;
    }

    let msi: Buffer;
    try {
      msi = await fetchRegularMsi();
    } catch (err) {
      console.error("[public-download] Failed to fetch MSI:", err);
      captureException(err, c);
      return c.json({ error: "MSI not available" }, 503);
    }

    // Build the response BEFORE the audit write — serveWindowsBootstrapMsi
    // throws on a non-encoded host (defense in depth, #2341), and the audit
    // trail must not record a download that never happened.
    const response = serveWindowsBootstrapMsi(c, {
      msi,
      token: issued.token,
      apiHost,
    });

    createAuditLogAsync({
      orgId: keyRow.orgId,
      actorId: ANONYMOUS_ACTOR_ID,
      action: "enrollment_key.public_download",
      resourceType: "enrollment_key",
      resourceId: keyRow.id,
      resourceName: keyRow.name,
      details: { platform, ip, signed: false },
      ipAddress: ip,
      userAgent: c.req.header("user-agent"),
      result: "success",
    });

    return response;
  }

  // ----------------------------------------------------------------
  // macOS — build zip BEFORE incrementing usage (don't burn usage on
  // build failure). install.sh downloads the arch-matched pkg at
  // install time; nothing is bundled (one zip serves Intel + Apple Silicon).
  // ----------------------------------------------------------------
  try {
    const resultBuffer = await buildMacosInstallerZip({
      serverUrl,
      enrollmentKey: rawToken,
      enrollmentSecret: globalSecret,
      siteId: keyRow.siteId,
    });

    // NOTE: we DO NOT bump keyRow.usageCount here. The child key's
    // max_usage semantic is "max successful enrollments," not "max
    // downloads" — bumping on download burns the slot before the agent
    // has even tried to enroll, and the subsequent /agents/enroll call
    // then sees usage_count >= max_usage and returns an opaque 401.
    // The enroll endpoint at routes/agents/enrollment.ts owns the
    // increment via a TOCTOU-safe UPDATE ... WHERE usage_count < max_usage
    // so the slot is only consumed when enrollment actually succeeds.
    // Downloads are still tracked, but via the audit log below.

    createAuditLogAsync({
      orgId: keyRow.orgId,
      actorId: ANONYMOUS_ACTOR_ID,
      action: "enrollment_key.public_download",
      resourceType: "enrollment_key",
      resourceId: keyRow.id,
      resourceName: keyRow.name,
      details: { platform, ip, signed: false },
      ipAddress: ip,
      userAgent: c.req.header("user-agent"),
      result: "success",
    });

    c.header("Content-Type", "application/zip");
    c.header("Content-Disposition", `attachment; filename="breeze-agent-macos.zip"`);
    c.header("Content-Length", String(resultBuffer.length));
    c.header("Cache-Control", "no-store");
    return c.body(resultBuffer as unknown as ArrayBuffer);
  } catch (err) {
    console.error(
      "[public-download] Build failed:",
      err instanceof Error ? err.message : err,
    );
    // Public endpoint — do NOT leak err.message in the response body, but
    // fire Sentry so operators can still see the underlying cause.
    captureException(err, c);

    if (cleanupOnFailure) {
      await db
        .delete(enrollmentKeys)
        .where(eq(enrollmentKeys.id, keyRow.id))
        .catch((cleanupErr) => {
          console.error(
            "[public-download] Failed to clean up orphaned child key:",
            keyRow.id,
            cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
          );
        });
    }

    return c.json({ error: "Failed to build installer" }, 500);
  }
}

export const publicEnrollmentRoutes = new Hono();

const publicDownloadQuerySchema = z
  .object({
    h: z
      .string()
      .regex(/^dlh_[a-f0-9]{32}$/)
      .optional(),
  })
  .refine((v) => v.h, { message: "h is required" });

publicEnrollmentRoutes.get(
  "/public-download/:platform",
  zValidator("query", publicDownloadQuerySchema),
  async (c) => {
    const platform = c.req.param("platform");
    const { h } = c.req.valid("query");

    if (platform !== "windows" && platform !== "macos") {
      return c.json(
        { error: 'Invalid platform. Must be "windows" or "macos".' },
        400,
      );
    }

    let rawToken: string | null = null;
    if (h) {
      const { consumeDownloadHandle } =
        await import("../services/downloadHandle");
      rawToken = await consumeDownloadHandle(h);
    }
    if (!rawToken) {
      return c.json({ error: "Invalid or expired download link" }, 404);
    }

    // System context required: public endpoint with no authenticated user,
    // RLS has no org context. The system context wraps BOTH the lookup and
    // serveInstaller so that the usage_count bump inside serveInstaller is
    // also scoped correctly — otherwise the breeze_app role's RLS UPDATE
    // policy silently drops the row modification and download quotas are
    // never enforced.
    // Try primary + legacy peppers so keys created before ENROLLMENT_KEY_PEPPER
    // was mandatory still resolve.
    const keyHashCandidates = hashEnrollmentKeyCandidates(rawToken);
    // Capture in const so the closure below has a non-null narrowed type.
    const finalToken = rawToken;
    return withSystemDbAccessContext(async () => {
      const [enrollmentKey] = await db
        .select()
        .from(enrollmentKeys)
        .where(inArray(enrollmentKeys.key, keyHashCandidates))
        .limit(1);

      if (!enrollmentKey) {
        return c.json({ error: "Invalid or expired download link" }, 404);
      }

      return serveInstaller(c, enrollmentKey, platform, finalToken);
    });
  },
);

// ============================================
// Public short-link routes (no auth middleware)
// ============================================

export const publicShortLinkRoutes = new Hono();

publicShortLinkRoutes.get("/:code", async (c) => {
  const code = c.req.param("code");
  if (!code || code.length > 12) {
    return c.json({ error: "Not found" }, 404);
  }

  // System context required: public endpoint with no authenticated user, RLS has no org context
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.shortCode, code))
      .limit(1);

    if (!row || !row.installerPlatform) {
      return c.json({ error: "Not found" }, 404);
    }

    if (
      row.installerPlatform !== "windows" &&
      row.installerPlatform !== "macos"
    ) {
      return c.json({ error: "Not found" }, 404);
    }

    // Per-short-code signing-spend cap (30/hour). Bound to the short code,
    // not the source IP, so an attacker rotating IPs can NOT burn through
    // the (expensive) signing-service budget for a single link.
    //
    // Placed AFTER the row lookup + platform validation (so requests for
    // unknown / non-installer codes don't consume the bucket) and BEFORE the
    // atomic usage-claim (so rate-limited requests don't burn enrollment
    // slots either).
    const signSpendDenied = await checkInstallerSignSpend(c, code);
    if (signSpendDenied) return signSpendDenied;

    // Atomic claim: decrement usage budget with a combined WHERE that
    // includes the expiry check. If this matches zero rows, return 410
    // without ever inserting a child key.
    const claim = await db
      .update(enrollmentKeys)
      .set({ usageCount: sql`${enrollmentKeys.usageCount} + 1` })
      .where(
        and(
          eq(enrollmentKeys.id, row.id),
          row.maxUsage !== null
            ? lt(enrollmentKeys.usageCount, row.maxUsage)
            : sql`true`,
          or(
            isNull(enrollmentKeys.expiresAt),
            sql`${enrollmentKeys.expiresAt} > NOW()`,
          ),
        ),
      )
      .returning({ id: enrollmentKeys.id });

    if (claim.length === 0) {
      return c.json(
        { error: "This link has expired or reached its maximum usage limit." },
        410,
      );
    }

    // Only now create the child key — no cleanup needed on failure.
    // The short-link row holds only the hashed token — the raw token was never stored.
    // We create a fresh single-use child key so we have something to embed in the installer.
    // Child gets a FRESH TTL independent of the short-link row's remaining
    // lifetime so the installer survives the trip to the target machine even
    // if the short-link row is near its own expiry.
    const rawToken = generateEnrollmentKey();
    const tokenHash = hashEnrollmentKey(rawToken);
    // Clamp (never reject — public, unauthenticated redemption path with no
    // interactive caller) the child's default TTL to the partner cap (fix
    // round 3, #2776): the cap bounds KEY LIFETIME, not just interactively-
    // chosen input, so this short-link download must not hand out a child
    // key longer-lived than the partner allows just because it uses the
    // server-constant default.
    const cappedTtlMinutes = await clampTtlToCap(row.orgId, CHILD_ENROLLMENT_KEY_TTL_MINUTES);

    const [downloadKey] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: row.orgId,
        siteId: row.siteId,
        name: `${row.name} (short-link download)`,
        key: tokenHash,
        keySecretHash: row.keySecretHash,
        maxUsage: 1,
        expiresAt: freshChildExpiresAt(cappedTtlMinutes),
        createdBy: null,
        installerPlatform: row.installerPlatform,
      })
      .returning();

    if (!downloadKey) {
      return c.json({ error: "Failed to prepare installer" }, 500);
    }

    return serveInstaller(
      c,
      downloadKey,
      row.installerPlatform,
      rawToken,
      true,
      true, // signSpendBucketChecked — debited against short code above
      // The SHORT-LINK row's expiry, not downloadKey's: the download key is a
      // fresh 24h transport container, while `row` is the link the admin
      // configured — its remaining lifetime is what the Windows bootstrap
      // token must inherit (#3038).
      row.expiresAt,
    );
  });
});
