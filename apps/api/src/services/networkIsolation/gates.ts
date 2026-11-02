import { agentSupportsNetworkIsolation, type IsolationStartRefusal } from '@breeze/shared';
import { devices } from '../../db/schema';
type Device = typeof devices.$inferSelect;
export type { IsolationStartRefusal } from '@breeze/shared';

/** Start-only gates. Recovery, release, extension and code viewing never call this. */
export function isolationStartGate(device: Pick<Device, 'agentVersion' | 'networkIsolationVersion' | 'networkIsolationReady' | 'osType' | 'status'>, partnerId: string | null, env = process.env): IsolationStartRefusal | null {
  const enabledPartners = env.NETWORK_ISOLATION_ENABLED_PARTNER_IDS?.trim();
  if (env.NETWORK_ISOLATION_ENABLED !== 'true') return 'feature_disabled';
  if (enabledPartners && !enabledPartners.split(',').map(id => id.trim().toLowerCase()).includes(partnerId?.toLowerCase() ?? '')) return 'partner_not_enabled';
  if (!['windows', 'linux', 'macos'].includes(device.osType)) return 'unsupported_platform';
  if (['quarantined', 'decommissioned', 'removed'].includes(device.status)) return 'device_lifecycle';
  if (!agentSupportsNetworkIsolation(device.agentVersion, device.networkIsolationVersion)) return 'agent_below_gate';
  if (!device.networkIsolationReady) return 'agent_not_ready';
  return null;
}
