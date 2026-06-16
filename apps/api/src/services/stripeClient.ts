import Stripe from 'stripe';
import { getConfig } from '../config/validate';

export class StripeNotConfiguredError extends Error {
  constructor() {
    super('Stripe is not configured (STRIPE_SECRET_KEY missing)');
    this.name = 'StripeNotConfiguredError';
  }
}

let cached: Stripe | null = null;

/** Platform-level Stripe client. Acts on a connected account via `getConnectedStripeOptions`. */
export function getStripe(): Stripe {
  const key = getConfig().STRIPE_SECRET_KEY;
  if (!key) throw new StripeNotConfiguredError();
  // API version explicitly pinned (do not rely on the SDK default, which moves on upgrade).
  if (!cached) cached = new Stripe(key, { apiVersion: '2026-03-25.dahlia' });
  return cached;
}

/** Request options that scope a call to the MSP's connected account (direct charges). */
export function getConnectedStripeOptions(stripeAccountId: string): Stripe.RequestOptions {
  return { stripeAccount: stripeAccountId };
}

export function isStripeConfigured(): boolean {
  return Boolean(getConfig().STRIPE_SECRET_KEY);
}
