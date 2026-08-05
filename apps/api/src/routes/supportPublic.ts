import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { randomBytes } from 'node:crypto';
import { statSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { normalizeSupportCode, redeemSupportSessionSchema } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../db';
import { enrollmentKeys, sites, supportSessions } from '../db/schema';
import { hashSupportCode } from '../services/quickSupportCode';
import { hashEnrollmentKey, hashEnrollmentSecret } from '../services/enrollmentKeySecurity';
import { getBinarySource, getGithubAgentUrl } from '../services/binarySource';
import { isS3Configured, getPresignedUrl, isS3NotFound } from '../services/s3Storage';
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

/** Phase 1 ships a Windows client only; macOS is accepted-but-declined below. */
const SUPPORT_CLIENT_PLATFORMS = new Set(['windows', 'macos']);

/** The support client IS the normal agent binary — same asset, new filename. */
const SUPPORT_AGENT_OS = 'windows';
const SUPPORT_AGENT_ARCH = 'amd64';
const SUPPORT_AGENT_FILENAME = `breeze-agent-${SUPPORT_AGENT_OS}-${SUPPORT_AGENT_ARCH}.exe`;

/**
 * Host of this API as it is written into the download filename.
 *
 * This is a WIRE FORMAT, not cosmetics: the Go client parses the filename and
 * rebuilds `https://<apiHost>` from it, so it must round-trip exactly.
 *
 * A nonstandard port is encoded `host_PORT` rather than `host:PORT` because
 * `:` is illegal in a Windows filename — Chromium silently rewrites it to `_`
 * at save time, which is precisely how the MSI filename-token installer
 * shipped a silently-unenrolled install (#2341). Same encoding as
 * `windowsFilenameApiHost()`; that helper is not reused here because it fails
 * hard on non-https, and a self-hosted/dev http server must still be able to
 * hand out a client (the operator passes --server explicitly in that case).
 */
function supportDownloadApiHost(): string | null {
  const raw = process.env.PUBLIC_API_URL ?? process.env.API_URL ?? '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  return url.port ? `${url.hostname}_${url.port}` : url.hostname;
}

/**
 * Proxy a remote binary through with OUR Content-Disposition.
 *
 * A 302 to GitHub/S3 would be cheaper, but the redirect target names the file
 * `breeze-agent-windows-amd64.exe` and the whole point of this route is that
 * the code rides in the filename. Streaming the body (rather than buffering)
 * keeps the ~60 MB per download off the heap; the bandwidth cost is accepted
 * for v1. Returns null when the upstream fetch fails so callers can fall back.
 *
 * `source` rather than the URL is logged because the S3 caller passes a
 * presigned URL, whose query string is a live credential.
 */
async function proxyBinary(url: string, filename: string, source: string): Promise<Response | null> {
  let upstream: Response;
  try {
    upstream = await fetch(url);
  } catch (err) {
    console.error(`[support-download] ${source} fetch failed:`, err);
    return null;
  }
  if (!upstream.ok || !upstream.body) {
    console.error(`[support-download] ${source} returned no body (status ${upstream.status})`);
    return null;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename}"`,
    // The one-time code is in the filename — never let a proxy or the browser
    // cache serve this response to the next visitor.
    'Cache-Control': 'no-store',
  };
  const length = upstream.headers.get('content-length');
  if (length) headers['Content-Length'] = length;

  return new Response(upstream.body, { status: 200, headers });
}

/**
 * Serve the support client with the one-time code embedded in the download
 * filename, so the end user never has to type it.
 *
 * The code is soft-validated with the same lookup /check uses. That is a
 * courtesy check, not the security boundary — enrollment is still gated by
 * /redeem's atomic single-use claim. Every rejection is the same bare 404 for
 * the same reason /check returns a bare boolean: no tenant enumeration.
 */
supportPublicRoutes.get('/download/:platform', async (c) => {
  const ip = getTrustedClientIp(c, 'unknown');
  // Shares the /check budget deliberately: both are "an anonymous stranger
  // poking at a code", and a separate bucket would just widen the guess rate.
  const limit = await rateLimiter(getRedis(), `support-check:${ip}`, CHECK_LIMIT, RATE_WINDOW_SECONDS);
  if (!limit.allowed) return c.json({ error: 'rate limited' }, 429);

  // Platform is checked before the code so an unsupported platform never
  // costs a DB round-trip — and so the macOS answer is the same honest
  // "coming soon" whether or not the caller holds a real code.
  const platform = c.req.param('platform');
  if (!SUPPORT_CLIENT_PLATFORMS.has(platform)) {
    return c.json({ error: `Unsupported platform: ${platform}` }, 400);
  }
  if (platform === 'macos') {
    return c.json({ error: 'macOS support client coming soon' }, 400);
  }

  const code = normalizeSupportCode(c.req.query('code') ?? '');
  if (!code) return c.json({ error: 'invalid or expired code' }, 404);

  const [row] = await withSystemDbAccessContext(() => db
    .select({
      status: supportSessions.status,
      codeExpiresAt: supportSessions.codeExpiresAt,
    })
    .from(supportSessions)
    .where(eq(supportSessions.codeHash, hashSupportCode(code)))
    .limit(1)) as Array<{ status: string; codeExpiresAt: Date }>;

  if (!row || row.status !== 'pending' || row.codeExpiresAt <= new Date()) {
    return c.json({ error: 'invalid or expired code' }, 404);
  }

  const apiHost = supportDownloadApiHost();
  if (!apiHost) {
    // Serving a client whose filename cannot carry a server URL would produce
    // a download that can never connect — fail loudly instead (#2341).
    console.error('[support-download] PUBLIC_API_URL is unset or unparseable; cannot build filename');
    return c.json({ error: 'support client unavailable' }, 503);
  }

  const filename = `breeze-support-${code}-${apiHost}.exe`;

  if (getBinarySource() === 'github') {
    const res = await proxyBinary(getGithubAgentUrl(SUPPORT_AGENT_OS, SUPPORT_AGENT_ARCH), filename, 'github');
    return res ?? c.json({ error: 'support client unavailable' }, 503);
  }

  // Local mode: S3 is proxied rather than redirected, for the same
  // filename-preservation reason as the GitHub branch above.
  if (isS3Configured()) {
    try {
      const url = await getPresignedUrl(`agent/${SUPPORT_AGENT_FILENAME}`);
      const res = await proxyBinary(url, filename, 's3');
      if (res) return res;
    } catch (err) {
      if (!isS3NotFound(err)) {
        console.error(`[support-download] S3 presign failed for ${SUPPORT_AGENT_FILENAME}:`, err);
        return c.json({ error: 'support client unavailable' }, 503);
      }
      console.warn(`[support-download] S3 object missing for ${SUPPORT_AGENT_FILENAME}, falling back to disk`);
    }
  }

  // Local mode: serve from disk (mirrors routes/agents/download.ts, but the
  // on-disk name is replaced by the code-bearing one on the way out).
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  const filePath = join(binaryDir, SUPPORT_AGENT_FILENAME);

  let fileStat: ReturnType<typeof statSync>;
  let stream: ReturnType<typeof createReadStream>;
  try {
    fileStat = statSync(filePath);
    stream = createReadStream(filePath);
  } catch (err) {
    console.error(`[support-download] local binary unavailable at ${filePath}:`, err);
    return c.json({ error: 'support client unavailable' }, 503);
  }

  const webStream = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: string | Buffer) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(bytes));
      });
      stream.on('end', () => controller.close());
      stream.on('error', (err) => {
        console.error('[support-download] stream error:', err);
        controller.error(err);
      });
    },
    cancel() {
      stream.destroy();
    },
  });

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(fileStat.size),
      'Cache-Control': 'no-store',
    },
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
