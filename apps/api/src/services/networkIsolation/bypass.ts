/** Generic command and MCP paths cannot own isolation episodes or release them. */
export const USE_NETWORK_ISOLATION_ROUTES = 'use_network_isolation_routes';

export function isNetworkIsolationCommand(type: string, payload: unknown): boolean {
  return type === 'release_containment' || (
    type === 'execute_containment' && payload !== null && typeof payload === 'object' &&
    !Array.isArray(payload) && (payload as Record<string, unknown>).actionType === 'network_isolation'
  );
}
