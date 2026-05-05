import { Hono, type Context } from "hono";
import { and, eq, isNull } from "drizzle-orm";
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
 * Never log raw bootstrap tokens — they grant single-use enrollment.
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
 * marks it consumed, and lazily creates a short-lived child enrollment key.
 *
 * Invalid / expired / already-used tokens all return the same 404 to
 * avoid leaking which condition was hit.
 *
 * C1 (atomicity): We INSERT the child enrollment key BEFORE marking the
 * token consumed. If the atomic UPDATE returns empty (concurrent consume),
 * we DELETE the child key we just created and return 404. This reorder
 * approach avoids nested transactions (withSystemDbAccessContext already
 * wraps everything in a Postgres transaction for RLS context injection),
 * while ensuring the token is never permanently burned without a usable
 * child key.
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

    if (row.consumedAt) {
      console.error("[installer] bootstrap 404", {
        reason: "already_consumed",
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

    // ── 3. INSERT child key BEFORE consuming the token (C1 reorder) ──
    // If the consume UPDATE loses a race, we'll DELETE this row below.
    const rawChildKey = generateChildEnrollmentKey();
    const childKeyHash = hashEnrollmentKey(rawChildKey);
    const [childKey] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: row.orgId,
        siteId: row.siteId,
        name: `${parent.name} (mac-installer ${hashTokenForLog(token)})`,
        key: childKeyHash,
        keySecretHash: parent.keySecretHash,
        maxUsage: row.maxUsage,
        expiresAt: childExpiresAt,
        createdBy: row.createdBy,
        installerPlatform: "macos",
      })
      .returning();

    // ── 4. Atomic single-use consume guard ────────────────────────────
    // Two concurrent requests both read row.consumedAt = null, but only one
    // UPDATE will return a row (Postgres serializes the write).
    const [updated] = await db
      .update(installerBootstrapTokens)
      .set({
        consumedAt: new Date(),
        consumedFromIp: ip === "unknown" ? null : ip,
      })
      .where(
        and(
          eq(installerBootstrapTokens.id, row.id),
          isNull(installerBootstrapTokens.consumedAt),
        ),
      )
      .returning();

    if (!updated) {
      // Lost the race — delete the child key we just created so we don't
      // leave orphaned enrollment keys accumulating on repeated replays.
      console.error("[installer] bootstrap 404", {
        reason: "lost_race",
        tokenId: row.id,
        ip,
      });
      if (childKey) {
        await db
          .delete(enrollmentKeys)
          .where(eq(enrollmentKeys.id, childKey.id));
      }
      return null;
    }

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
