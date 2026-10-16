import type { EdrProviderAdapter } from './types';

/**
 * `edr_connections.capabilities_snapshot` (spec §4.2): the adapter's capability keys at the last
 * SUCCESSFUL connection test, plus that test's key-specific degradation notes (e.g. a GravityZone
 * key without the Quarantine API) as `note:<text>`. Lets the UI render the card without an adapter
 * round trip and records drift. Written only where a test runs (create, credential PATCH,
 * POST /test) — the sync job does not overwrite it, or the notes would be lost every run.
 */
export function capabilitySnapshot(adapter: EdrProviderAdapter, notes: readonly string[]): string[] {
  const c = adapter.capabilities;
  return [
    `tenants:${c.tenantModel}`,
    `detections:${c.detectionDelivery}`,
    `installer:${c.installer}`,
    ...c.actions.map((a) => `action:${a}`),
    ...notes.map((n) => `note:${n}`),
  ];
}
