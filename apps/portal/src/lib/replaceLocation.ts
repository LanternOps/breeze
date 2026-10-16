/**
 * Full-page `location.replace` to an absolute URL (a Stripe-hosted checkout, a
 * durable public invoice page). replace, not assign: Back must not return to a
 * spent single-use form. A module seam so components can be tested — jsdom's
 * window.location cannot be stubbed.
 */
export function replaceLocation(url: string): void {
  window.location.replace(url);
}
