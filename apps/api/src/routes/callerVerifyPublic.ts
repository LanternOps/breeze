/**
 * Public caller-verification card (#6354 W03): GET/POST /api/v1/verify/:token.
 *
 * Unauthenticated by design — the 32-byte link token delivered by SMS/email
 * is the only credential, exactly like the Quick Support code at /support.
 * Guards, in order:
 *   1. flag off → 404 before ANY Redis or DB work;
 *   2. per-IP request limit (fails closed when Redis is down);
 *   3. per-source + global miss budget in the `caller-verification` namespace
 *      (isolated from Quick Support);
 *   4. per-token limit, keyed by the token DIGEST so the clear token never
 *      reaches Redis or a log line;
 *   5. hash lookup in one short `withSystemDbAccessContext`.
 *
 * Opacity: unknown, malformed, used, rejected and expired tokens all answer
 * `{status:'expired'}`; every well-formed POST answers `{status:'received'}`
 * whatever happened (miss, CAS loser, wrong number, late rejection). Nothing
 * returned names an id, the match role, a destination, tier or fence state.
 * Every response is `Cache-Control: no-store, private` + `no-referrer`.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { isCallerVerificationEnabled } from '../services/callerVerification/gate';
import { isLiveCard, lookupPublicToken, toPublicCard } from '../services/callerVerification/publicLookup';
import { LINK_TOKEN_RE, hashLinkToken } from '../services/callerVerification/linkChallenge';
import { applyDecision } from '../services/callerVerification/service';
import { CallerVerificationValidationError } from '../services/callerVerification/errors';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { getTrustedClientIp, rateLimitIpKey } from '../services/clientIp';
import { isSupportCodeMissBudgetExhausted, recordSupportCodeMiss } from '../services/supportCodeMissBudget';

const IP_LIMIT = 30;
const IP_WINDOW_SECONDS = 60;
const TOKEN_LIMIT = 30;
const TOKEN_WINDOW_SECONDS = 600;
const NAMESPACE = 'caller-verification' as const;

const EXPIRED = { status: 'expired' } as const;
const RECEIVED = { status: 'received' } as const;
const RATE_LIMITED = { error: 'Too many requests. Try again shortly.' } as const;

const choiceSchema = z.object({ choice: z.union([z.literal('not_me'), z.string().regex(/^\d{2}$/)]) }).strict();

export const callerVerifyPublicRoutes = new Hono();

callerVerifyPublicRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store, private');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  if (!isCallerVerificationEnabled()) return c.json({ error: 'Not found' }, 404);
  const ip = getTrustedClientIp(c, 'unknown');
  const limit = await rateLimiter(getRedis(), `caller-verification:public:${rateLimitIpKey(ip)}`, IP_LIMIT, IP_WINDOW_SECONDS);
  if (!limit.allowed) return c.json(RATE_LIMITED, 429);
  return next();
});

/** Budgets shared by GET and POST for a well-formed token. True = refuse (429). */
async function budgetRefusal(ip: string, tokenHash: string): Promise<boolean> {
  const redis = getRedis();
  if (await isSupportCodeMissBudgetExhausted(redis, ip, NAMESPACE)) return true;
  const perToken = await rateLimiter(redis, `caller-verification:token:${tokenHash}`, TOKEN_LIMIT, TOKEN_WINDOW_SECONDS);
  return !perToken.allowed;
}

callerVerifyPublicRoutes.get('/:token', async (c) => {
  const token = c.req.param('token');
  if (!LINK_TOKEN_RE.test(token)) return c.json(EXPIRED);
  const ip = getTrustedClientIp(c, 'unknown');
  const tokenHash = hashLinkToken(token);
  if (await budgetRefusal(ip, tokenHash)) return c.json(RATE_LIMITED, 429);

  const row = await runOutsideDbContext(() => withSystemDbAccessContext(
    () => lookupPublicToken(tokenHash), 'callerVerification.public.lookup',
  ));
  // Only an unknown token is a guess; a real-but-spent link is not.
  if (!row) await recordSupportCodeMiss(getRedis(), ip, NAMESPACE);
  if (!isLiveCard(row)) return c.json(EXPIRED);
  return c.json(toPublicCard(row));
});

callerVerifyPublicRoutes.post('/:token', async (c) => {
  const parsed = choiceSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid choice' }, 400);
  const token = c.req.param('token');
  if (!LINK_TOKEN_RE.test(token)) return c.json(RECEIVED);
  const ip = getTrustedClientIp(c, 'unknown');
  const tokenHash = hashLinkToken(token);
  if (await budgetRefusal(ip, tokenHash)) return c.json(RATE_LIMITED, 429);

  const choice = parsed.data.choice;
  // Lookup and decision share one short system transaction; applyDecision
  // reuses it (it opens its own only when no context exists).
  const found = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const row = await lookupPublicToken(tokenHash);
    if (!row) return false;
    if (row.method !== 'sms' && row.method !== 'email') return true;
    try {
      await applyDecision({
        verificationId: row.id,
        decision: choice === 'not_me' ? { kind: 'not_me' } : { kind: 'choice', value: choice },
        ...(ip === 'unknown' ? {} : { fromIp: ip }),
      });
    } catch (error) {
      if (!(error instanceof CallerVerificationValidationError && error.code === 'not_found')) throw error;
    }
    return true;
  }, 'callerVerification.public.decide'));
  if (!found) await recordSupportCodeMiss(getRedis(), ip, NAMESPACE);
  return c.json(RECEIVED);
});
