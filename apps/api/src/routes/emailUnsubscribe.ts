import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getTrustedClientIp, rateLimitIpKey } from '../services/clientIp';
import { setEmailOptOut } from '../services/emailOptouts';
import { UNSUBSCRIBE_PATH, unsubscribeSigningConfigured, verifyUnsubscribeToken } from '../services/emailUnsubscribeToken';
import { rateLimiter } from '../services/rate-limit';
import { getRedis } from '../services/redis';

// One-click email unsubscribe (spec 2026-10-15 §5, RFC 8058). Unauthenticated:
// the signed token in `t` is the only credential, and it can do exactly one
// thing — opt its user out of its topic.
//
//   GET  → a confirmation page with a button that POSTs. A GET NEVER writes:
//          link scanners and previewers prefetch URLs.
//   POST → idempotent opt-out (source 'one_click'), 200 for an already
//          unsubscribed or deleted user too. Mail clients send
//          `List-Unsubscribe=One-Click` as the body; it is accepted, not required.
//
// Both are rate limited per trusted client IP and fail closed without Redis
// (the public-route convention). Responses are small self-contained HTML pages
// with their own CSP: no script, one hashed inline style.

export const emailUnsubscribeRoutes = new Hono();

const RATE_LIMIT = 30;
const RATE_WINDOW_SECONDS = 60;

const STYLE = 'body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f7;color:#1f2937}main{max-width:28rem;margin:1rem;padding:2rem;background:#fff;border-radius:12px;box-shadow:0 12px 30px rgba(15,23,42,.06)}h1{font-size:1.25rem;margin:0 0 .75rem}p{line-height:1.5;color:#4b5563}button{margin-top:.5rem;padding:.7rem 1.3rem;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:1rem;cursor:pointer}';
const STYLE_HASH = createHash('sha256').update(STYLE).digest('base64');
const PAGE_CSP = [
  "default-src 'none'",
  `style-src 'sha256-${STYLE_HASH}'`,
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Page text is static; only the (already verified, base64url) token reaches the markup, escaped. */
function page(c: Context, status: 200 | 400 | 429 | 500 | 503, title: string, body: string) {
  c.header('Content-Security-Policy', PAGE_CSP);
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex');
  return c.html(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — Breeze</title><style>${STYLE}</style></head>
<body><main><h1>${title}</h1>${body}</main></body>
</html>`, status);
}

const unavailable = (c: Context) =>
  page(c, 503, 'Please try again shortly', '<p>We could not process this request right now.</p>');

/** A null verification is a bad link — unless the server cannot verify anything, which is a server fault. */
function invalidLink(c: Context) {
  if (!unsubscribeSigningConfigured()) {
    console.error('[email-unsubscribe] no signing secret configured (APP_ENCRYPTION_KEY); every link reads as invalid');
    return unavailable(c);
  }
  return badLink(c);
}

const badLink = (c: Context) => page(
  c,
  400,
  'This link is not valid',
  '<p>The unsubscribe link is incomplete or has been altered. Use the link in the most recent email, or turn the email off under My Account in Breeze.</p>',
);

async function limited(c: Context): Promise<Response | null> {
  const redis = getRedis();
  if (!redis) {
    console.error('[email-unsubscribe] rate limit unavailable: redis client missing');
    return unavailable(c);
  }
  const ip = getTrustedClientIp(c, 'unknown');
  let r: { allowed: boolean };
  try {
    r = await rateLimiter(redis, `email-unsubscribe:${rateLimitIpKey(ip)}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
  } catch (err) {
    console.error('[email-unsubscribe] rate limit check failed:', err instanceof Error ? err.message : String(err));
    return unavailable(c);
  }
  if (!r.allowed) return page(c, 429, 'Too many requests', '<p>Please wait a minute and try again.</p>');
  return null;
}

emailUnsubscribeRoutes.get('/unsubscribe', async (c) => {
  const blocked = await limited(c);
  if (blocked) return blocked;
  const token = c.req.query('t') ?? '';
  if (!verifyUnsubscribeToken(token)) return invalidLink(c);
  const action = `${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}`;
  return page(
    c,
    200,
    'Unsubscribe from the connection health digest?',
    '<p>You will stop receiving the daily connection health email. In-app notices are not affected, and you can turn the email back on under My Account.</p>'
      + `<form method="post" action="${escapeAttr(action)}">`
      + '<input type="hidden" name="List-Unsubscribe" value="One-Click">'
      + '<button type="submit">Unsubscribe</button></form>',
  );
});

emailUnsubscribeRoutes.post('/unsubscribe', async (c) => {
  const blocked = await limited(c);
  if (blocked) return blocked;
  const claims = verifyUnsubscribeToken(c.req.query('t') ?? '');
  if (!claims) return invalidLink(c);
  try {
    const { userExists } = await runOutsideDbContext(() => withSystemDbAccessContext(
      () => setEmailOptOut(claims.userId, claims.topic, 'one_click'),
      'emailUnsubscribe.oneClick',
    ));
    console.log(JSON.stringify({ event: 'email_unsubscribe', topic: claims.topic, userId: claims.userId, userExists }));
  } catch (err) {
    console.error(JSON.stringify({
      event: 'email_unsubscribe_failed',
      topic: claims.topic,
      userId: claims.userId,
      error: err instanceof Error ? err.message : String(err),
    }));
    return page(c, 500, 'Something went wrong', '<p>We could not record your choice. Please try again, or turn the email off under My Account in Breeze.</p>');
  }
  return page(
    c,
    200,
    'You are unsubscribed',
    '<p>You will no longer receive the daily connection health email. You can turn it back on any time under My Account in Breeze.</p>',
  );
});
