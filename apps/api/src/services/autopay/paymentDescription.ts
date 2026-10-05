/** Human-readable PaymentIntent description for the MSP's Stripe dashboard ("Invoice INV-7 ·
 * Example MSP"), for autopay, bank pay and pay-link Checkout alike (FP-20). No statement
 * descriptor suffix is set: on a connected account it joins that account's own prefix under a
 * 22-character limit we cannot see, and a rejected create would block collection. */
export function paymentIntentDescription(invoiceNumber: string | null, partnerName: string | null): string {
  const text = [`Invoice${invoiceNumber ? ` ${invoiceNumber}` : ''}`, partnerName?.replace(/\s+/g, ' ').trim()].filter(Boolean).join(' · ');
  return Array.from(text).slice(0, 500).join('');
}
