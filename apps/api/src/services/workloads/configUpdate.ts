import type { WorkloadInventoryInlineSettings } from '@breeze/shared';
import type { DeviceHierarchyOpts } from '../deviceHierarchy';
import { getDeviceWorkloadInventorySettings } from './settings';

/** Wire payload for `configUpdate.workload_inventory_settings` (spec §7.2). */
export interface WorkloadInventoryConfigUpdate {
  enabled: boolean;
  docker_enabled: boolean;
  podman_enabled: boolean;
  hyperv_enabled: boolean;
  proxmox_enabled: boolean;
  interval_minutes: number;
  /**
   * #9067: this server's ingest schema accepts `imageProvenance`. Not a
   * setting: the schema is strict, so a server that predates the field rejects
   * the whole report if the key is present, and the agent sends it only when
   * this is true. Agents that predate it ignore the key.
   */
  accepts_image_provenance: true;
}

export function toWorkloadInventoryConfigUpdate(
  settings: WorkloadInventoryInlineSettings,
): WorkloadInventoryConfigUpdate {
  return {
    enabled: settings.enabled,
    docker_enabled: settings.dockerEnabled,
    podman_enabled: settings.podmanEnabled,
    hyperv_enabled: settings.hypervEnabled,
    proxmox_enabled: settings.proxmoxEnabled,
    interval_minutes: settings.intervalMinutes,
    accepts_image_provenance: true,
  };
}

/**
 * Resolves the device's effective settings into the agent wire payload.
 * Defaults (enabled: false) are returned when no policy applies. Throws on any
 * resolver error — the heartbeat omits the key rather than send defaults that
 * could switch a running collection off.
 */
export async function buildResolvedWorkloadInventoryConfigUpdate(
  deviceId: string,
  opts?: DeviceHierarchyOpts,
): Promise<WorkloadInventoryConfigUpdate> {
  const { settings } = await getDeviceWorkloadInventorySettings(deviceId, opts);
  return toWorkloadInventoryConfigUpdate(settings);
}
