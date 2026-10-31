import { agentSupportsNetworkIsolation } from '@breeze/shared';
import { devices } from '../../db/schema';
type Device = typeof devices.$inferSelect;
export type IsolationStartRefusal =
  | 'feature_disabled' | 'agent_unsupported' | 'unsupported_platform' | 'trust_restricted'
  | 'isolation_already_active' | 'isolation_unacknowledged' | 'incident_mismatch' | 'site_forbidden';

/** Start-only gates. Recovery, release, extension and code viewing never call this. */
export function isolationStartGate(device: Pick<Device, 'agentVersion' | 'networkIsolationVersion' | 'networkIsolationReady' | 'osType' | 'status'>, partnerId: string | null, env = process.env): IsolationStartRefusal | null {
  const enabledPartners = env.NETWORK_ISOLATION_ENABLED_PARTNER_IDS?.trim();
  if (env.NETWORK_ISOLATION_ENABLED !== 'true' || (enabledPartners && !enabledPartners.split(',').map(id => id.trim().toLowerCase()).includes(partnerId?.toLowerCase() ?? ''))) return 'feature_disabled';
  if (!['windows', 'linux', 'macos'].includes(device.osType)) return 'unsupported_platform';
  if (!agentSupportsNetworkIsolation(device.agentVersion, device.networkIsolationVersion) || !device.networkIsolationReady || ['quarantined', 'decommissioned', 'removed'].includes(device.status)) return 'agent_unsupported';
  return null;
}
