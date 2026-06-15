/**
 * Internal Synthetic Test Router
 *
 * Control plane for the live sign-up synthetic monitor. Off-by-default and
 * gated four ways:
 *   1. SYNTHETIC_TEST_TOKEN env presence (unset → 503).
 *   2. Timing-safe bearer-token match (mismatch → 401).
 *   3. Optional CSV IP allowlist via SYNTHETIC_TEST_IP_ALLOWLIST (miss → 403).
 *   4. A hard CANARY LATCH: every mutating endpoint refuses (422) any partner
 *      whose admin email is not `signup-canary+...@2breeze.app`. This is the
 *      load-bearing safety property — even if the token leaks, only synthetic
 *      canary accounts can ever be mutated or purged.
 *
 * NOT mounted into the route tree here; mounting is a separate task.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createHash, timingSafeEqual } from 'crypto';
import { eq, sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import { partners, partnerUsers, users } from '../../db/schema';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { cascadeDeletePartner } from '../../services/tenantCascade';
import { createAuditLog } from '../../services/auditService';

export const internalSyntheticRoutes = new Hono();

const PERFORMED_BY = 'synthetic-test-monitor';
const CANARY_EMAIL_RE = /^signup-canary\+[^@]*@2breeze\.app$/i;

function token(): string | undefined {
  return process.env.SYNTHETIC_TEST_TOKEN?.trim() || undefined;
}

function ipAllowlist(): Set<string> {
  const raw = process.env.SYNTHETIC_TEST_IP_ALLOWLIST;
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

internalSyntheticRoutes.use('*', async (c, next) => {
  const expected = token();
  if (!expected) return c.json({ error: 'Synthetic test endpoints are not configured' }, 503);

  const allow = ipAllowlist();
  if (allow.size > 0) {
    const ip = getTrustedClientIpOrUndefined(c);
    if (!ip || !allow.has(ip)) return c.json({ error: 'Forbidden' }, 403);
  }

  if (!safeEqual(c.req.header('Authorization') ?? '', `Bearer ${expected}`)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return next();
});

// partnerId is validated as a non-empty string, NOT a UUID: the canary latch
// (isCanary → 422) is the real gate, and a malformed id simply finds no canary
// row and gets rejected there. Requiring uuid() here would only add a 400 path
// without strengthening the safety property.
const bodySchema = z.object({ partnerId: z.string().min(1) });

/**
 * The canary latch. Returns true only when the partner's admin (partner_users)
 * email matches the synthetic-canary pattern. Anything else — a real partner,
 * a non-existent id, or a partner with no admin user — is NOT a canary.
 */
async function isCanary(partnerId: string): Promise<boolean> {
  // The partner→admin join is expressed as a correlated subquery in the
  // projection (rather than .innerJoin()) so the whole read stays a single
  // select().from().where().limit() chain. Any admin user on the partner whose
  // email matches the canary pattern makes the partner a canary.
  const rows = await withSystemDbAccessContext(() =>
    db
      .select({
        id: partners.id,
        adminEmail: sql<string | null>`(
          SELECT ${users.email}
          FROM ${users}
          JOIN ${partnerUsers} ON ${partnerUsers.userId} = ${users.id}
          WHERE ${partnerUsers.partnerId} = ${partners.id}
            AND ${users.email} ILIKE 'signup-canary+%@2breeze.app'
          LIMIT 1
        )`,
      })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1),
  );
  const row = rows?.[0];
  return !!row && CANARY_EMAIL_RE.test((row.adminEmail as string | null) ?? '');
}

internalSyntheticRoutes.post('/simulate-payment', async (c) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'partnerId (uuid) required' }, 400);
  const { partnerId } = parsed.data;

  if (!(await isCanary(partnerId))) return c.json({ error: 'Not a synthetic canary partner' }, 422);

  // Writes the payment timestamp the partnerGuard reconciliation reacts to.
  // Intentionally does NOT flip `status` — that transition is owned by the
  // reconciliation path, not this synthetic control plane.
  await withSystemDbAccessContext(() =>
    db
      .update(partners)
      .set({
        paymentMethodAttachedAt: new Date(),
        stripeCustomerId: sql`COALESCE(${partners.stripeCustomerId}, ${'cus_canary_' + partnerId})`,
        updatedAt: new Date(),
      })
      .where(eq(partners.id, partnerId)),
  );

  // Best-effort audit: the partner mutation has already landed, so an audit
  // persistence hiccup must not turn a successful simulation into a 500.
  try {
    await createAuditLog({
      orgId: null,
      actorType: 'system',
      actorId: PERFORMED_BY,
      action: 'test.synthetic_partner.payment_simulated',
      resourceType: 'partner',
      resourceId: partnerId,
      result: 'success',
      details: { partnerId },
    });
  } catch (err) {
    console.warn('[synthetic] payment-simulated audit write failed:', err);
  }

  return c.json({ simulated: true, partnerId });
});

internalSyntheticRoutes.post('/purge-partner', async (c) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'partnerId (uuid) required' }, 400);
  const { partnerId } = parsed.data;

  if (!(await isCanary(partnerId))) return c.json({ error: 'Not a synthetic canary partner' }, 422);

  const stats = await cascadeDeletePartner(partnerId, PERFORMED_BY);
  return c.json({ purged: true, partnerId, stats });
});
