import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { partners } from '../../../db/schema';
import { getBreezeBillingClient } from '../../../services/breezeBillingClient';
import type { BootstrapTool } from '../types';
import { BootstrapError } from '../types';

const inputSchema = z.object({ tenant_id: z.string().uuid() });

type AttachOutput = { setup_url: string | null; already_attached: boolean };

export const attachPaymentMethodTool: BootstrapTool<z.infer<typeof inputSchema>, AttachOutput> = {
  definition: {
    name: 'attach_payment_method',
    description: [
      'Return a Stripe Checkout URL (mode=setup) where the admin can attach a payment method for identity verification. No charge; this is KYC that unlocks tenant mutations.',
      'Flow: (1) the user opens the returned setup_url in a browser, (2) completes the Stripe flow, (3) the agent resumes polling verify_tenant until it returns { status: "active" }.',
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
    const { setupUrl, customerId } = await billing.createSetupIntent({
      partnerId: partner.id,
      returnUrl: `${base}/activate/complete?partner=${partner.id}`,
    });

    await db
      .update(partners)
      .set({ stripeCustomerId: customerId })
      .where(eq(partners.id, partner.id));

    return { setup_url: setupUrl, already_attached: false };
  },
};
