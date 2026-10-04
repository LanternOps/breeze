/**
 * Marker carried by middleware that enforces a permission grant (a role
 * permission, a platform-admin check, or a credential's scoped capability).
 *
 * It changes no behaviour. `writeRoutePermissionGate.contract.test.ts` walks
 * every mounted write route's handler chain and looks for it, so a
 * state-changing route cannot ship behind authentication alone.
 *
 * Kept dependency-free on purpose: route tests commonly `vi.mock` the auth
 * middleware module, and gates defined elsewhere must still be able to tag
 * themselves at import time.
 */
export const PERMISSION_GATE = Symbol.for('breeze.permissionGate');

/** Tag a middleware as a permission gate; `label` names the grant it enforces. */
export function markPermissionGate<T extends (...args: never[]) => unknown>(middleware: T, label: string): T {
  Object.defineProperty(middleware, PERMISSION_GATE, { value: label });
  return middleware;
}

/** The grant a permission-gate middleware enforces, or undefined if it is not one. */
export function permissionGateLabel(middleware: unknown): string | undefined {
  if (typeof middleware !== 'function') return undefined;
  return (middleware as unknown as Record<symbol, string | undefined>)[PERMISSION_GATE];
}
