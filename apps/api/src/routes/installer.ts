import { Hono, type Context } from "hono";
import { and, eq, lt, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { db, withSystemDbAccessContext } from "../db";
import { installerBootstrapTokens } from "../db/schema/installerBootstrapTokens";
import { enrollmentKeys, organizations } from "../db/schema/orgs";
import { hashEnrollmentKey } from "../services/enrollmentKeySecurity";
import { BOOTSTRAP_TOKEN_PATTERN } from "../services/installerBootstrapToken";

const CHILD_TTL_MIN = Number(
  process.env.CHILD_ENROLLMENT_KEY_TTL_MINUTES ?? 24 * 60,
);

/**
 * Returns the child enrollment key expiry: the earlier of
 *   (a) the parent's own expiry, or
 *   (b) now + CHILD_TTL_MIN
 *
 * This prevents a child key from outliving its parent, which would
 * implicitly extend access for a revoked/expired parent key.
 *
 * Returns null if the parent is already expired — callers should treat
 * null as a signal to reject the request.
 */
function freshChildExpiresAt(parentExpiresAt: Date): Date | null {
  const now = Date.now();
  if (parentExpiresAt.getTime() <= now) {
    return null; // parent already expired — reject
  }
  const childTtlMs = CHILD_TTL_MIN * 60 * 1000;
  return new Date(Math.min(parentExpiresAt.getTime(), now + childTtlMs));
}

function generateChildEnrollmentKey(): string {
  return randomBytes(32).toString("hex"); // 64-char hex
}

/**
 * Returns a short SHA-256 hash of a sensitive token for log correlation.
 * Never log raw bootstrap tokens — they grant device enrollment up to the
 * token's max_usage times, so a leaked token is worth that many enrollments.
 */
function hashTokenForLog(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

const INVALID_TOKEN_RESPONSE = {
  body: { error: "token invalid, expired, or already used" as const },
  status: 404 as const,
};

function allowLegacyGetBootstrap(): boolean {
  const value =
    process.env.MACOS_INSTALLER_ALLOW_LEGACY_GET_BOOTSTRAP?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export const installerRoutes = new Hono();

/**
 * Public bootstrap endpoint. The token IS the auth — no JWT, no API key,
 * no session. Resolves the token to an enrollment payload, atomically
 * records one redemption, and lazily creates a short-lived child enrollment
 * key for the calling device.
 *
 * The token is redeemable up to max_usage times — once per device that
 * installs the same downloaded installer — with a fresh single-use child key
 * minted each time (#2161). A max_usage = 1 token is effectively single-use.
 *
 * Invalid / expired / exhausted tokens all return the same 404 to
 * avoid leaking which condition was hit.
 *
 * C1 (atomicity): We INSERT the child enrollment key BEFORE incrementing the
 * token's consumed_count. If the atomic UPDATE returns empty (concurrent
 * redemption exhausted the last slot), we DELETE the child key we just
 * created and return 404. This reorder approach avoids nested transactions
 * (withSystemDbAccessContext already wraps everything in a Postgres
 * transaction for RLS context injection), while ensuring a redemption is
 * never counted without a usable child key.
 */
async function redeemBootstrapToken(c: Context, token: string) {
  if (!BOOTSTRAP_TOKEN_PATTERN.test(token)) {
    return c.json({ error: "invalid token" }, 400);
  }

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";

  const result = await withSystemDbAccessContext(async () => {
    // ── 1. Look up token ──────────────────────────────────────────────
    const [row] = await db
      .select()
      .from(installerBootstrapTokens)
      .where(eq(installerBootstrapTokens.token, token))
      .limit(1);

    if (!row) {
      console.error("[installer] bootstrap 404", {
        reason: "no_row",
        tokenHash: hashTokenForLog(token),
        ip,
      });
      return null;
    }

    if (row.consumedCount >= row.maxUsage) {
      console.error("[installer] bootstrap 404", {
        reason: "exhausted",
        tokenId: row.id,
        ip,
      });
      return null;
    }

    if (new Date(row.expiresAt) < new Date()) {
      console.error("[installer] bootstrap 404", {
        reason: "expired",
        tokenId: row.id,
        ip,
      });
      return null;
    }

    // ── 2. Resolve parent enrollment key; validate it's not expired ───
    const [parent] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, row.parentEnrollmentKeyId))
      .limit(1);

    if (!parent) {
      // Data-integrity anomaly: token references a parent key that no longer exists.
      console.error(
        "[installer] bootstrap orphaned parent — data integrity incident",
        {
          reason: "orphaned_parent",
          tokenId: row.id,
          parentEnrollmentKeyId: row.parentEnrollmentKeyId,
          ip,
        },
      );
      return null;
    }

    // If the parent has no expiry set, fall back to the child TTL only
    // (no upper bound from parent). If it does have an expiry, bound by it.
    const parentExpiresAt = parent.expiresAt
      ? new Date(parent.expiresAt)
      : null;
    const childExpiresAt = parentExpiresAt
      ? freshChildExpiresAt(parentExpiresAt)
      : new Date(Date.now() + CHILD_TTL_MIN * 60 * 1000);
    if (!childExpiresAt) {
      console.error("[installer] bootstrap 404", {
        reason: "parent_already_expired",
        tokenId: row.id,
        ip,
      });
      return null;
    }

    // ── 3. INSERT child key BEFORE recording the redemption (C1 reorder) ──
    // If the consume UPDATE loses a race, we'll DELETE this row below.
    const rawChildKey = generateChildEnrollmentKey();
    const childKeyHash = hashEnrollmentKey(rawChildKey);
    const platformLabel = row.installerPlatform === "windows" ? "win-installer" : "mac-installer";
    const [childKey] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: row.orgId,
        siteId: row.siteId,
        name: `${parent.name} (${platformLabel} ${hashTokenForLog(token)})`,
        key: childKeyHash,
        keySecretHash: parent.keySecretHash,
        // Each redemption hands this single key to exactly one device, so it is
        // itself single-use. The token's max_usage governs how many devices may
        // redeem (i.e. how many child keys get minted), NOT the fan-out of any
        // one child key — see the consume guard below (#2161).
        maxUsage: 1,
        expiresAt: childExpiresAt,
        createdBy: row.createdBy,
        installerPlatform: row.installerPlatform ?? "macos",
      })
      .returning();

    // ── 4. Atomic consume guard (increment up to max_usage) ────────────
    // The WHERE consumed_count < max_usage serializes concurrent redemptions:
    // Postgres applies the increments one at a time, so exactly max_usage of
    // them see a row that still satisfies the predicate and RETURNING is
    // non-empty. The (max_usage + 1)-th finds consumed_count === max_usage and
    // gets nothing back. This is what makes one downloaded installer enroll up
    // to N devices instead of just the first (#2161). consumed_at tracks the
    // most recent redemption (informational only now).
    const [updated] = await db
      .update(installerBootstrapTokens)
      .set({
        consumedCount: sql`${installerBootstrapTokens.consumedCount} + 1`,
        consumedAt: new Date(),
        consumedFromIp: ip === "unknown" ? null : ip,
      })
      .where(
        and(
          eq(installerBootstrapTokens.id, row.id),
          lt(installerBootstrapTokens.consumedCount, installerBootstrapTokens.maxUsage),
        ),
      )
      .returning();

    if (!updated) {
      // Lost the race, or the token was exhausted between the read above and
      // this write — delete the child key we just created so we don't leave
      // orphaned enrollment keys accumulating on repeated replays.
      console.error("[installer] bootstrap 404", {
        reason: "exhausted_on_consume",
        tokenId: row.id,
        ip,
      });
      if (childKey) {
        // Safe to leave unchecked ONLY because this DELETE shares the redeem
        // transaction with the INSERT above: a throw rolls both back (no
        // orphan), and a 0-row delete is impossible (we just inserted the id).
        // If the child INSERT is ever moved to its own transaction, this must
        // become a checked/logged delete or it silently leaks enrollment keys.
        await db
          .delete(enrollmentKeys)
          .where(eq(enrollmentKeys.id, childKey.id));
      }
      return null;
    }

    // Success audit: consumed_at/consumed_from_ip on the token row only retain
    // the LAST redeemer, so record each redemption's IP + running count here —
    // this is the only per-device forensic trail for a multi-use token.
    console.log("[installer] bootstrap redeemed", {
      reason: "redeemed",
      tokenId: row.id,
      consumedCount: updated.consumedCount,
      maxUsage: row.maxUsage,
      childKeyId: childKey?.id,
      ip,
    });

    // ── 5. Fetch org name for response ────────────────────────────────
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, row.orgId))
      .limit(1);

    return {
      rawChildKey,
      siteId: row.siteId,
      orgName: org?.name ?? "your organization",
    };
  });

  if (!result) {
    return c.json(INVALID_TOKEN_RESPONSE.body, INVALID_TOKEN_RESPONSE.status);
  }

  return c.json({
    serverUrl: process.env.PUBLIC_API_URL ?? process.env.API_URL ?? "",
    backupServerUrl: (process.env.AGENT_BACKUP_SERVER_URL ?? "").trim() || undefined,
    enrollmentKey: result.rawChildKey,
    enrollmentSecret: process.env.AGENT_ENROLLMENT_SECRET || null,
    siteId: result.siteId,
    orgName: result.orgName,
  });
}

installerRoutes.post("/bootstrap", async (c) => {
  let token = c.req.header("x-breeze-bootstrap-token") ?? "";
  if (
    !token &&
    (c.req.header("content-type") ?? "").includes("application/json")
  ) {
    const body = (await c.req.json().catch(() => null)) as {
      token?: unknown;
    } | null;
    token = typeof body?.token === "string" ? body.token : "";
  }
  if (!token) {
    return c.json({ error: "missing token" }, 400);
  }
  return redeemBootstrapToken(c, token);
});

installerRoutes.get("/bootstrap/:token", async (c) => {
  if (!allowLegacyGetBootstrap()) {
    return c.json(INVALID_TOKEN_RESPONSE.body, INVALID_TOKEN_RESPONSE.status);
  }
  return redeemBootstrapToken(c, c.req.param("token"));
});
