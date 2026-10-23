/**
 * The one seam between Wisp grants and the Partner Entitlements mechanism
 * (Wisp W01, `services/entitlements.ts`, built in parallel with W02).
 *
 * The API is bundled by tsup, so a lazy `import('../entitlements')` cannot be
 * made safe before that module exists: a literal specifier fails the build, a
 * computed one never resolves inside dist/. Until W01 lands this returns null,
 * which grants.ts reads as "no cap" (w00 A21: null limits ⇒ no cap).
 *
 * TODO(W01/W04): replace the body with
 *   `return (await import('../entitlements')).getEntitlementLimits(partnerId, 'wisp');`
 * once services/entitlements.ts is on main — W04 is the first consumer of
 * requireEntitlement('wisp') and owns wiring it if W01 did not.
 */
export async function loadWispEntitlementLimits(_partnerId: string): Promise<unknown | null> {
  return null;
}
