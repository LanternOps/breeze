export function buildRemoteVncPageUrl(tunnelId: string): string {
  return `/remote/vnc/${encodeURIComponent(tunnelId)}`;
}

export function buildRemoteProxyPageUrl(tunnelId: string, target: string): string {
  const targetQuery = target ? `?target=${encodeURIComponent(target)}` : '';
  return `/remote/proxy/${encodeURIComponent(tunnelId)}${targetQuery}`;
}
