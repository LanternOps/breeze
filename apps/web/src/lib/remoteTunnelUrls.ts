export function buildRemoteVncPageUrl(tunnelId: string): string {
  return `/remote/vnc/${encodeURIComponent(tunnelId)}`;
}

export function buildRemoteProxyPageUrl(tunnelId: string, target: string, assetId?: string): string {
  const params: string[] = [];
  if (target) params.push(`target=${encodeURIComponent(target)}`);
  // Carried so ProxyTunnelPage's Back link can return to the originating
  // network device page instead of the generic /remote hub.
  if (assetId) params.push(`asset=${encodeURIComponent(assetId)}`);
  const query = params.length > 0 ? `?${params.join('&')}` : '';
  return `/remote/proxy/${encodeURIComponent(tunnelId)}${query}`;
}
