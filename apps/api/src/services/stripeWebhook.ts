// apps/api/src/services/stripeWebhook.ts
import type Stripe from 'stripe';
import { getStripe } from './stripeClient';
import { getConfig } from '../config/validate';

export function verifyStripeEvent(rawBody: string, signatureHeader: string): Stripe.Event {
  const secret = getConfig().STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  // constructEvent enforces the t=/v1= scheme + 5-min replay tolerance.
  return getStripe().webhooks.constructEvent(rawBody, signatureHeader, secret);
}

// Dispatch stub — real event handling is implemented in Task 12. The route
// skeleton imports this so it can compile; until Task 12 lands it is a no-op.
export async function handleStripeEvent(_event: Stripe.Event): Promise<void> {
  // intentionally empty (Task 12)
}
