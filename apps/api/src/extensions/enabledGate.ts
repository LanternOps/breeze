/**
 * The per-request ENABLED gate for runtime extensions.
 *
 * `installed_extensions.enabled` is the administrative on/off switch. The gate
 * is consulted on EVERY dispatched extension request (see gateway.ts) with NO
 * caching: an operator disabling an extension on one replica must take effect on
 * the next request across the whole fleet, so a flip of the flag is honored
 * immediately rather than at some cache-expiry horizon.
 *
 * The store's `isEnabled` already runs its read under `withSystemDbAccessContext`
 * (installed_extensions is a system-only FORCE-RLS table), so the gate must NOT
 * double-wrap. One store instance is created and closed over — never one per
 * request.
 */
import { createExtensionStateStore, type ExtensionStateStore } from './stateStore';

/** The subset of the state store the gate depends on (injectable for tests). */
export type EnabledGateStore = Pick<ExtensionStateStore, 'isEnabled'>;

/**
 * Build the `isEnabled(name)` callback that {@link mountExtensionGateway}
 * consumes. Defaults to the shared Drizzle-backed system-scoped store; tests
 * inject a fake store.
 */
export function createEnabledGate(
  store: EnabledGateStore = createExtensionStateStore(),
): (name: string) => Promise<boolean> {
  return (name: string) => store.isEnabled(name);
}
