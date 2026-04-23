import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { partners } from '../../../db/schema';
import { BillingError, getBreezeBillingClient } from '../../../services/breezeBillingClient';
import type { BootstrapTool } from '../types';
import { BootstrapError } from '../types';

const inputSchema = z.object({ tenant_id: z.string().uuid() });

type AttachOutput = { setup_url: string | null; already_attached: boolean };

export const attachPaymentMethodTool: BootstrapTool<z.infer<typeof inputSchema>, AttachOutput> = {
  definition: {
    name: 'attach_payment_method',
    description: [
      'Return a Stripe Checkout URL (mode=setup) where the admin can attach a payment method for identity verification. No charge; this is KYC that unlocks tenant mutations.',
      'Flow: (1) the user opens the returned setup_url in a browser, (2) completes the Stripe flow, (3) the agent resumes polling verify_tenant until it returns { status: "active" }. When status flips to active, follow `next_steps` from verify_tenant — that returns the OAuth connector setup instructions for Claude.ai/ChatGPT/Cursor.',
      'Idempotent: if a payment method is already attached, returns { setup_url: null, already_attached: true } without calling the billing service.',
      'Call this whenever a mutating tool returns PAYMENT_REQUIRED, or proactively after verify_tenant returns { status: "pending_payment" }.',
    ].join(' '),
    inputSchema,
  },
  handler: async (input): Promise<AttachOutput> => {
    const [partner] = await db
      .select({
        id: partners.id,
        emailVerifiedAt: partners.emailVerifiedAt,
        paymentMethodAttachedAt: partners.paymentMethodAttachedAt,
      })
      .from(partners)
      .where(eq(partners.id, input.tenant_id))
      .limit(1);

    if (!partner) throw new BootstrapError('UNKNOWN_TENANT', 'Tenant not found.');
    if (!partner.emailVerifiedAt) {
      throw new BootstrapError(
        'EMAIL_NOT_VERIFIED',
        'Call verify_tenant until status is pending_payment before calling attach_payment_method.',
      );
    }
    if (partner.paymentMethodAttachedAt) {
      return { setup_url: null, already_attached: true };
    }

    const base = process.env.PUBLIC_ACTIVATION_BASE_URL;
    if (!base) throw new Error('PUBLIC_ACTIVATION_BASE_URL not configured.');

    const billing = getBreezeBillingClient();

    let setupUrl: string;
    let customerId: string;
    try {
      const res = await billing.createSetupIntent({
        partnerId: partner.id,
        returnUrl: `${base}/activate/complete?partner=${partner.id}`,
      });
      setupUrl = res.setupUrl;
      customerId = res.customerId;
    } catch (err) {
      if (err instanceof BillingError) {
        throw new BootstrapError('BILLING_UNAVAILABLE', err.message, {
          retryAfter: '30s',
        });
      }
      // Network/TypeError or anything else: billing is effectively down.
      const msg = err instanceof Error ? err.message : String(err);
      throw new BootstrapError(
        'BILLING_UNAVAILABLE',
        `Billing service unreachable: ${msg}`,
        { retryAfter: '30s' },
      );
    }

    // If the subsequent update fails, the Stripe Customer has been created
    // but isn't linked to the partner row. The agent's next call will land
    // on billing's idempotency path (customers.search on partner metadata)
    // and reuse the existing Customer — so no orphan is created — but we
    // surface the failure loudly rather than silently returning success.
    try {
      await db
        .update(partners)
        .set({ stripeCustomerId: customerId })
        .where(eq(partners.id, partner.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        '[attach_payment_method] Failed to persist stripeCustomerId after SetupIntent creation',
        { partnerId: partner.id, customerId, error: msg },
      );
      throw new BootstrapError(
        'PARTIAL_BILLING_STATE',
        `SetupIntent created but failed to link customer to partner: ${msg}. Retry attach_payment_method — the billing side is idempotent.`,
        { retryAfter: '5s' },
      );
    }

    return { setup_url: setupUrl, already_attached: false };
  },
};
