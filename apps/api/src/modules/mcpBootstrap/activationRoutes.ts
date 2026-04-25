import type { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import Stripe from 'stripe';
import { db, withSystemDbAccessContext } from '../../db';
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
import { getTrustedClientIp } from '../../services/clientIp';
import { recordActivationTransition } from './metrics';
import { tombstoneBootstrapSecret } from './bootstrapSecret';

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

    return withSystemDbAccessContext(async () => {
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

      // Strip the raw token from the redirect URL — even though it's
      // single-use, embedding it in the post-activation URL leaves it in
      // browser history, corporate proxy logs, and referrer headers.
      return c.redirect(`/activate/complete?partner=${row.partnerId}&status=email_verified`);
    });
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
    return withSystemDbAccessContext(async () => {
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
      // Log the real error server-side with source IP for forensics; return
      // a bare message to the caller so we don't leak internals.
      const message = err instanceof Error ? err.message : String(err);
      const sourceIp = getTrustedClientIp(c, 'unknown');
      console.error(
        '[stripe-webhook] signature verification failed',
        { error: message, sourceIp },
      );
      return c.text('bad signature', 400);
    }

    // Handle setup_intent.setup_failed: audit + metric; no state change.
    if (event.type === 'setup_intent.setup_failed') {
      const si = event.data.object as Stripe.SetupIntent;
      const customerId =
        typeof si.customer === 'string' ? si.customer : si.customer?.id ?? null;
      if (!customerId) {
        console.warn('[stripe-webhook] setup_failed event with no customer', {
          eventId: event.id,
        });
        return c.text('ok');
      }
      return withSystemDbAccessContext(async () => {
        const [partner] = await db
          .select({ id: partners.id })
          .from(partners)
          .where(eq(partners.stripeCustomerId, customerId))
          .limit(1);
        if (!partner) {
          console.warn('[stripe-webhook] setup_failed for unknown customer', {
            customerId,
            eventId: event.id,
          });
          return c.text('ok');
        }
        const failOrgId = await resolveDefaultOrgId(partner.id);
        writeAuditEvent({ req: { header: () => undefined } }, {
          orgId: failOrgId,
          actorType: 'system',
          action: 'partner.payment_method_failed',
          resourceType: 'partner',
          resourceId: partner.id,
          result: 'failure',
          details: {
            stripe_error: si.last_setup_error?.message ?? null,
            event_id: event.id,
          },
        });
        recordActivationTransition('payment_failed');
        return c.text('ok');
      });
    }

    // Handle setup_intent.canceled: audit only, keep partner pending_payment.
    if (event.type === 'setup_intent.canceled') {
      const si = event.data.object as Stripe.SetupIntent;
      const customerId =
        typeof si.customer === 'string' ? si.customer : si.customer?.id ?? null;
      if (!customerId) return c.text('ok');
      return withSystemDbAccessContext(async () => {
        const [partner] = await db
          .select({ id: partners.id })
          .from(partners)
          .where(eq(partners.stripeCustomerId, customerId))
          .limit(1);
        if (!partner) {
          console.warn('[stripe-webhook] canceled for unknown customer', {
            customerId,
            eventId: event.id,
          });
          return c.text('ok');
        }
        const cancelOrgId = await resolveDefaultOrgId(partner.id);
        writeAuditEvent({ req: { header: () => undefined } }, {
          orgId: cancelOrgId,
          actorType: 'system',
          action: 'partner.payment_method_canceled',
          resourceType: 'partner',
          resourceId: partner.id,
          result: 'failure',
          details: { event_id: event.id },
        });
        return c.text('ok');
      });
    }

    if (event.type !== 'setup_intent.succeeded') {
      // Routing issue — Stripe was configured to send an event we don't
      // handle. Log at warn (not error) and ack so Stripe doesn't retry.
      console.warn('[stripe-webhook] unhandled event type', {
        eventType: event.type,
        eventId: event.id,
      });
      return c.text('ok');
    }

    const si = event.data.object as Stripe.SetupIntent;
    const customerId = typeof si.customer === 'string' ? si.customer : si.customer?.id ?? null;
    if (!customerId) return c.text('no customer', 400);

    return withSystemDbAccessContext(async () => {
      const [partner] = await db
        .select({ id: partners.id })
        .from(partners)
        .where(eq(partners.stripeCustomerId, customerId))
        .limit(1);
      if (!partner) {
        // Unreachable in normal operation — every SetupIntent we create has
        // a customer that was written into partners.stripe_customer_id. Log
        // at error level so we get alerted.
        console.error(
          '[stripe-webhook] setup_intent.succeeded for unknown customer',
          { customerId, eventId: event.id },
        );
        return c.text('unknown customer', 404);
      }

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

      // Tombstone the MCP bootstrap secret now that the partner is fully
      // activated. After this point bootstrap tools must reject calls — even
      // a leaked secret (chat history, log scrape) cannot be replayed to
      // re-take the tenant via attach_payment_method.
      await tombstoneBootstrapSecret(partner.id);

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
      return withSystemDbAccessContext(async () => {
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
    });

    app.post('/test/complete-payment/:partnerId', async (c) => {
      const partnerId = c.req.param('partnerId');
      return withSystemDbAccessContext(async () => {
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
        // Mirror the production webhook: tombstone the bootstrap secret on
        // activation so E2E tests exercise the same post-active state.
        await tombstoneBootstrapSecret(partnerId);
        return c.json({ ok: true });
      });
    });
  }
}
