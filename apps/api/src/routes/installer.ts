import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db, withSystemDbAccessContext } from '../db';
import { installerBootstrapTokens } from '../db/schema/installerBootstrapTokens';
import { enrollmentKeys, organizations } from '../db/schema/orgs';
import { hashEnrollmentKey } from '../services/enrollmentKeySecurity';
import { BOOTSTRAP_TOKEN_PATTERN } from '../services/installerBootstrapToken';

const CHILD_TTL_MIN = Number(
  process.env.CHILD_ENROLLMENT_KEY_TTL_MINUTES ?? 24 * 60,
);

function freshChildExpiresAt(): Date {
  return new Date(Date.now() + CHILD_TTL_MIN * 60 * 1000);
}

function generateChildEnrollmentKey(): string {
  return randomBytes(32).toString('hex'); // 64-char hex
}

const INVALID_TOKEN_RESPONSE = {
  body: { error: 'token invalid, expired, or already used' as const },
  status: 404 as const,
};

export const installerRoutes = new Hono();

/**
 * Public bootstrap endpoint. The token IS the auth — no JWT, no API key,
 * no session. Resolves the token to an enrollment payload, atomically
 * marks it consumed, and lazily creates a short-lived child enrollment key.
 *
 * Invalid / expired / already-used tokens all return the same 404 to
 * avoid leaking which condition was hit.
 */
installerRoutes.get('/bootstrap/:token', async (c) => {
  const token = c.req.param('token');
  if (!BOOTSTRAP_TOKEN_PATTERN.test(token)) {
    return c.json({ error: 'invalid token' }, 400);
  }

  const result = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .select()
      .from(installerBootstrapTokens)
      .where(eq(installerBootstrapTokens.token, token))
      .limit(1);
    if (!row) return null;
    if (row.consumedAt) return null;
    if (new Date(row.expiresAt) < new Date()) return null;

    // Atomic single-use guard: UPDATE ... WHERE consumed_at IS NULL.
    // Two concurrent requests both read row.consumedAt = null but only one
    // UPDATE will return a row (Postgres serializes the write).
    const [updated] = await db
      .update(installerBootstrapTokens)
      .set({
        consumedAt: new Date(),
        consumedFromIp: c.req.header('cf-connecting-ip') ?? null,
      })
      .where(
        and(
          eq(installerBootstrapTokens.id, row.id),
          isNull(installerBootstrapTokens.consumedAt),
        ),
      )
      .returning();
    if (!updated) return null;

    const [parent] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, row.parentEnrollmentKeyId))
      .limit(1);
    if (!parent) return null;

    const rawChildKey = generateChildEnrollmentKey();
    const childKeyHash = hashEnrollmentKey(rawChildKey);
    await db
      .insert(enrollmentKeys)
      .values({
        orgId: row.orgId,
        siteId: row.siteId,
        name: `${parent.name} (mac-installer ${token})`,
        key: childKeyHash,
        keySecretHash: parent.keySecretHash,
        maxUsage: row.maxUsage,
        expiresAt: freshChildExpiresAt(),
        createdBy: row.createdBy,
        installerPlatform: 'macos',
      })
      .returning();

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, row.orgId))
      .limit(1);

    return {
      rawChildKey,
      siteId: row.siteId,
      orgName: org?.name ?? 'your organization',
    };
  });

  if (!result) {
    return c.json(INVALID_TOKEN_RESPONSE.body, INVALID_TOKEN_RESPONSE.status);
  }

  return c.json({
    serverUrl: process.env.PUBLIC_API_URL ?? process.env.API_URL ?? '',
    enrollmentKey: result.rawChildKey,
    enrollmentSecret: process.env.AGENT_ENROLLMENT_SECRET || null,
    siteId: result.siteId,
    orgName: result.orgName,
  });
});
