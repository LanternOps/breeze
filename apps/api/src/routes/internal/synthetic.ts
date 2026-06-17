/**
 * Internal Synthetic Test Router
 *
 * Control plane for the live sign-up synthetic monitor. Off-by-default and
 * gated four ways (checked in this order):
 *   1. SYNTHETIC_TEST_TOKEN env presence (unset → 503).
 *   2. Timing-safe bearer-token match (mismatch → 401). Checked BEFORE the IP
 *      allowlist so an unauthenticated caller always sees 401 regardless of
 *      source IP — the gate ordering must not leak allowlist membership.
 *   3. Optional CSV IP allowlist via SYNTHETIC_TEST_IP_ALLOWLIST (miss → 403).
 *   4. A hard CANARY LATCH: every mutating endpoint refuses (422) any partner
 *      whose admin email is not `signup-canary+...@2breeze.app`. This is the
 *      load-bearing safety property — even if the token leaks, only synthetic
 *      canary accounts can ever be mutated or purged.
 *
 * Mounted at `/api/v1/internal/synthetic` in apps/api/src/index.ts.
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

// audit_logs.actor_id is a uuid column, so the synthetic actor is the nil-uuid
// sentinel (same pattern terminalWs/tunnelWs use for system actors). The
// human-readable marker lives in actorEmail + the `test.synthetic_partner.*`
// action names. A plain string here silently fails the audit insert (caught by
// the cascadeDeletePartner integration test).
const PERFORMED_BY = '00000000-0000-0000-0000-000000000000';
const PERFORMED_BY_LABEL = 'synthetic-test-monitor';
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

  // Bearer check first: an unauthenticated caller must see 401 whether or not
  // their IP is on the allowlist, so probing the allowlist requires a valid
  // token. (Reordered from IP-first per security review.)
  if (!safeEqual(c.req.header('Authorization') ?? '', `Bearer ${expected}`)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const allow = ipAllowlist();
  if (allow.size > 0) {
    const ip = getTrustedClientIpOrUndefined(c);
    if (!ip || !allow.has(ip)) return c.json({ error: 'Forbidden' }, 403);
  }

  return next();
});

// partnerId is validated as a uuid. The canary latch (isCanary) is the real
// safety gate, but validating the shape here gives a clean 400 instead of a
// Postgres 22P02 (invalid_input_syntax) bubbling up as a 500 when a non-uuid
// is passed to the uuid-typed `partners.id` column.
const bodySchema = z.object({ partnerId: z.string().guid() });

/**
 * The canary latch. Returns true only when the partner has at least one member
 * AND EVERY member's email matches the synthetic-canary pattern. Requiring all
 * members to match (rather than any single arbitrary row) makes the check
 * deterministic and self-contained: a real partner that somehow had a canary
 * member attached would still NOT match, because its real members fail the regex.
 * A non-existent partner (no rows) is not a canary.
 */
async function isCanary(partnerId: string): Promise<boolean> {
  const rows = await withSystemDbAccessContext(() =>
    db
      .select({ email: users.email })
      .from(partners)
      .innerJoin(partnerUsers, eq(partnerUsers.partnerId, partners.id))
      .innerJoin(users, eq(users.id, partnerUsers.userId))
      .where(eq(partners.id, partnerId)),
  );
  return rows.length > 0 && rows.every((r) => CANARY_EMAIL_RE.test((r.email as string | null) ?? ''));
}

internalSyntheticRoutes.post('/simulate-payment', async (c) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'valid partnerId (uuid) required' }, 400);
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
      actorEmail: PERFORMED_BY_LABEL,
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
  if (!parsed.success) return c.json({ error: 'valid partnerId (uuid) required' }, 400);
  const { partnerId } = parsed.data;

  if (!(await isCanary(partnerId))) return c.json({ error: 'Not a synthetic canary partner' }, 422);

  const stats = await cascadeDeletePartner(partnerId, PERFORMED_BY);
  return c.json({ purged: true, partnerId, stats });
});

// Sweep-by-pattern fallback. The per-run monitor tracks each canary the instant
// it parses the id, but a registration whose RESPONSE is lost (socket reset /
// gateway timeout) leaves an orphan the run can never clean up. This endpoint
// finds canary partners older than a cutoff and purges them — every candidate
// is re-validated through the SAME `isCanary` latch before any delete, so it
// can only ever touch synthetic canaries.
const sweepSchema = z.object({ olderThanMinutes: z.number().int().min(0).max(10_080).optional() });

internalSyntheticRoutes.post('/purge-stale-canaries', async (c) => {
  const parsed = sweepSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'olderThanMinutes must be an integer' }, 400);
  const minutes = parsed.data.olderThanMinutes ?? 60;

  // Candidate partners: at least one member matching the canary email shape,
  // created before the cutoff. ILIKE is only a coarse pre-filter — `isCanary`
  // (strict regex, ALL members must match) is the authoritative gate below.
  const candidates = (await withSystemDbAccessContext(() =>
    db
      .selectDistinct({ id: partners.id })
      .from(partners)
      .innerJoin(partnerUsers, eq(partnerUsers.partnerId, partners.id))
      .innerJoin(users, eq(users.id, partnerUsers.userId))
      .where(
        sql`${users.email} ILIKE 'signup-canary+%@2breeze.app' AND ${partners.createdAt} < now() - make_interval(mins => ${minutes})`,
      ),
  )) as Array<{ id: string }>;

  const purged: string[] = [];
  const skipped: string[] = [];
  for (const { id } of candidates) {
    if (!(await isCanary(id))) {
      skipped.push(id);
      continue;
    }
    await cascadeDeletePartner(id, PERFORMED_BY);
    purged.push(id);
  }

  return c.json({ swept: true, olderThanMinutes: minutes, purged, skipped });
});
