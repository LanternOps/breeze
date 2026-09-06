import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { randomBytes } from 'node:crypto';
import { statSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { normalizeSupportCode, redeemSupportSessionSchema } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../db';
import {
  enrollmentKeys,
  organizations,
  partnerLoginBranding,
  partners,
  sites,
  supportSessions,
} from '../db/schema';
import { hashSupportCode } from '../services/quickSupportCode';
import { hashEnrollmentKey, hashEnrollmentSecret } from '../services/enrollmentKeySecurity';
import { getBinarySource, getGithubAgentUrl } from '../services/binarySource';
import { isS3Configured, getPresignedUrl, isS3NotFound } from '../services/s3Storage';
import { rateLimiter } from '../services/rate-limit';
import { getRedis } from '../services/redis';
import { getTrustedClientIp, rateLimitIpKey } from '../services/clientIp';
import {
  isSupportCodeMissBudgetExhausted,
  recordSupportCodeMiss,
} from '../services/supportCodeMissBudget';
import { logSessionAudit } from './remote/helpers';
import { evaluateCapability } from '../services/partnerTrust';
import { partnerTrustMode } from '../config/partnerTrustMode';

/**
 * Public Quick Support endpoints — the one-time code IS the authentication.
 *
 * Everything here is unauthenticated by design (the end user is a stranger
 * holding a code their technician read out), so the guards are: ~27 bits of
 * code entropy, a 15-minute redemption TTL, per-IP rate limits, a two-tier
 * failed-lookup budget (services/supportCodeMissBudget.ts), and a single atomic
 * pending->claimed transition that makes a code strictly single-use.
 *
 * The miss budget is the control that matters against a distributed guesser:
 * per-IP limits only bound one host. Every well-formed code that matches no
 * live session — on ANY of the three endpoints here — spends from the caller's
 * per-source /64 sub-budget AND a much higher deployment-wide backstop;
 * successful lookups never do. A single source can only ever degrade itself;
 * blanket degradation needs a broadly distributed attack that trips the
 * backstop. A miss carries no partner (the code resolved to nothing), so a
 * per-partner budget is not possible — the source /64 is the only identity it
 * has.
 *
 * These handlers run under withSystemDbAccessContext because an anonymous
 * caller has no org context at all — the code lookup is the authorization.
 */
export const supportPublicRoutes = new Hono();

const CHECK_LIMIT = 30;
const REDEEM_LIMIT = 10;
const RATE_WINDOW_SECONDS = 60;

/**
 * /check answers are per-code and per-moment: the same URL is `valid` for 15
 * minutes and `invalid` forever after, and the code in the path is a bearer
 * credential. `private` keeps shared caches out of it entirely; `no-store`
 * keeps the browser's own disk cache from retaining an answer keyed by a live
 * code. Applied to every /check response — valid, invalid AND 429 — because a
 * cached 429 would be just as wrong for the next visitor behind the same NAT.
 */
const CHECK_CACHE_HEADERS = { 'Cache-Control': 'no-store, private' } as const;

/**
 * Caps on the partner-supplied display strings echoed to the public landing
 * page. Truncate rather than reject: an over-long headline is a partner typo,
 * not an attack, and dropping the whole branding block over it would make the
 * end user's page look broken. The page itself must still treat these as
 * untrusted text (React escapes them).
 */
const MAX_PARTNER_NAME_CHARS = 120;
const MAX_HEADLINE_CHARS = 200;

/** Child enrollment keys are minted with the same lifetime as the code. */
const CHILD_KEY_TTL_MS = 15 * 60_000;

/**
 * A hex accent color is interpolated straight into an inline style on the
 * public landing page, so only the exact 6-digit form ever leaves this route.
 * The column is partner-writable; anything else is dropped rather than trusted.
 */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

async function anonymousInstallerDistributionAllowed(
  orgId: string,
  route: 'public-download' | 'code-redemption',
): Promise<boolean> {
  if (partnerTrustMode() === 'off') return true;

  const [org] = await withSystemDbAccessContext(() => db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1));
  if (!org?.partnerId) return false;

  const decision = await evaluateCapability('installer_distribute', {
    partnerId: org.partnerId,
    orgId,
    detail: { route },
  });
  return decision.allow;
}

/** Display-only branding for the end-user page — never IDs, never tenant keys. */
type CheckBranding = {
  partnerName: string;
  logoUrl: string | null;
  accentColor: string | null;
  headline: string | null;
};

type CheckRow = {
  status: string;
  codeExpiresAt: Date;
  partnerName: string | null;
  logoUrl: string | null;
  accentColor: string | null;
  headline: string | null;
};

/**
 * Is this code redeemable right now?
 *
 * THREAT MODEL — read this before changing the response shape.
 *
 * The code IS a bearer credential. Anyone holding it can download a client and
 * redeem it for a single-use enrollment key; there is no second factor, no
 * account, and no session. It carries ~27 bits (digits 2-9, length 9 => ~134M
 * codes), lives 15 minutes, and only its SHA-256 is stored.
 *
 * A VALID response deliberately DISCLOSES the minting partner's display
 * branding — name, logo, accent color, headline. That is a real disclosure and
 * it is the intended product behavior: the end user is a stranger about to run
 * a remote-access client, and showing them which MSP is actually helping is
 * what makes that a safe thing to ask of them. The disclosure is bounded to
 * display fields the partner already publishes on their login page; no
 * partnerId, orgId or sessionId is ever emitted, so nothing here can be
 * replayed against another route. Every field is re-validated on the way out
 * (hex-only accent color, https-only logo, length-capped text).
 *
 * An INVALID response discloses NOTHING — a bare `{valid:false}`, identical
 * for malformed, unknown, expired and already-claimed codes. So branding is a
 * reward for already holding a live code, never a way to enumerate tenants.
 *
 * GUESSING is bounded by three independent controls, not by entropy alone:
 * per-IP limits (30/min shared with /download, 10/min on /redeem), the two-tier
 * miss budget below (a per-source /64 sub-budget of ~30 well-formed misses/min
 * that stops one guessing network without touching anyone else, plus a ~500/min
 * deployment-wide backstop that only trips under broadly distributed guessing),
 * and the 15-minute TTL that replaces the entire target set four times an hour.
 * Successful lookups never spend budget, so holding a real code is unaffected.
 */
supportPublicRoutes.get('/check/:code', async (c) => {
  const redis = getRedis();
  const ip = getTrustedClientIp(c, 'unknown');
  const limit = await rateLimiter(redis, `support-check:${rateLimitIpKey(ip)}`, CHECK_LIMIT, RATE_WINDOW_SECONDS);
  if (!limit.allowed) return c.json({ error: 'rate limited' }, 429, CHECK_CACHE_HEADERS);

  const code = normalizeSupportCode(c.req.param('code'));
  // Malformed input can never match a stored hash — skip the DB entirely, and
  // deliberately neither spend nor consult the global miss budget: it is not a
  // guess against the code space, so counting it would only blur the counter's
  // meaning (it buys an attacker nothing either way — well-formed misses are
  // exactly as cheap to send).
  if (!code) return c.json({ valid: false }, 200, CHECK_CACHE_HEADERS);

  // Sub-budget or backstop spent for this window => answer exactly as if per-IP
  // limited. The causes are deliberately indistinguishable: telling a guesser
  // which control they tripped tells them the control exists and its period.
  if (await isSupportCodeMissBudgetExhausted(redis, ip)) {
    return c.json({ error: 'rate limited' }, 429, CHECK_CACHE_HEADERS);
  }

  // Every join is a LEFT join on purpose: validity is decided by the session
  // columns alone, so a missing org/partner/branding row can never turn a live
  // code into "expired" for the end user.
  const [row] = await withSystemDbAccessContext(() => db
    .select({
      status: supportSessions.status,
      codeExpiresAt: supportSessions.codeExpiresAt,
      partnerName: partners.name,
      logoUrl: partnerLoginBranding.logoUrl,
      accentColor: partnerLoginBranding.accentColor,
      headline: partnerLoginBranding.headline,
    })
    .from(supportSessions)
    .leftJoin(organizations, eq(organizations.id, supportSessions.orgId))
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .leftJoin(partnerLoginBranding, eq(partnerLoginBranding.partnerId, partners.id))
    .where(eq(supportSessions.codeHash, hashSupportCode(code)))
    .limit(1)) as CheckRow[];

  if (!row || row.status !== 'pending' || row.codeExpiresAt <= new Date()) {
    await recordSupportCodeMiss(redis, ip);
    return c.json({ valid: false }, 200, CHECK_CACHE_HEADERS);
  }

  // A partner with no usable display name gets no branding block at all rather
  // than an empty one — the landing page falls back to plain Breeze chrome.
  const partnerName = cappedText(row.partnerName, MAX_PARTNER_NAME_CHARS);
  const branding: CheckBranding | null = partnerName
    ? {
        partnerName,
        logoUrl: httpsOnlyUrl(row.logoUrl),
        accentColor: row.accentColor && HEX_COLOR.test(row.accentColor) ? row.accentColor : null,
        headline: cappedText(row.headline, MAX_HEADLINE_CHARS),
      }
    : null;

  return c.json({ valid: true, branding }, 200, CHECK_CACHE_HEADERS);
});

/**
 * Partner-supplied text, coerced to a plain string and truncated. Anything that
 * is not a non-empty string (including a stray non-string that survived the
 * driver) becomes null so the field is simply absent rather than rendering
 * `[object Object]` on a public page.
 */
function cappedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Partner-supplied logo URL, admitted only when it parses AND its protocol is
 * exactly `https:`. Dropped otherwise — the column is partner-writable, and the
 * value goes into an <img src> on an unauthenticated page, so `javascript:`,
 * `data:` and plain `http:` (mixed content, and a plaintext beacon) all have to
 * die here rather than rely on the client's sanitizer. The remaining, accepted,
 * risk is that any https host the partner names sees the end user's IP — see
 * the img-src note in apps/web/src/middleware.ts.
 */
function httpsOnlyUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * `/download/:platform?code=<CODE>` is a GET with the bearer code in the URL
 * itself (not just the path — /check's `no-store, private` reasoning applies
 * identically here). The successful binary response already sets `no-store`
 * (see proxyBinary and the disk-serving Response below); every early-return
 * JSON response in this handler must match so a proxy or the browser's own
 * disk cache never retains an answer keyed by a live code.
 */
const DOWNLOAD_CACHE_HEADERS = { 'Cache-Control': 'no-store' } as const;

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
  const redis = getRedis();
  const ip = getTrustedClientIp(c, 'unknown');
  // Shares the /check budget deliberately: both are "an anonymous stranger
  // poking at a code", and a separate bucket would just widen the guess rate.
  const limit = await rateLimiter(redis, `support-check:${rateLimitIpKey(ip)}`, CHECK_LIMIT, RATE_WINDOW_SECONDS);
  if (!limit.allowed) return c.json({ error: 'rate limited' }, 429, DOWNLOAD_CACHE_HEADERS);

  // Platform is checked before the code so an unsupported platform never
  // costs a DB round-trip — and so the macOS answer is the same honest
  // "coming soon" whether or not the caller holds a real code.
  const platform = c.req.param('platform');
  if (!SUPPORT_CLIENT_PLATFORMS.has(platform)) {
    return c.json({ error: `Unsupported platform: ${platform}` }, 400, DOWNLOAD_CACHE_HEADERS);
  }
  if (platform === 'macos') {
    return c.json({ error: 'macOS support client coming soon' }, 400, DOWNLOAD_CACHE_HEADERS);
  }

  const code = normalizeSupportCode(c.req.query('code') ?? '');
  if (!code) return c.json({ error: 'invalid or expired code' }, 404, DOWNLOAD_CACHE_HEADERS);

  // Same two-tier guess budget as /check and /redeem, and the same
  // indistinguishable 429 when either tier is spent.
  if (await isSupportCodeMissBudgetExhausted(redis, ip)) {
    return c.json({ error: 'rate limited' }, 429, DOWNLOAD_CACHE_HEADERS);
  }

  const [row] = await withSystemDbAccessContext(() => db
    .select({
      status: supportSessions.status,
      codeExpiresAt: supportSessions.codeExpiresAt,
      orgId: supportSessions.orgId,
    })
    .from(supportSessions)
    .where(eq(supportSessions.codeHash, hashSupportCode(code)))
    .limit(1)) as Array<{ status: string; codeExpiresAt: Date; orgId: string }>;

  if (!row || row.status !== 'pending' || row.codeExpiresAt <= new Date()) {
    await recordSupportCodeMiss(redis, ip);
    return c.json({ error: 'invalid or expired code' }, 404, DOWNLOAD_CACHE_HEADERS);
  }

  if (!await anonymousInstallerDistributionAllowed(row.orgId, 'public-download')) {
    return c.json({ error: 'invalid or expired code' }, 404, DOWNLOAD_CACHE_HEADERS);
  }

  const apiHost = supportDownloadApiHost();
  if (!apiHost) {
    // Serving a client whose filename cannot carry a server URL would produce
    // a download that can never connect — fail loudly instead (#2341).
    console.error('[support-download] PUBLIC_API_URL is unset or unparseable; cannot build filename');
    return c.json({ error: 'support client unavailable' }, 503, DOWNLOAD_CACHE_HEADERS);
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
  const redis = getRedis();
  const ip = getTrustedClientIp(c, 'unknown');
  const limit = await rateLimiter(redis, `support-redeem:${rateLimitIpKey(ip)}`, REDEEM_LIMIT, RATE_WINDOW_SECONDS);
  if (!limit.allowed) return c.json({ error: 'rate limited' }, 429);

  const data = c.req.valid('json');
  const code = normalizeSupportCode(data.code);
  // One indistinguishable failure shape for malformed, unknown, expired and
  // already-claimed codes — nothing here should confirm a code ever existed.
  if (!code) return c.json({ error: 'invalid or expired code' }, 404);

  if (await isSupportCodeMissBudgetExhausted(redis, ip)) {
    return c.json({ error: 'rate limited' }, 429);
  }

  // Set only when the code matched no live session — i.e. a guess. Losing the
  // atomic claim race is NOT a miss: that code was real and live, the caller
  // simply arrived second, and charging it to the guessing budget would let a
  // double-clicking end user pay for an attacker's window.
  let lookupMissed = false;

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
      lookupMissed = true;
      return null;
    }

    if (!await anonymousInstallerDistributionAllowed(row.orgId, 'code-redemption')) {
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

  if (!result) {
    if (lookupMissed) await recordSupportCodeMiss(redis, ip);
    return c.json({ error: 'invalid or expired code' }, 404);
  }

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
