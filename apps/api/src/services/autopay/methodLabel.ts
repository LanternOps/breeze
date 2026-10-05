import type Stripe from 'stripe';
import { formatPaymentMethod } from '@breeze/shared';
/** Client-facing label for a live Stripe PaymentMethod (setup return, enrolled email). */
export function formatStripePaymentMethod(method: Pick<Stripe.PaymentMethod, 'type' | 'card' | 'us_bank_account'>,
  style: 'long' | 'short' = 'long'): string {
  return formatPaymentMethod({ type: method.type, cardBrand: method.card?.brand, cardFunding: method.card?.funding,
    cardLast4: method.card?.last4, bankLast4: method.us_bank_account?.last4 }, style);
}
