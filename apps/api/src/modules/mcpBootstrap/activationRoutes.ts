import type { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import Stripe from 'stripe';
import { db } from '../../db';
import {
  partners,
  partnerActivations,
  apiKeys,
  organizations,
  partnerUsers,
  users,
} from '../../db/schema';
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis';
import { writeAuditEvent } from '../../services/auditEvents';
import { getBreezeBillingClient } from '../../services/breezeBillingClient';
import { recordActivationTransition } from './metrics';

/**
 * Activation routes for MCP-provisioned tenants.
 *
 * Mounted only when `MCP_BOOTSTRAP_ENABLED=true`. Three routes:
 *   GET  /activate/:token              — email-click endpoint
 *   POST /activate/setup-intent        — create Stripe SetupIntent for payment attachment
 *   POST /activate/complete/webhook    — Stripe webhook for setup_intent.succeeded
 */
/**
 * Resolve the partner's default (first-created) organization id. Mirrors the
 * convention used by configure_defaults / send_deployment_invites. Used to
 * scope partner.* audit events so query_audit_log surfaces them for the
 * partner's own MCP caller.
 */
async function resolveDefaultOrgId(partnerId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.partnerId, partnerId))
      .orderBy(asc(organizations.createdAt))
      .limit(1);
    return row?.id ?? null;
  } catch (err) {
    console.error('[activationRoutes] failed to resolve default orgId for partner', partnerId, err);
    return null;
  }
}

export function mountActivationRoutes(app: Hono): void {
  app.get('/activate/:token', async (c) => {
    const raw = c.req.param('token');
    const tokenHash = createHash('sha256').update(raw).digest('hex');

    const rl = await rateLimiter(getRedis(), `mcp:activate:token:${tokenHash}`, 10, 3600);
    if (!rl.allowed) return c.text('Too many attempts', 429);

    const [row] = await db
      .select()
      .from(partnerActivations)
      .where(eq(partnerActivations.tokenHash, tokenHash))
      .limit(1);
    if (!row) return c.text('Invalid activation link', 404);
    if (row.consumedAt) return c.text('This link has already been used.', 410);
    if (row.expiresAt < new Date()) {
      return c.text('This link has expired. Ask your agent to call create_tenant again.', 410);
    }

    await db.transaction(async (tx) => {
      await tx
        .update(partnerActivations)
        .set({ consumedAt: new Date() })
        .where(eq(partnerActivations.id, row.id));
      await tx
        .update(partners)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(partners.id, row.partnerId));
      // Mark the admin user active so they can log in via the web app.
      // (users table has no `emailVerified` column; moving status from
      // 'invited' to 'active' is the closest analog.)
      const [adminLink] = await tx
        .select({ userId: partnerUsers.userId })
        .from(partnerUsers)
        .where(eq(partnerUsers.partnerId, row.partnerId))
        .limit(1);
      if (adminLink) {
        await tx
          .update(users)
          .set({ status: 'active' })
          .where(eq(users.id, adminLink.userId));
      }
    });

    const activationOrgId = await resolveDefaultOrgId(row.partnerId);
    writeAuditEvent({ req: { header: () => undefined } }, {
      orgId: activationOrgId,
      actorType: 'system',
      action: 'partner.activation_completed',
      resourceType: 'partner',
      resourceId: row.partnerId,
      result: 'success',
    });
    recordActivationTransition('pending_payment');

    return c.redirect(`/activate/${raw}?status=email_verified`);
  });

  app.post('/activate/setup-intent', async (c) => {
    let body: { token?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const token = body.token;
    if (!token || typeof token !== 'string') {
      return c.json({ error: 'missing_token' }, 400);
    }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const [row] = await db
      .select()
      .from(partnerActivations)
      .where(eq(partnerActivations.tokenHash, tokenHash))
      .limit(1);
    if (!row || !row.consumedAt) {
      return c.json({ error: 'invalid_state' }, 400);
    }

    const billing = getBreezeBillingClient();
    const returnUrl = `${process.env.PUBLIC_ACTIVATION_BASE_URL ?? ''}/activate/complete`;
    const { setupUrl, customerId } = await billing.createSetupIntent({
      partnerId: row.partnerId,
      returnUrl,
    });
    await db
      .update(partners)
      .set({ stripeCustomerId: customerId })
      .where(eq(partners.id, row.partnerId));

    return c.json({ setup_url: setupUrl });
  });

  app.post('/activate/complete/webhook', async (c) => {
    const sig = c.req.header('stripe-signature');
    if (!sig) return c.text('missing signature', 400);

    const secretKey = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secretKey || !webhookSecret) {
      return c.text('stripe not configured', 500);
    }
    // Cast the pinned apiVersion literal: Stripe's published types drift frequently
    // and the SDK validates at runtime anyway.
    const stripe = new Stripe(secretKey, { apiVersion: '2024-06-20' as never });
    const rawBody = await c.req.text();

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.text(`bad signature: ${message}`, 400);
    }

    if (event.type !== 'setup_intent.succeeded') {
      // No-op for other event types.
      return c.text('ok');
    }

    const si = event.data.object as Stripe.SetupIntent;
    const customerId = typeof si.customer === 'string' ? si.customer : si.customer?.id ?? null;
    if (!customerId) return c.text('no customer', 400);

    const [partner] = await db
      .select({ id: partners.id })
      .from(partners)
      .where(eq(partners.stripeCustomerId, customerId))
      .limit(1);
    if (!partner) return c.text('unknown customer', 404);

    await db.transaction(async (tx) => {
      await tx
        .update(partners)
        .set({ paymentMethodAttachedAt: new Date() })
        .where(eq(partners.id, partner.id));
      // Upgrade all readonly MCP-provisioning keys scoped to any org under this
      // partner. The apiKeys.orgId is an organization id, so we join through
      // the organizations table to scope by partner.
      const orgIds = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.partnerId, partner.id));
      if (orgIds.length > 0) {
        await tx
          .update(apiKeys)
          .set({ scopeState: 'full' })
          .where(
            and(
              inArray(
                apiKeys.orgId,
                orgIds.map((o) => o.id),
              ),
              eq(apiKeys.scopeState, 'readonly'),
            ),
          );
      }
    });

    const paymentOrgId = await resolveDefaultOrgId(partner.id);
    writeAuditEvent({ req: { header: () => undefined } }, {
      orgId: paymentOrgId,
      actorType: 'system',
      action: 'partner.payment_method_attached',
      resourceType: 'partner',
      resourceId: partner.id,
      result: 'success',
    });
    recordActivationTransition('active');

    return c.text('ok');
  });

  // ============================================
  // Test-mode hooks (MCP_BOOTSTRAP_TEST_MODE)
  // ============================================
  // These routes mirror the side-effects of a real email click and a real
  // Stripe setup_intent.succeeded webhook so YAML E2E tests can drive the
  // activation state machine without running a mail server or signing a
  // Stripe payload. Mounted only when the flag is on; otherwise the routes
  // simply don't exist (Hono returns 404).
  if (process.env.MCP_BOOTSTRAP_TEST_MODE === 'true') {
    app.post('/test/activate/:partnerId', async (c) => {
      const partnerId = c.req.param('partnerId');
      await db.transaction(async (tx) => {
        await tx
          .update(partners)
          .set({ emailVerifiedAt: new Date() })
          .where(eq(partners.id, partnerId));
        await tx
          .update(partnerActivations)
          .set({ consumedAt: new Date() })
          .where(
            and(
              eq(partnerActivations.partnerId, partnerId),
              isNull(partnerActivations.consumedAt),
            ),
          );
        const [link] = await tx
          .select({ userId: partnerUsers.userId })
          .from(partnerUsers)
          .where(eq(partnerUsers.partnerId, partnerId))
          .limit(1);
        if (link) {
          await tx
            .update(users)
            .set({ status: 'active' })
            .where(eq(users.id, link.userId));
        }
      });
      return c.json({ ok: true });
    });

    app.post('/test/complete-payment/:partnerId', async (c) => {
      const partnerId = c.req.param('partnerId');
      await db.transaction(async (tx) => {
        await tx
          .update(partners)
          .set({ paymentMethodAttachedAt: new Date() })
          .where(eq(partners.id, partnerId));
        const orgs = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, partnerId));
        if (orgs.length > 0) {
          await tx
            .update(apiKeys)
            .set({ scopeState: 'full' })
            .where(
              and(
                inArray(
                  apiKeys.orgId,
                  orgs.map((o) => o.id),
                ),
                eq(apiKeys.scopeState, 'readonly'),
              ),
            );
        }
      });
      return c.json({ ok: true });
    });
  }
}
