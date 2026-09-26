import { ensureDiscoveryTopologyAuthority } from './discoveryDispatch';
import { ensureUnifiTopologyAuthority } from './unifiAuthority';
import { ensureUnifiTelemetryAuthority } from './unifiInterfaceMetrics';

/**
 * Installs the server-owned physical producer authorities (M2 D1): discovery
 * target authority (dispatch snapshots, D7) and UniFi controller-site authority
 * (collector + exact site mapping, D16). `collectionAuthority` is default-deny —
 * an unregistered kind rejects every report with `producer_authority_unavailable`
 * — so every process that ingests physical reports must call this at boot:
 * the API bootstrap and the topology reconcile worker's initializer. The ingest
 * entry points (adjacency route, UniFi adapter) call it too, so a code path
 * reached before boot still fails closed only when registration itself fails.
 * Idempotent.
 */
export function registerTopologyPhysicalAuthorities(): void {
  ensureDiscoveryTopologyAuthority();
  ensureUnifiTopologyAuthority();
  // M3 Task 4: UniFi port link-state telemetry shares the controller-site authority.
  ensureUnifiTelemetryAuthority();
}
