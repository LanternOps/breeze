/**
 * Network Proxy `http_request` command ids: `http-req-<tunnelId>-<uuid>`.
 *
 * Dependency-free on purpose: the dispatcher (routes/tunnelHttpCore.ts) mints
 * these ids and agentAuthMiddleware recognises an older agent's REST
 * acknowledgement of one (#11464, services/agentTunnelResultRateLimit.ts), so
 * both read the prefix from here and cannot drift apart.
 */
export const TUNNEL_HTTP_COMMAND_ID_PREFIX = 'http-req-';

export function tunnelHttpCommandPrefix(tunnelId: string): string {
  return `${TUNNEL_HTTP_COMMAND_ID_PREFIX}${tunnelId}-`;
}

export function isTunnelHttpCommandId(commandId: string): boolean {
  return commandId.startsWith(TUNNEL_HTTP_COMMAND_ID_PREFIX);
}
