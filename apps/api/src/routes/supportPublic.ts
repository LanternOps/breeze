import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { normalizeSupportCode, redeemSupportSessionSchema } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../db';
import { enrollmentKeys, sites, supportSessions } from '../db/schema';
import { hashSupportCode } from '../services/quickSupportCode';
import { hashEnrollmentKey, hashEnrollmentSecret } from '../services/enrollmentKeySecurity';
import { rateLimiter } from '../services/rate-limit';
import { getRedis } from '../services/redis';
import { getTrustedClientIp } from '../services/clientIp';
import { logSessionAudit } from './remote/helpers';

/**
 * Public Quick Support endpoints — the one-time code IS the authentication.
 *
 * Everything here is unauthenticated by design (the end user is a stranger
 * holding a code their technician read out), so the guards are: ~44 bits of
 * code entropy, a 15-minute redemption TTL, per-IP rate limits, and a single
 * atomic pending->claimed transition that makes a code strictly single-use.
 *
 * These handlers run under withSystemDbAccessContext because an anonymous
 * caller has no org context at all — the code lookup is the authorization.
 */
export const supportPublicRoutes = new Hono();

const CHECK_LIMIT = 30;
const REDEEM_LIMIT = 10;
const RATE_WINDOW_SECONDS = 60;

/** Child enrollment keys are minted with the same lifetime as the code. */
const CHILD_KEY_TTL_MS = 15 * 60_000;

/**
 * Is this code redeemable right now? Deliberately returns nothing but a
 * boolean — never session details, org names, or timings — so the endpoint
 * cannot be used to enumerate or fingerprint tenants.
 */
supportPublicRoutes.get('/check/:code', async (c) => {
  const ip = getTrustedClientIp(c, 'unknown');
  const limit = await rateLimiter(getRedis(), `support-check:${ip}`, CHECK_LIMIT, RATE_WINDOW_SECONDS);
  if (!limit.allowed) return c.json({ error: 'rate limited' }, 429);

  const code = normalizeSupportCode(c.req.param('code'));
  // Malformed input can never match a stored hash — skip the DB entirely.
  if (!code) return c.json({ valid: false });

  const [row] = await withSystemDbAccessContext(() => db
    .select({
      status: supportSessions.status,
      codeExpiresAt: supportSessions.codeExpiresAt,
    })
    .from(supportSessions)
    .where(eq(supportSessions.codeHash, hashSupportCode(code)))
    .limit(1)) as Array<{ status: string; codeExpiresAt: Date }>;

  return c.json({
    valid: !!row && row.status === 'pending' && row.codeExpiresAt > new Date(),
  });
});

/**
 * Redeem a code for a single-use enrollment key.
 *
 * The child key carries its OWN secret (key_secret_hash), which takes
 * precedence over the global AGENT_ENROLLMENT_SECRET in
 * /agents/enroll. That is deliberate: no existing route hands the global
 * enrollment secret to a code-authenticated caller, and this endpoint must
 * not become the first. A per-key secret is single-use, expires in 15
 * minutes, and is worthless for enrolling anything else.
 */
supportPublicRoutes.post('/redeem', zValidator('json', redeemSupportSessionSchema), async (c) => {
  const ip = getTrustedClientIp(c, 'unknown');
  const limit = await rateLimiter(getRedis(), `support-redeem:${ip}`, REDEEM_LIMIT, RATE_WINDOW_SECONDS);
  if (!limit.allowed) return c.json({ error: 'rate limited' }, 429);

  const data = c.req.valid('json');
  const code = normalizeSupportCode(data.code);
  // One indistinguishable failure shape for malformed, unknown, expired and
  // already-claimed codes — nothing here should confirm a code ever existed.
  if (!code) return c.json({ error: 'invalid or expired code' }, 404);

  const result = await withSystemDbAccessContext(async () => {
    const now = new Date();
    const [row] = await db
      .select()
      .from(supportSessions)
      .where(eq(supportSessions.codeHash, hashSupportCode(code)))
      .limit(1);

    if (!row
      || row.status !== 'pending'
      || row.codeExpiresAt < now
      || row.hardExpiresAt < now) {
      return null;
    }

    // Atomic claim: the WHERE status='pending' guard is what makes a
    // simultaneous second redemption lose rather than mint a second key.
    const [claimed] = await db
      .update(supportSessions)
      .set({
        status: 'claimed',
        claimedAt: now,
        claimedFromIp: ip === 'unknown' ? null : ip,
      })
      .where(and(
        eq(supportSessions.id, row.id),
        eq(supportSessions.status, 'pending'),
      ))
      .returning();
    if (!claimed) return null;

    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.orgId, row.orgId))
      .limit(1);

    const rawChildKey = randomBytes(32).toString('hex');
    const rawChildSecret = randomBytes(32).toString('hex');

    await db.insert(enrollmentKeys).values({
      orgId: row.orgId,
      siteId: site?.id ?? null,
      name: `Quick Support ${row.id.slice(0, 8)}`,
      key: hashEnrollmentKey(rawChildKey),
      keySecretHash: hashEnrollmentSecret(rawChildSecret),
      maxUsage: 1,
      expiresAt: new Date(Date.now() + CHILD_KEY_TTL_MS),
      supportSessionId: row.id,
      installerPlatform: data.osType === 'windows' ? 'windows' : 'macos',
    });

    return {
      rawChildKey,
      rawChildSecret,
      sessionId: row.id,
      hardExpiresAt: row.hardExpiresAt,
      orgId: row.orgId,
      createdByUserId: row.createdByUserId,
    };
  });

  if (!result) return c.json({ error: 'invalid or expired code' }, 404);

  // The audit row needs a user id, so it carries the session CREATOR's — the
  // real actor is an anonymous end user, which the details say explicitly.
  await logSessionAudit(
    'support_session_claimed',
    result.createdByUserId,
    result.orgId,
    { sessionId: result.sessionId, actor: 'end_user', hostname: data.hostname },
    ip,
  );

  return c.json({
    serverUrl: process.env.PUBLIC_API_URL ?? process.env.API_URL ?? '',
    enrollmentKey: result.rawChildKey,
    enrollmentSecret: result.rawChildSecret,
    sessionId: result.sessionId,
    hardExpiresAt: result.hardExpiresAt,
  });
});
