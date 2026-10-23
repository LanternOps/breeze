/**
 * Platform-admin partner entitlement API (Partner Entitlements W1 §11, #9907).
 *
 *   GET    /api/v1/admin/partners/:partnerId/entitlements
 *   PUT    /api/v1/admin/partners/:partnerId/entitlements/:featureKey   (+ MFA)
 *   DELETE /api/v1/admin/partners/:partnerId/entitlements/:featureKey   (+ MFA)
 *
 * WHY PLATFORM-ADMIN ONLY: an entitlement is a commercial fact about a partner
 * (what it bought or was comped); a partner must never be able to grant itself
 * one. Mounted under `platformAdminMiddleware` in admin/index.ts.
 *
 * SOURCE IS NOT A CALLER INPUT: this surface only ever writes the `manual`
 * row (`billing`/`license` rows belong to their own writers). The bodies are
 * strict objects, so a `source` field is a 400 rather than silently dropped.
 *
 * Writes run in a system DB context inside the service (the admin's own JWT
 * may be partner-scoped to a DIFFERENT partner), and the audit row is
 * attributed to the TARGET partner so the grant shows in that partner's audit
 * trail. The audit never carries the `limits` value (open container, spec §11)
 * — only whether one was set. No admin web UI in this wave.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { ENTITLEMENTS, ENTITLEMENT_KEYS, isEntitlementKey, type EntitlementKey } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partners } from '../../db/schema/orgs';
import { partnerEntitlements } from '../../db/schema/partnerEntitlements';
import { zValidator } from '../../lib/validation';
import { requireMfa } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  EntitlementLimitsError,
  EntitlementResolutionError,
  getEntitlements,
  invalidateEntitlementCache,
  revokeEntitlementRow,
  upsertEntitlementRow,
  type ResolvedEntitlement,
  type ResolvedEntitlements
} from '../../services/entitlements';

export const entitlementsAdminRoutes = new Hono();

const partnerParamSchema = z.object({ partnerId: z.string().guid() });
const entitlementParamSchema = z.object({
  partnerId: z.string().guid(),
  featureKey: z.string().min(1).max(64)
});
const reasonSchema = z.string().trim().min(10).max(500);
const grantBodySchema = z.strictObject({
  state: z.enum(['enabled', 'disabled']),
  limits: z.unknown().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
  reason: reasonSchema
});
const revokeBodySchema = z.strictObject({ reason: reasonSchema });

function inSystemContext<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, 'entitlements.admin'));
}

// getEntitlements resolves a missing partner to plan `free` rather than
// failing, so existence is checked explicitly before anything else.
async function partnerExists(partnerId: string): Promise<boolean> {
  const rows = await inSystemContext(() =>
    db.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)).limit(1)
  );
  return rows.length > 0;
}

function serialize(key: EntitlementKey, e: ResolvedEntitlement) {
  return {
    key,
    label: ENTITLEMENTS[key].label,
    why: ENTITLEMENTS[key].why,
    state: e.state,
    source: e.source,
    limits: e.limits,
    expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,
    graceUntil: e.graceUntil ? e.graceUntil.toISOString() : null,
    reason: e.reason
  };
}

function resolutionUnavailable(c: Context) {
  c.header('Retry-After', '30');
  return c.json({ code: 'entitlement_check_failed', error: 'Entitlement check temporarily unavailable' }, 503);
}

/**
 * Re-resolve after a committed write. The service also invalidates after
 * commit; invalidating here too makes this read fresh regardless of when the
 * deferred work runs. A resolution failure is reported by the resolver and
 * yields null — the write already happened and must not read as failed.
 */
async function readBack(partnerId: string): Promise<ResolvedEntitlements | null> {
  invalidateEntitlementCache(partnerId);
  try {
    return await getEntitlements(partnerId);
  } catch (err) {
    if (err instanceof EntitlementResolutionError) return null;
    throw err;
  }
}

function committedResponse(c: Context, key: EntitlementKey, after: ResolvedEntitlements | null) {
  if (!after) return c.json({ data: null, warning: 'Saved; the resolved state could not be read back' });
  return c.json({ data: serialize(key, after.entitlements[key]) });
}

entitlementsAdminRoutes.get(
  '/partners/:partnerId/entitlements',
  zValidator('param', partnerParamSchema),
  async (c) => {
    const { partnerId } = c.req.valid('param');
    if (!(await partnerExists(partnerId))) return c.json({ error: 'Partner not found' }, 404);
    try {
      const resolved = await getEntitlements(partnerId);
      const rows = await inSystemContext(() =>
        db.select().from(partnerEntitlements).where(eq(partnerEntitlements.partnerId, partnerId))
      );
      return c.json({
        plan: resolved.plan,
        resolved: ENTITLEMENT_KEYS.map((key) => serialize(key, resolved.entitlements[key])),
        rows
      });
    } catch (err) {
      if (err instanceof EntitlementResolutionError) return resolutionUnavailable(c);
      throw err;
    }
  }
);

entitlementsAdminRoutes.put(
  '/partners/:partnerId/entitlements/:featureKey',
  requireMfa(),
  zValidator('param', entitlementParamSchema),
  zValidator('json', grantBodySchema),
  async (c) => {
    const { partnerId, featureKey } = c.req.valid('param');
    const body = c.req.valid('json');
    if (!isEntitlementKey(featureKey)) return c.json({ error: 'Unknown feature key', featureKey }, 400);
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      return c.json({ error: 'expiresAt must be in the future' }, 400);
    }
    if (!(await partnerExists(partnerId))) return c.json({ error: 'Partner not found' }, 404);

    const auth = c.get('auth');
    const limits = body.limits ?? null;
    let before: ResolvedEntitlements;
    try {
      before = await getEntitlements(partnerId);
    } catch (err) {
      if (err instanceof EntitlementResolutionError) return resolutionUnavailable(c);
      throw err;
    }
    try {
      await upsertEntitlementRow({
        partnerId,
        featureKey,
        source: 'manual',
        state: body.state,
        limits,
        expiresAt,
        reason: body.reason,
        updatedBy: auth.user.id
      });
    } catch (err) {
      if (err instanceof EntitlementLimitsError) return c.json({ error: 'Invalid limits', issues: err.issues }, 400);
      throw err;
    }

    // The write has COMMITTED: from here on nothing may skip the audit or turn
    // the response into a failure. `manual` is the top-ranked source, so the
    // granted state is the resolved state.
    const after = await readBack(partnerId);
    writeRouteAudit(c, {
      orgId: null,
      partnerId,
      action: 'partner.entitlement.granted',
      resourceType: 'partner_entitlement',
      resourceId: partnerId,
      details: {
        partnerId,
        featureKey,
        from: before.entitlements[featureKey].state,
        to: after?.entitlements[featureKey].state ?? body.state,
        source: 'manual',
        reason: body.reason,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        limitsPresent: limits !== null
      },
      result: 'success'
    });
    return committedResponse(c, featureKey, after);
  }
);

entitlementsAdminRoutes.delete(
  '/partners/:partnerId/entitlements/:featureKey',
  requireMfa(),
  zValidator('param', entitlementParamSchema),
  zValidator('json', revokeBodySchema),
  async (c) => {
    const { partnerId, featureKey } = c.req.valid('param');
    const { reason } = c.req.valid('json');
    if (!isEntitlementKey(featureKey)) return c.json({ error: 'Unknown feature key', featureKey }, 400);
    if (!(await partnerExists(partnerId))) return c.json({ error: 'Partner not found' }, 404);

    let before: ResolvedEntitlements;
    try {
      before = await getEntitlements(partnerId);
    } catch (err) {
      if (err instanceof EntitlementResolutionError) return resolutionUnavailable(c);
      throw err;
    }
    const revoked = await revokeEntitlementRow({ partnerId, featureKey, source: 'manual', reason });
    if (!revoked) return c.json({ error: 'No live manual entitlement' }, 404);

    // Committed — always audit. The state underneath (billing/licence/plan) is
    // only known from the read-back; null when that read fails.
    const after = await readBack(partnerId);
    writeRouteAudit(c, {
      orgId: null,
      partnerId,
      action: 'partner.entitlement.revoked',
      resourceType: 'partner_entitlement',
      resourceId: partnerId,
      details: {
        partnerId,
        featureKey,
        from: before.entitlements[featureKey].state,
        to: after?.entitlements[featureKey].state ?? null,
        source: 'manual',
        reason,
        expiresAt: null,
        limitsPresent: false
      },
      result: 'success'
    });
    return committedResponse(c, featureKey, after);
  }
);
