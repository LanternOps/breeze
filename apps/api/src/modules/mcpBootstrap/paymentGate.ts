import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { partners } from '../../db/schema';

/**
 * Thrown by the `requirePaymentMethod` decorator when a bootstrap tool is
 * invoked against a partner that has not yet completed the Stripe
 * identity-verification setup flow.
 *
 * Error shape mirrors the readonly-scope backstop in `routes/mcpServer.ts`
 * (`code: 'PAYMENT_REQUIRED'` + `remediation` pointing at
 * `attach_payment_method`) so both enforcement layers surface identically to
 * the calling agent.
 */
export class PaymentRequiredError extends Error {
  code = 'PAYMENT_REQUIRED' as const;
  remediation: { tool: string; args: { tenant_id: string } };

  constructor(public partnerId: string) {
    super(
      'This action requires a payment method on file (identity verification, no charge for free tier).',
    );
    this.name = 'PaymentRequiredError';
    this.remediation = {
      tool: 'attach_payment_method',
      args: { tenant_id: partnerId },
    };
  }
}

/**
 * Decorator that wraps a tool handler and rejects with `PaymentRequiredError`
 * when the calling partner has no `payment_method_attached_at` timestamp.
 *
 * Primary enforcement for tier-2+ bootstrap mutations (e.g.
 * `send_deployment_invites`, `configure_defaults`). The readonly-scope
 * backstop in `mcpServer.ts` provides defense-in-depth.
 */
export function requirePaymentMethod<I, O>(
  handler: (input: I, ctx: any) => Promise<O>,
): (input: I, ctx: any) => Promise<O> {
  return async (input, ctx) => {
    const partnerId: string | undefined = ctx?.apiKey?.partnerId;
    if (!partnerId) {
      throw new Error(
        'requirePaymentMethod: no apiKey.partnerId in context — decorator must run after authentication',
      );
    }
    const [row] = await db
      .select({ paid: partners.paymentMethodAttachedAt })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1);
    if (!row?.paid) {
      throw new PaymentRequiredError(partnerId);
    }
    return handler(input, ctx);
  };
}
