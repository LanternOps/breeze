/**
 * Network Proxy dedicated tunnel origin (#8155): the per-partner opt-in.
 *
 * Partner settings key: `settings.networkProxy.dedicatedTunnelOrigin`. Shared
 * so the API resolver (apps/api/src/services/tunnelOriginOptIn.ts) and the
 * Partner Settings → Remote Access toggle agree on what an unset value means.
 */

/**
 * Whether a partner's Network Proxy sessions use the dedicated tunnel origin
 * when the region offers one (TUNNEL_ORIGIN_TEMPLATE) and the partner has not
 * chosen. Flips to `true` only after the tunnel domain's Public Suffix List
 * inclusion is verified in shipped browsers (plan W04 Task 19); until then it
 * is opt-in per partner. An unset value must stay unset on save so the flip
 * reaches partners who never chose.
 */
export const TUNNEL_ORIGIN_PARTNER_DEFAULT = false;

export function tunnelOriginOptInFromSettings(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return TUNNEL_ORIGIN_PARTNER_DEFAULT;
  const networkProxy = (settings as Record<string, unknown>).networkProxy;
  if (!networkProxy || typeof networkProxy !== 'object') return TUNNEL_ORIGIN_PARTNER_DEFAULT;
  const value = (networkProxy as Record<string, unknown>).dedicatedTunnelOrigin;
  return typeof value === 'boolean' ? value : TUNNEL_ORIGIN_PARTNER_DEFAULT;
}
